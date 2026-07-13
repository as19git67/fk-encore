/**
 * Transaction endpoints — list / detail / manual booking / tag
 * promotion / batch tagging.
 *
 * Permission model:
 *   - `finance.view` is the module-level read permission.
 *   - On top of that, every transaction access is filtered through
 *     the per-account ACL (`finance_account_access`). `finance.admin`
 *     bypasses the ACL.
 *   - Manual bookings additionally require `level='write'` on the
 *     target account.
 *
 * Dedupe: SHA-256 over booking_date | value_date | amount | currency
 * | purpose | counterparty_iban (see finance-data-model.md §3). The
 * unique index (account_id, dedupe_hash) catches accidental reposts
 * from both the importer and the manual-booking UI.
 *
 * The AI-tag suggestion pipeline joins the insert path in Etappe 5B
 * (`tag-suggester.ts`). For now, manual bookings persist whatever
 * user-tags the caller supplied and do nothing else.
 */

import { createHash } from "node:crypto";
import { createTransactionReportPdf } from "./pdf-report";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeCurrency,
  financeTag,
  financeTagBlocklist,
  financeTagTransaction,
  financeTransaction,
  financeTransactionDocument,
} from "../db/schema";
import { enqueueTagSuggestion } from "./tag-queue";
import { triggerTagWorker } from "./tag-worker";
import { normalizeCounterparty } from "./tag-suggester";
import { createSuggestionsForTransaction } from "./document-match.service";

console.log("[boot] finance/transactions.ts: all imports resolved");

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

/**
 * Returns the set of accountIds the caller may READ. Admins get
 * `null` (meaning "no filter"); everyone else gets an explicit list
 * — an empty array means "no access at all, produce zero results".
 */
async function readableAccountIds(
  auth: { userID: string; permissions: string[] },
): Promise<number[] | null> {
  if (hasAdmin(auth)) return null;
  const rows = await db
    .select({ id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
  return rows.map((r) => r.id);
}

async function accessibleTransactionIds(
  auth: { userID: string; permissions: string[] },
  requestedIds: number[],
): Promise<{ ids: number[]; skipped: number }> {
  const requested = [...new Set(requestedIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (requested.length === 0) return { ids: [], skipped: 0 };
  const visibleIds = await readableAccountIds(auth);
  const conditions = [inArray(financeTransaction.id, requested)];
  if (visibleIds !== null) {
    if (visibleIds.length === 0) return { ids: [], skipped: requested.length };
    conditions.push(inArray(financeTransaction.account_id, visibleIds));
  }
  const rows = await db
    .select({ id: financeTransaction.id })
    .from(financeTransaction)
    .where(and(...conditions));
  return { ids: rows.map((row) => row.id), skipped: requested.length - rows.length };
}

/**
 * Fast path for single-account access checks: returns the ACL level
 * for the caller, or null when the caller has no entry at all.
 * Admins always return "write".
 */
async function accountAccessLevel(
  auth: { userID: string; permissions: string[] },
  accountId: number,
): Promise<"read" | "write" | null> {
  if (hasAdmin(auth)) return "write";
  const [row] = await db
    .select({ level: financeAccountAccess.level })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.account_id, accountId),
        eq(financeAccountAccess.user_id, Number(auth.userID)),
      ),
    )
    .limit(1);
  return row?.level ?? null;
}

function computeDedupeHash(input: {
  bookingDate: string;
  valueDate: string | null;
  amount: string; // numeric as string to avoid float drift
  currency: string;
  purpose: string | null;
  counterpartyIban: string | null;
  // Free-form note. Included so two otherwise-identical manual bookings
  // (same day / amount / currency) stay distinct when the user tells them
  // apart by their note — cash bookings carry no purpose or IBAN, so the
  // note is the only remaining discriminator. Was previously covered by
  // `purpose` back when the cash form (wrongly) stored notes there.
  notice: string | null;
}): string {
  const canonical = [
    input.bookingDate,
    input.valueDate ?? "",
    input.amount,
    input.currency,
    input.purpose ?? "",
    input.counterpartyIban ?? "",
    input.notice ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function toAmountString(value: number | string): string {
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw APIError.invalidArgument(`amount must be a number, got '${value}'`);
    }
    return n.toFixed(2);
  }
  if (!Number.isFinite(value)) {
    throw APIError.invalidArgument("amount must be a finite number");
  }
  return value.toFixed(2);
}

// -----------------------------------------------------------------------
// DTO shapes
// -----------------------------------------------------------------------

interface TagOnTransaction {
  name: string;
  source: "user" | "ai";
  confidence: number | null;
}

interface TransactionView {
  id: number;
  account_id: number;
  booking_date: string;
  value_date: string | null;
  amount: string;
  currency_code: string;
  purpose: string | null;
  counterparty: string | null;
  counterparty_iban: string | null;
  counterparty_bic: string | null;
  end_to_end_ref: string | null;
  mandate_ref: string | null;
  creditor_id: string | null;
  bank_ref: string | null;
  originator_name: string | null;
  recipient_name: string | null;
  funds_code: string | null;
  transaction_type: string | null;
  transaction_code: string | null;
  entry_text: string | null;
  prima_nota_no: string | null;
  original_amount: string | null;
  original_currency_code: string | null;
  exchange_rate: string | null;
  notice: string | null;
  reviewed_at: string | null;
  is_tax_relevant: boolean;
  tags: TagOnTransaction[];
  created_at: string | null;
}

async function annotateTags(
  transactionIds: number[],
): Promise<Map<number, TagOnTransaction[]>> {
  const byTx = new Map<number, TagOnTransaction[]>();
  if (transactionIds.length === 0) return byTx;

  const joinRows = await db
    .select({
      transaction_id: financeTagTransaction.transaction_id,
      confidence: financeTagTransaction.confidence,
      tag_name: financeTag.name,
      tag_source: financeTag.source,
    })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .where(inArray(financeTagTransaction.transaction_id, transactionIds));

  for (const row of joinRows) {
    const list = byTx.get(row.transaction_id) ?? [];
    list.push({
      name: row.tag_name,
      source: row.tag_source,
      confidence: row.confidence !== null ? Number(row.confidence) : null,
    });
    byTx.set(row.transaction_id, list);
  }
  return byTx;
}

/**
 * Normalises Postgres timestamp string ('YYYY-MM-DD HH:MM:SS') to an
 * ISO date when the time component is zero, leaving ISO-formatted
 * inputs untouched. booking_date is conceptually a date for bank
 * transactions, and the UI shouldn't have to strip the time itself.
 */
function toDateString(s: string | null): string | null {
  if (!s) return s;
  // Either 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS' — trim to date
  return s.slice(0, 10);
}

function toView(
  row: typeof financeTransaction.$inferSelect,
  tags: TagOnTransaction[],
): TransactionView {
  return {
    id: row.id,
    account_id: row.account_id,
    booking_date: toDateString(row.booking_date) ?? row.booking_date,
    value_date: toDateString(row.value_date),
    amount: row.amount,
    currency_code: row.currency_code,
    purpose: row.purpose,
    counterparty: row.counterparty,
    counterparty_iban: row.counterparty_iban,
    counterparty_bic: row.counterparty_bic,
    end_to_end_ref: row.end_to_end_ref,
    mandate_ref: row.mandate_ref,
    creditor_id: row.creditor_id,
    bank_ref: row.bank_ref,
    originator_name: row.originator_name,
    recipient_name: row.recipient_name,
    funds_code: row.funds_code,
    transaction_type: row.transaction_type,
    transaction_code: row.transaction_code,
    entry_text: row.entry_text,
    prima_nota_no: row.prima_nota_no,
    original_amount: row.original_amount,
    original_currency_code: row.original_currency_code,
    exchange_rate: row.exchange_rate,
    notice: row.notice,
    reviewed_at: row.reviewed_at,
    is_tax_relevant: row.is_tax_relevant,
    tags,
    created_at: row.created_at,
  };
}

// -----------------------------------------------------------------------
// List
// -----------------------------------------------------------------------

interface ListParams {
  accountId?: number;
  /** Comma-separated list of account ids — alternative to `accountId`
   *  for the overview "Alle Buchungen" view that pools transactions
   *  across all accounts in a section. Both filters can be supplied
   *  together; the result is the intersection (i.e. accountId must
   *  also appear in accountIdsCsv if both are set). */
  accountIdsCsv?: string;
  /**
   * Free-text search. When the trimmed value parses as a finite
   * number, matches transactions whose amount has the same absolute
   * value (so users can type "12.50" without having to know the
   * sign). Otherwise it does a case-insensitive substring match
   * against counterparty + purpose, joined by OR.
   */
  q?: string;
  /**
   * Comma-separated list of tag names. A transaction matches when at
   * least one of its tags (any source) has a name in the set.
   */
  tagsCsv?: string;
  from?: string; // ISO date
  to?: string;
  limit?: number;
  offset?: number;
}

interface ListResponse {
  items: TransactionView[];
  total: number;
}

export const listTransactions = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions",
    auth: true,
  },
  async (p: ListParams): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const visibleIds = await readableAccountIds(auth);
    const conds = [];
    if (visibleIds !== null) {
      if (visibleIds.length === 0) return { items: [], total: 0 };
      conds.push(inArray(financeTransaction.account_id, visibleIds));
    }
    if (p.accountId !== undefined) {
      if (visibleIds !== null && !visibleIds.includes(p.accountId)) {
        return { items: [], total: 0 };
      }
      conds.push(eq(financeTransaction.account_id, p.accountId));
    }
    if (p.accountIdsCsv) {
      const ids = p.accountIdsCsv
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) return { items: [], total: 0 };
      // Intersect with visibleIds when ACL applies; admins see all.
      const allowed =
        visibleIds === null ? ids : ids.filter((n) => visibleIds.includes(n));
      if (allowed.length === 0) return { items: [], total: 0 };
      conds.push(inArray(financeTransaction.account_id, allowed));
    }
    if (p.from) conds.push(gte(financeTransaction.booking_date, p.from));
    if (p.to) conds.push(lte(financeTransaction.booking_date, p.to));

    if (p.q && p.q.trim().length > 0) {
      const q = p.q.trim();
      const like = `%${q}%`;
      const textMatch = or(
        sql`${financeTransaction.counterparty} ILIKE ${like}`,
        sql`${financeTransaction.purpose} ILIKE ${like}`,
        sql`${financeTransaction.end_to_end_ref} ILIKE ${like}`,
        sql`${financeTransaction.mandate_ref} ILIKE ${like}`,
        sql`${financeTransaction.creditor_id} ILIKE ${like}`,
        sql`${financeTransaction.notice} ILIKE ${like}`,
      )!;
      const numericQ = Number(q.replace(",", "."));
      if (Number.isFinite(numericQ)) {
        const abs = Math.abs(numericQ).toFixed(2);
        conds.push(
          or(
            sql`ABS(${financeTransaction.amount}) = ${abs}::numeric`,
            textMatch,
          )!,
        );
      } else {
        conds.push(textMatch);
      }
    }

    if (p.tagsCsv && p.tagsCsv.trim().length > 0) {
      const names = p.tagsCsv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (names.length === 0) return { items: [], total: 0 };

      // ALL-of match: the transaction must carry every named tag.
      // Implemented as N independent IN-subqueries (one per name); for
      // the typical 1–5 tag filter this is cleaner than a HAVING-based
      // groupBy and Postgres flattens it just fine. Tag source is
      // intentionally ignored — promoting an AI tag to user must not
      // remove it from the filter set.
      for (const name of names) {
        const taggedWith = db
          .select({ id: financeTagTransaction.transaction_id })
          .from(financeTagTransaction)
          .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
          .where(eq(financeTag.name, name));
        conds.push(inArray(financeTransaction.id, taggedWith));
      }
    }

    const where = conds.length > 0 ? and(...conds) : undefined;
    // The overview's "Alle Buchungen" page renders up to 500 rows
    // without pagination, so the upper cap stays at 500.
    const limit = Math.min(Math.max(p.limit ?? 50, 1), 500);
    const offset = Math.max(p.offset ?? 0, 0);

    const rows = await db
      .select()
      .from(financeTransaction)
      .where(where)
      .orderBy(desc(financeTransaction.booking_date))
      .limit(limit)
      .offset(offset);

    // total for pagination
    const totalRows = await db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .where(where);

    const txIds = rows.map((r) => r.id);
    const tagsByTx = await annotateTags(txIds);
    return {
      items: rows.map((r) => toView(r, tagsByTx.get(r.id) ?? [])),
      total: totalRows.length,
    };
  },
);

// -----------------------------------------------------------------------
// Get by id
// -----------------------------------------------------------------------

interface IdParams {
  id: number;
}

export const getTransaction = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions/:id",
    auth: true,
  },
  async ({ id }: IdParams): Promise<TransactionView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const row = await loadTransaction(id);

    const level = await accountAccessLevel(auth, row.account_id);
    if (level === null) {
      // Hide behind a not_found to prevent enumeration.
      throw APIError.notFound(`transaction ${id} not found`);
    }
    const tags = (await annotateTags([id])).get(id) ?? [];
    return toView(row, tags);
  },
);

// -----------------------------------------------------------------------
// Create (manual booking)
// -----------------------------------------------------------------------

interface CreateParams {
  account_id: number;
  booking_date: string;
  value_date?: string | null;
  amount: number | string;
  currency_code?: string; // defaults to account's currency
  purpose?: string;
  notice?: string;
  counterparty?: string;
  counterparty_iban?: string;
  tags?: string[]; // user tags
  receipt_document_id?: number;
}

export const createTransaction = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/transactions",
    auth: true,
  },
  async (p: CreateParams): Promise<TransactionView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.id, p.account_id))
      .limit(1);
    if (!account) {
      throw APIError.notFound(`account ${p.account_id} not found`);
    }
    const level = await accountAccessLevel(auth, p.account_id);
    if (level === null) {
      throw APIError.notFound(`account ${p.account_id} not found`);
    }
    if (level !== "write") {
      throw APIError.permissionDenied(
        `write access required on account ${p.account_id}`,
      );
    }
    if (account.closed_at) {
      throw APIError.failedPrecondition(
        `account ${p.account_id} is closed and cannot accept new transactions`,
      );
    }

    // Validate currency if explicit; otherwise inherit from account.
    const currencyCode = (p.currency_code ?? account.currency_code).toUpperCase();
    if (currencyCode !== account.currency_code) {
      const [cur] = await db
        .select({ code: financeCurrency.code })
        .from(financeCurrency)
        .where(eq(financeCurrency.code, currencyCode))
        .limit(1);
      if (!cur) {
        throw APIError.invalidArgument(`unknown currency '${currencyCode}'`);
      }
    }

    if (!p.booking_date) {
      throw APIError.invalidArgument("booking_date required");
    }
    const amount = toAmountString(p.amount);
    if (amount === "0.00") {
      throw APIError.invalidArgument("amount must be non-zero");
    }

    const dedupeHash = computeDedupeHash({
      bookingDate: p.booking_date,
      valueDate: p.value_date ?? null,
      amount,
      currency: currencyCode,
      purpose: p.purpose ?? null,
      counterpartyIban: p.counterparty_iban ?? null,
      notice: p.notice ?? null,
    });

    let row: typeof financeTransaction.$inferSelect;
    try {
      const inserted = await db
        .insert(financeTransaction)
        .values({
          account_id: p.account_id,
          booking_date: p.booking_date,
          value_date: p.value_date ?? null,
          amount,
          currency_code: currencyCode,
          purpose: p.purpose?.trim() || null,
          notice: p.notice?.trim() || null,
          counterparty: p.counterparty?.trim() || null,
          counterparty_iban: p.counterparty_iban?.trim() || null,
          receipt_document_id: p.receipt_document_id ?? null,
          dedupe_hash: dedupeHash,
        })
        .returning();
      row = inserted[0];
    } catch (err: any) {
      // drizzle wraps the pg error; the SQLSTATE lives on .code when
      // the native driver throws directly, or on .cause.code when it
      // comes through DrizzleQueryError.
      const pgCode = err?.code ?? err?.cause?.code;
      if (pgCode === "23505") {
        // unique_violation on (account_id, dedupe_hash)
        throw APIError.alreadyExists(
          "duplicate transaction on this account (same date / amount / purpose / note)",
        );
      }
      throw err;
    }

    if (p.receipt_document_id) {
      await db
        .insert(financeTransactionDocument)
        .values({ transaction_id: row.id, document_id: p.receipt_document_id })
        .onConflictDoNothing();
    }

    if (p.tags && p.tags.length > 0) {
      await applyUserTags(row.id, p.tags);
    }

    // Enqueue AI tag suggestion — best-effort, never blocks the booking response.
    try {
      await enqueueTagSuggestion(row.id, Number(auth.userID));
      triggerTagWorker();
    } catch (err) {
      console.error(`[finance] failed to enqueue tag suggestion for tx=${row.id}:`, (err as Error).message);
    }

    // Document matching is advisory; never delay a newly created booking.
    void createSuggestionsForTransaction(row.id).catch(err => console.error(`[finance] document matching failed for tx=${row.id}:`, err));

    const tags = (await annotateTags([row.id])).get(row.id) ?? [];
    return toView(row, tags);
  },
);

// -----------------------------------------------------------------------
// Update (cash accounts + notice/tags for all)
// -----------------------------------------------------------------------

interface UpdateParams {
  id: number;
  notice?: string | null;
  // Fields below are only honoured for cash-account transactions.
  booking_date?: string;
  value_date?: string | null;
  amount?: string | number;
  counterparty?: string | null;
  purpose?: string | null;
}

export const updateTransaction = api(
  {
    expose: true,
    method: "PATCH",
    path: "/finance/transactions/:id",
    auth: true,
  },
  async (p: UpdateParams): Promise<TransactionView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const row = await loadTransaction(p.id);
    const level = await accountAccessLevel(auth, row.account_id);
    if (level === null) throw APIError.notFound(`transaction ${p.id} not found`);

    // Determine whether this is a cash account.
    const [acc] = await db
      .select({ type_kind: financeAccountType.kind })
      .from(financeAccount)
      .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
      .where(eq(financeAccount.id, row.account_id))
      .limit(1);
    const isCash = acc?.type_kind === "bargeld";

    const updates: Partial<typeof financeTransaction.$inferInsert> = {};
    if (p.notice !== undefined) updates.notice = p.notice;
    if (isCash && level === "write") {
      if (p.booking_date !== undefined) updates.booking_date = p.booking_date;
      if (p.value_date !== undefined) updates.value_date = p.value_date;
      if (p.amount !== undefined) updates.amount = String(p.amount);
      if (p.counterparty !== undefined) updates.counterparty = p.counterparty;
      if (p.purpose !== undefined) updates.purpose = p.purpose;
    }

    if (Object.keys(updates).length === 0) {
      const tags = (await annotateTags([p.id])).get(p.id) ?? [];
      return toView(row, tags);
    }

    const [updated] = await db
      .update(financeTransaction)
      .set(updates)
      .where(eq(financeTransaction.id, p.id))
      .returning();

    const tags = (await annotateTags([p.id])).get(p.id) ?? [];
    return toView(updated, tags);
  },
);

// -----------------------------------------------------------------------
// Delete (cash accounts only)
// -----------------------------------------------------------------------

interface DeleteTransactionResponse {
  deleted: boolean;
}

export const deleteTransaction = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/transactions/:id",
    auth: true,
  },
  async ({ id }: IdParams): Promise<DeleteTransactionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const row = await loadTransaction(id);
    const level = await accountAccessLevel(auth, row.account_id);
    if (level !== "write") {
      throw APIError.permissionDenied("write access required to delete transactions");
    }
    const [acc] = await db
      .select({ type_kind: financeAccountType.kind })
      .from(financeAccount)
      .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
      .where(eq(financeAccount.id, row.account_id))
      .limit(1);
    if (acc?.type_kind !== "bargeld") {
      throw APIError.permissionDenied("only cash-account transactions can be deleted");
    }
    await db.delete(financeTransaction).where(eq(financeTransaction.id, id));
    return { deleted: true };
  },
);

// -----------------------------------------------------------------------
// Promote AI tag → user tag
// -----------------------------------------------------------------------

interface PromoteParams {
  id: number;
  tag: string;
}

interface PromoteResponse {
  promoted: boolean;
  tags: TagOnTransaction[];
}

export const promoteAiTag = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/transactions/:id/tags/promote",
    auth: true,
  },
  async (p: PromoteParams): Promise<PromoteResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const tx = await loadTransaction(p.id);
    const level = await accountAccessLevel(auth, tx.account_id);
    if (level === null) {
      throw APIError.notFound(`transaction ${p.id} not found`);
    }

    const tagName = p.tag.trim();
    if (!tagName) throw APIError.invalidArgument("tag required");

    // Find the AI-variant of this tag on the transaction
    const [aiTag] = await db
      .select({
        id: financeTag.id,
      })
      .from(financeTag)
      .where(and(eq(financeTag.name, tagName), eq(financeTag.source, "ai")))
      .limit(1);
    if (aiTag) {
      await db
        .delete(financeTagTransaction)
        .where(
          and(
            eq(financeTagTransaction.tag_id, aiTag.id),
            eq(financeTagTransaction.transaction_id, p.id),
          ),
        );
    }

    // Upsert the user-variant and link it
    await applyUserTags(p.id, [tagName]);

    const tags = (await annotateTags([p.id])).get(p.id) ?? [];
    return { promoted: true, tags };
  },
);

// -----------------------------------------------------------------------
// Reject AI tag
// -----------------------------------------------------------------------
// Removes the AI-tag join row for this transaction AND records the
// (account, counterparty, tag) tuple in the suggester's block list, so
// the LLM does not keep re-emitting the same wrong label for similar
// transactions of the same counterparty.
//
// Requires write access on the account: rejecting affects future
// suggestions for everyone with access to it, so a read-only viewer
// must not be able to mutate the block list.

interface RejectParams {
  id: number;
  tag: string;
}

interface RejectResponse {
  rejected: boolean;
  tags: TagOnTransaction[];
}

export const rejectAiTag = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/transactions/:id/tags/reject",
    auth: true,
  },
  async (p: RejectParams): Promise<RejectResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const tx = await loadTransaction(p.id);
    const level = await accountAccessLevel(auth, tx.account_id);
    if (level === null) {
      throw APIError.notFound(`transaction ${p.id} not found`);
    }
    if (level !== "write") {
      throw APIError.permissionDenied(
        `write access required on account ${tx.account_id}`,
      );
    }

    const tagName = p.tag.trim();
    if (!tagName) throw APIError.invalidArgument("tag required");

    // 1. Drop the AI-tag join row for this transaction.
    const [aiTag] = await db
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(and(eq(financeTag.name, tagName), eq(financeTag.source, "ai")))
      .limit(1);
    if (aiTag) {
      await db
        .delete(financeTagTransaction)
        .where(
          and(
            eq(financeTagTransaction.tag_id, aiTag.id),
            eq(financeTagTransaction.transaction_id, p.id),
          ),
        );
    }

    // 2. Add to the suggester's block list. Same counterparty
    //    normalisation the suggester uses on lookup — drift would
    //    silently break the feature.
    const counterpartyNorm = normalizeCounterparty(tx.counterparty);
    await db
      .insert(financeTagBlocklist)
      .values({
        account_id: tx.account_id,
        counterparty_norm: counterpartyNorm,
        tag_name: tagName,
        created_by_user_id: Number(auth.userID),
      })
      .onConflictDoNothing();

    const tags = (await annotateTags([p.id])).get(p.id) ?? [];
    return { rejected: true, tags };
  },
);

// -----------------------------------------------------------------------
// Batch-tag
// -----------------------------------------------------------------------

interface BatchTagParams {
  transaction_ids: number[];
  add?: string[];
  remove?: string[];
  replace?: boolean; // when true, clear all existing user-tags before adding
  promote_ai_tags?: boolean; // true: promote AI tags; false: remove AI tags; undefined: keep AI tags untouched
}

interface BatchTagResponse {
  affected_transactions: number;
  added_links: number;
  removed_links: number;
}

export const batchTag = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/transactions/batch-tag",
    auth: true,
  },
  async (p: BatchTagParams): Promise<BatchTagResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    if (!Array.isArray(p.transaction_ids) || p.transaction_ids.length === 0) {
      throw APIError.invalidArgument("transaction_ids required");
    }
    const add = (p.add ?? []).map((s) => s.trim()).filter(Boolean);
    const remove = (p.remove ?? []).map((s) => s.trim()).filter(Boolean);
    if (add.length === 0 && remove.length === 0 && !p.replace) {
      throw APIError.invalidArgument("at least one of add / remove / replace required");
    }

    // ACL filter: keep only the transactions the caller may see. Done
    // outside the transaction — read-only and uses a different pool
    // path. The actual mutations below run inside `db.transaction()`
    // so the entire add/remove batch lands or rolls back as a unit.
    const visibleIds = await readableAccountIds(auth);
    let accessibleTxRows: Array<{ id: number }>;
    if (visibleIds === null) {
      accessibleTxRows = await db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(inArray(financeTransaction.id, p.transaction_ids));
    } else if (visibleIds.length === 0) {
      accessibleTxRows = [];
    } else {
      accessibleTxRows = await db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(
          and(
            inArray(financeTransaction.id, p.transaction_ids),
            inArray(financeTransaction.account_id, visibleIds),
          ),
        );
    }
    const txIds = accessibleTxRows.map((r) => r.id);
    if (txIds.length === 0) {
      return { affected_transactions: 0, added_links: 0, removed_links: 0 };
    }

    return await db.transaction(async (tx) => {
      let removedLinks = 0;

      // Handle AI tags when explicitly requested.
      // promote_ai_tags === true  → promote all AI tags to user tags
      // promote_ai_tags === false → remove all AI tag joins
      // promote_ai_tags === undefined → leave AI tags untouched (backward-compat)
      if (p.promote_ai_tags === true) {
        for (const txId of txIds) {
          const aiJoins = await tx
            .select({ tagName: financeTag.name })
            .from(financeTagTransaction)
            .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
            .where(
              and(
                eq(financeTagTransaction.transaction_id, txId),
                eq(financeTag.source, "ai"),
              ),
            );
          for (const { tagName } of aiJoins) {
            const [aiTagRow] = await tx
              .select({ id: financeTag.id })
              .from(financeTag)
              .where(and(eq(financeTag.name, tagName), eq(financeTag.source, "ai")))
              .limit(1);
            if (aiTagRow) {
              await tx
                .delete(financeTagTransaction)
                .where(
                  and(
                    eq(financeTagTransaction.tag_id, aiTagRow.id),
                    eq(financeTagTransaction.transaction_id, txId),
                  ),
                );
            }
            await applyUserTagsTx(tx, txId, [tagName]);
          }
        }
      } else if (p.promote_ai_tags === false) {
        // Explicitly reject: remove all AI-tag joins from affected transactions
        const deletedAi = await tx
          .delete(financeTagTransaction)
          .where(
            and(
              inArray(financeTagTransaction.transaction_id, txIds),
              inArray(
                financeTagTransaction.tag_id,
                tx
                  .select({ id: financeTag.id })
                  .from(financeTag)
                  .where(eq(financeTag.source, "ai")),
              ),
            ),
          )
          .returning({ id: financeTagTransaction.transaction_id });
        removedLinks += deletedAi.length;
      }

      if (p.replace) {
        // drop ALL user-tags from these transactions (keep AI suggestions)
        const delRes = await tx
          .delete(financeTagTransaction)
          .where(
            and(
              inArray(financeTagTransaction.transaction_id, txIds),
              inArray(
                financeTagTransaction.tag_id,
                tx
                  .select({ id: financeTag.id })
                  .from(financeTag)
                  .where(eq(financeTag.source, "user")),
              ),
            ),
          )
          .returning({ id: financeTagTransaction.transaction_id });
        removedLinks += delRes.length;
      } else if (remove.length > 0) {
        // Remove rows for any user-tag whose name appears in `remove`,
        // across the selected transactions. AI-tag rows are left
        // alone — they get cleared on promote.
        const tagRows = await tx
          .select({ id: financeTag.id })
          .from(financeTag)
          .where(
            and(inArray(financeTag.name, remove), eq(financeTag.source, "user")),
          );
        if (tagRows.length > 0) {
          const delRes = await tx
            .delete(financeTagTransaction)
            .where(
              and(
                inArray(financeTagTransaction.transaction_id, txIds),
                inArray(
                  financeTagTransaction.tag_id,
                  tagRows.map((t) => t.id),
                ),
              ),
            )
            .returning({ id: financeTagTransaction.transaction_id });
          removedLinks += delRes.length;
        }
      }

      let addedLinks = 0;
      if (add.length > 0) {
        for (const txId of txIds) {
          addedLinks += await applyUserTagsTx(tx, txId, add);
        }
      }

      return {
        affected_transactions: txIds.length,
        added_links: addedLinks,
        removed_links: removedLinks,
      };
    });
  },
);

// -----------------------------------------------------------------------
// Batch-Notice — set the same notice text on a selection
// -----------------------------------------------------------------------

interface BatchNoticeParams {
  transaction_ids: number[];
  notice: string;
  /** `replace` overwrites the existing notice; `append` joins onto it
   *  with a blank-line separator when the existing notice is non-empty. */
  mode: "replace" | "append";
}

interface BatchNoticeResponse {
  affected_transactions: number;
  /** Number of input ids that didn't end up updated — covers both the
   *  "outside ACL" and "doesn't exist" cases. The UI uses this to warn
   *  the user that some of their basket items were skipped. */
  skipped_unauthorized: number;
}

export const batchNotice = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/transactions/batch-notice",
    auth: true,
  },
  async (p: BatchNoticeParams): Promise<BatchNoticeResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    if (!Array.isArray(p.transaction_ids) || p.transaction_ids.length === 0) {
      throw APIError.invalidArgument("transaction_ids required");
    }
    if (p.mode !== "replace" && p.mode !== "append") {
      throw APIError.invalidArgument("mode must be 'replace' or 'append'");
    }
    const trimmed = (p.notice ?? "").trim();
    if (p.mode === "append" && trimmed.length === 0) {
      // Append-with-empty is a no-op; reject early so the caller sees
      // a clear error instead of "0 updated, why".
      throw APIError.invalidArgument("notice must be non-empty in append mode");
    }
    // updateTransaction lets any caller with read-level set a notice
    // (notes are personal annotations, not write-protected account
    // data), so we use the same ACL filter as batchTag.
    const visibleIds = await readableAccountIds(auth);
    let accessibleTxRows: Array<{ id: number }>;
    if (visibleIds === null) {
      accessibleTxRows = await db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(inArray(financeTransaction.id, p.transaction_ids));
    } else if (visibleIds.length === 0) {
      accessibleTxRows = [];
    } else {
      accessibleTxRows = await db
        .select({ id: financeTransaction.id })
        .from(financeTransaction)
        .where(
          and(
            inArray(financeTransaction.id, p.transaction_ids),
            inArray(financeTransaction.account_id, visibleIds),
          ),
        );
    }
    const txIds = accessibleTxRows.map((r) => r.id);
    const skipped = p.transaction_ids.length - txIds.length;

    if (txIds.length === 0) {
      return { affected_transactions: 0, skipped_unauthorized: skipped };
    }

    if (p.mode === "replace") {
      const next = trimmed.length === 0 ? null : trimmed;
      await db
        .update(financeTransaction)
        .set({ notice: next })
        .where(inArray(financeTransaction.id, txIds));
    } else {
      // append: keep existing text, separate with a blank line, fall
      // through to "just the new text" when the existing notice is
      // empty or NULL. A single UPDATE keeps it atomic across the
      // selection.
      await db
        .update(financeTransaction)
        .set({
          notice: sql`CASE
            WHEN ${financeTransaction.notice} IS NULL
              OR length(trim(${financeTransaction.notice})) = 0
            THEN ${trimmed}
            ELSE ${financeTransaction.notice} || E'\n\n' || ${trimmed}
          END`,
        })
        .where(inArray(financeTransaction.id, txIds));
    }

    return {
      affected_transactions: txIds.length,
      skipped_unauthorized: skipped,
    };
  },
);

interface BatchBooleanParams {
  transaction_ids: number[];
  value: boolean;
}

interface BatchMutationResponse {
  affected_transactions: number;
  skipped_unauthorized: number;
}

export const batchReview = api(
  { expose: true, method: "POST", path: "/finance/transactions/batch-review", auth: true },
  async (p: BatchBooleanParams): Promise<BatchMutationResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (!Array.isArray(p.transaction_ids) || p.transaction_ids.length === 0) {
      throw APIError.invalidArgument("transaction_ids required");
    }
    if (typeof p.value !== "boolean") throw APIError.invalidArgument("value must be boolean");
    const accessible = await accessibleTransactionIds(auth, p.transaction_ids);
    if (accessible.ids.length > 0) {
      await db.update(financeTransaction)
        .set({ reviewed_at: p.value ? sql`NOW()` : null })
        .where(inArray(financeTransaction.id, accessible.ids));
    }
    return { affected_transactions: accessible.ids.length, skipped_unauthorized: accessible.skipped };
  },
);

export const batchTaxRelevant = api(
  { expose: true, method: "POST", path: "/finance/transactions/batch-tax-relevant", auth: true },
  async (p: BatchBooleanParams): Promise<BatchMutationResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (!Array.isArray(p.transaction_ids) || p.transaction_ids.length === 0) {
      throw APIError.invalidArgument("transaction_ids required");
    }
    if (typeof p.value !== "boolean") throw APIError.invalidArgument("value must be boolean");
    const accessible = await accessibleTransactionIds(auth, p.transaction_ids);
    if (accessible.ids.length > 0) {
      await db.update(financeTransaction)
        .set({ is_tax_relevant: p.value })
        .where(inArray(financeTransaction.id, accessible.ids));
    }
    return { affected_transactions: accessible.ids.length, skipped_unauthorized: accessible.skipped };
  },
);

interface MergeCounterpartiesParams {
  transaction_ids: number[];
  canonical_name: string;
  set_iban?: string | null;
  set_bic?: string | null;
}

export const mergeCounterparties = api(
  { expose: true, method: "POST", path: "/finance/transactions/merge-counterparties", auth: true },
  async (p: MergeCounterpartiesParams): Promise<BatchMutationResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (!Array.isArray(p.transaction_ids) || p.transaction_ids.length === 0) {
      throw APIError.invalidArgument("transaction_ids required");
    }
    const canonical = p.canonical_name?.trim();
    if (!canonical) throw APIError.invalidArgument("canonical_name required");
    const accessible = await accessibleTransactionIds(auth, p.transaction_ids);
    if (accessible.ids.length > 0) {
      await db.transaction(async (tx) => {
        await tx.update(financeTransaction).set({
          counterparty: canonical,
          ...(p.set_iban !== undefined ? { counterparty_iban: p.set_iban?.trim() || null } : {}),
          ...(p.set_bic !== undefined ? { counterparty_bic: p.set_bic?.trim() || null } : {}),
        }).where(inArray(financeTransaction.id, accessible.ids));
      });
    }
    return { affected_transactions: accessible.ids.length, skipped_unauthorized: accessible.skipped };
  },
);

// CSV-Export — pull the basket out as a spreadsheet
// -----------------------------------------------------------------------

const CSV_COLUMNS = [
  "id",
  "booking_date",
  "account_iban",
  "counterparty",
  "purpose",
  "amount",
  "currency_code",
  "tags",
] as const;

/** RFC 4180 escaping: wrap in quotes when needed, double internal quotes. */
export function csvEscapeField(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsvRow(values: Array<string | null | undefined>): string {
  return values.map(csvEscapeField).join(",") + "\n";
}

function parseIdsParam(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseBooleanParam(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  return raw === "1" || raw === "true";
}

function sanitizeReportTitle(raw: string | null): string {
  const trimmed = (raw ?? "").replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 80) || "Transaktionsübersicht";
}

function slugifyFilename(title: string): string {
  return title
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "transaktionen";
}

export const exportTransactions = api.raw(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions/export",
    auth: true,
  },
  async (req, res) => {
    const auth = getAuthData();
    if (!auth) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(auth, "finance.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const ids = parseIdsParam(url.searchParams.get("ids"));
    if (ids.length === 0) {
      res.statusCode = 400;
      res.end("ids required");
      return;
    }

    // ACL filter — readableAccountIds is fine here; CSV export only
    // reveals what the caller could already see in the list view.
    const visibleIds = await readableAccountIds(auth);
    let rows: Array<{
      id: number;
      booking_date: string | null;
      counterparty: string | null;
      purpose: string | null;
      amount: string;
      currency_code: string;
      account_iban: string | null;
    }>;
    if (visibleIds === null) {
      rows = await db
        .select({
          id: financeTransaction.id,
          booking_date: financeTransaction.booking_date,
          counterparty: financeTransaction.counterparty,
          purpose: financeTransaction.purpose,
          amount: financeTransaction.amount,
          currency_code: financeTransaction.currency_code,
          account_iban: financeAccount.iban,
        })
        .from(financeTransaction)
        .innerJoin(
          financeAccount,
          eq(financeAccount.id, financeTransaction.account_id),
        )
        .where(inArray(financeTransaction.id, ids))
        .orderBy(desc(financeTransaction.booking_date), desc(financeTransaction.id));
    } else if (visibleIds.length === 0) {
      rows = [];
    } else {
      rows = await db
        .select({
          id: financeTransaction.id,
          booking_date: financeTransaction.booking_date,
          counterparty: financeTransaction.counterparty,
          purpose: financeTransaction.purpose,
          amount: financeTransaction.amount,
          currency_code: financeTransaction.currency_code,
          account_iban: financeAccount.iban,
        })
        .from(financeTransaction)
        .innerJoin(
          financeAccount,
          eq(financeAccount.id, financeTransaction.account_id),
        )
        .where(
          and(
            inArray(financeTransaction.id, ids),
            inArray(financeTransaction.account_id, visibleIds),
          ),
        )
        .orderBy(desc(financeTransaction.booking_date), desc(financeTransaction.id));
    }

    const tagsByTx = await annotateTags(rows.map((r) => r.id));

    const today = new Date().toISOString().slice(0, 10);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="basket-${today}.csv"`,
    );

    // UTF-8 BOM so Excel opens umlauts correctly without the user
    // having to pick the encoding manually.
    res.write("﻿");
    res.write(formatCsvRow([...CSV_COLUMNS]));

    for (const row of rows) {
      const userTags = (tagsByTx.get(row.id) ?? [])
        .filter((t) => t.source === "user")
        .map((t) => t.name)
        .join("; ");
      res.write(
        formatCsvRow([
          String(row.id),
          toDateString(row.booking_date),
          row.account_iban,
          row.counterparty,
          row.purpose,
          row.amount,
          row.currency_code,
          userTags,
        ]),
      );
    }
    res.end();
  },
);

export const exportTransactionsPdf = api.raw(
  { expose: true, method: "GET", path: "/finance/transactions/export-pdf", auth: true },
  async (req, res) => {
    const auth = getAuthData();
    if (!auth) { res.statusCode = 401; res.end("Unauthorized"); return; }
    try { requirePermission(auth, "finance.view"); } catch { res.statusCode = 403; res.end("Forbidden"); return; }
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const ids = parseIdsParam(params.get("ids"));
    if (ids.length === 0) { res.statusCode = 400; res.end("ids required"); return; }
    const accessible = await accessibleTransactionIds(auth, ids);
    const rows = accessible.ids.length === 0 ? [] : await db
      .select()
      .from(financeTransaction)
      .where(inArray(financeTransaction.id, accessible.ids))
      .orderBy(financeTransaction.booking_date, financeTransaction.id);
    const tags = await annotateTags(rows.map(row => row.id));
    const today = new Date().toISOString().slice(0, 10);
    const title = sanitizeReportTitle(params.get("title"));
    const filename = `${slugifyFilename(title)}-${today}.pdf`;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const pdf = createTransactionReportPdf(rows.map(row => ({
      booking_date: toDateString(row.booking_date) ?? "",
      counterparty: row.counterparty,
      purpose: row.purpose,
      amount: row.amount,
      currency_code: row.currency_code,
      notice: row.notice,
      tags: (tags.get(row.id) ?? []).filter(tag => tag.source === "user").map(tag => tag.name),
    })), today, {
      title,
      includeDate: parseBooleanParam(params.get("include_date"), true),
      includeCounterparty: parseBooleanParam(params.get("include_counterparty"), true),
      includePurpose: parseBooleanParam(params.get("include_purpose"), true),
      includeAmount: parseBooleanParam(params.get("include_amount"), true),
      includeNotice: parseBooleanParam(params.get("include_notice"), true),
      includeTags: parseBooleanParam(params.get("include_tags"), true),
    });
    pdf.pipe(res);
    pdf.end();
  },
);

// -----------------------------------------------------------------------
// Shared internals
// -----------------------------------------------------------------------

async function loadTransaction(
  id: number,
): Promise<typeof financeTransaction.$inferSelect> {
  const [row] = await db
    .select()
    .from(financeTransaction)
    .where(eq(financeTransaction.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`transaction ${id} not found`);
  return row;
}

/**
 * Upserts user-tags by name and links them to the transaction. Returns
 * the number of newly inserted join rows (pre-existing links are a
 * no-op). Does not touch AI-variant tags — those use
 * `promoteAiTag`.
 */
async function applyUserTags(
  transactionId: number,
  names: string[],
): Promise<number> {
  if (names.length === 0) return 0;
  const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  // Ensure a user-variant tag exists for each name
  for (const name of uniqueNames) {
    const existing = await db
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(and(eq(financeTag.name, name), eq(financeTag.source, "user")))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(financeTag).values({ name, source: "user" });
    }
  }

  const tagRows = await db
    .select({ id: financeTag.id, name: financeTag.name })
    .from(financeTag)
    .where(
      and(inArray(financeTag.name, uniqueNames), eq(financeTag.source, "user")),
    );

  // Insert join rows, skipping duplicates
  let added = 0;
  for (const tag of tagRows) {
    const [existing] = await db
      .select({ tag_id: financeTagTransaction.tag_id })
      .from(financeTagTransaction)
      .where(
        and(
          eq(financeTagTransaction.tag_id, tag.id),
          eq(financeTagTransaction.transaction_id, transactionId),
        ),
      )
      .limit(1);
    if (!existing) {
      await db.insert(financeTagTransaction).values({
        tag_id: tag.id,
        transaction_id: transactionId,
      });
      added++;
    }
  }

  // User tags take precedence — remove any AI-tag joins that still exist
  // on this transaction so they don't reappear in the UI.
  await db
    .delete(financeTagTransaction)
    .where(
      and(
        eq(financeTagTransaction.transaction_id, transactionId),
        inArray(
          financeTagTransaction.tag_id,
          db.select({ id: financeTag.id }).from(financeTag).where(eq(financeTag.source, "ai")),
        ),
      ),
    );

  return added;
}

/**
 * Same as `applyUserTags`, but routes every query through the supplied
 * transaction executor. Used by `batchTag` so the entire add/remove
 * pass is a single atomic operation: the caller's "Speichern"-click on
 * the multi-tag editor either commits all changes or rolls back to
 * the prior state. Untyped executor parameter (`any`) because Drizzle
 * doesn't expose a clean union of "db" and "tx".
 */
async function applyUserTagsTx(
  tx: any,
  transactionId: number,
  names: string[],
): Promise<number> {
  if (names.length === 0) return 0;
  const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  for (const name of uniqueNames) {
    const existing = await tx
      .select({ id: financeTag.id })
      .from(financeTag)
      .where(and(eq(financeTag.name, name), eq(financeTag.source, "user")))
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(financeTag).values({ name, source: "user" });
    }
  }

  const tagRows = await tx
    .select({ id: financeTag.id, name: financeTag.name })
    .from(financeTag)
    .where(
      and(inArray(financeTag.name, uniqueNames), eq(financeTag.source, "user")),
    );

  let added = 0;
  for (const tag of tagRows as Array<{ id: number; name: string }>) {
    const existing = await tx
      .select({ tag_id: financeTagTransaction.tag_id })
      .from(financeTagTransaction)
      .where(
        and(
          eq(financeTagTransaction.tag_id, tag.id),
          eq(financeTagTransaction.transaction_id, transactionId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(financeTagTransaction).values({
        tag_id: tag.id,
        transaction_id: transactionId,
      });
      added++;
    }
  }

  // User tags take precedence — remove any AI-tag joins that still exist
  // on this transaction so they don't reappear in the UI.
  await tx
    .delete(financeTagTransaction)
    .where(
      and(
        eq(financeTagTransaction.transaction_id, transactionId),
        inArray(
          financeTagTransaction.tag_id,
          tx.select({ id: financeTag.id }).from(financeTag).where(eq(financeTag.source, "ai")),
        ),
      ),
    );

  return added;
}

// -----------------------------------------------------------------------
// Recent cash recipients (#254)
// -----------------------------------------------------------------------

interface RecentRecipient {
  counterparty: string;
  tags: string[];
}

interface RecentRecipientsResponse {
  items: RecentRecipient[];
}

export const recentCashRecipients = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions/recent-cash-recipients",
    auth: true,
  },
  async (): Promise<RecentRecipientsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const visibleIds = await readableAccountIds(auth);

    // Find bargeld account ids visible to this user.
    const cashAccounts = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
      .where(
        and(
          eq(financeAccountType.kind, "bargeld"),
          visibleIds !== null
            ? inArray(financeAccount.id, visibleIds.length > 0 ? visibleIds : [-1])
            : undefined,
        ),
      );

    if (cashAccounts.length === 0) return { items: [] };

    const cashAccountIds = cashAccounts.map((a) => a.id);

    // Fetch the 50 most recent cash transactions with a counterparty.
    const rows = await db
      .select({ id: financeTransaction.id, counterparty: financeTransaction.counterparty })
      .from(financeTransaction)
      .where(
        and(
          inArray(financeTransaction.account_id, cashAccountIds),
          sql`${financeTransaction.counterparty} IS NOT NULL`,
        ),
      )
      .orderBy(desc(financeTransaction.booking_date))
      .limit(50);

    // Deduplicate: keep only the latest occurrence of each counterparty.
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      const key = r.counterparty!;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const txIds = deduped.map((r) => r.id);
    const tagsByTx = await annotateTags(txIds);

    return {
      items: deduped.map((r) => ({
        counterparty: r.counterparty!,
        tags: (tagsByTx.get(r.id) ?? [])
          .filter((t) => t.source === "user")
          .map((t) => t.name),
      })),
    };
  },
);

// -----------------------------------------------------------------------
// Search recipients (#254)
// -----------------------------------------------------------------------

interface SearchRecipientsParams {
  q: string;
}

export const searchRecipients = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/transactions/recipients",
    auth: true,
  },
  async (p: SearchRecipientsParams): Promise<RecentRecipientsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const visibleIds = await readableAccountIds(auth);
    const q = p.q.trim();
    if (q.length === 0) return { items: [] };

    const like = `%${q}%`;

    // Find all unique counterparties matching q, ordered by most recent use.
    // We use a subquery to find the latest transaction ID for each counterparty.
    const latestPerRecipient = db
      .select({
        counterparty: financeTransaction.counterparty,
        max_id: sql<number>`MAX(${financeTransaction.id})`.as("max_id"),
      })
      .from(financeTransaction)
      .where(
        and(
          sql`${financeTransaction.counterparty} ILIKE ${like}`,
          visibleIds !== null
            ? inArray(financeTransaction.account_id, visibleIds.length > 0 ? visibleIds : [-1])
            : undefined,
        ),
      )
      .groupBy(financeTransaction.counterparty)
      .as("latest_recipients");

    const rows = await db
      .select({
        id: financeTransaction.id,
        counterparty: financeTransaction.counterparty,
      })
      .from(financeTransaction)
      .innerJoin(latestPerRecipient, eq(financeTransaction.id, latestPerRecipient.max_id))
      .orderBy(desc(financeTransaction.id))
      .limit(20);

    const txIds = rows.map((r) => r.id);
    const tagsByTx = await annotateTags(txIds);

    return {
      items: rows.map((r) => ({
        counterparty: r.counterparty!,
        tags: (tagsByTx.get(r.id) ?? [])
          .filter((t) => t.source === "user")
          .map((t) => t.name),
      })),
    };
  },
);
