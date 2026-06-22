/**
 * Depot transactions (Track AC Phase 2 — #439 / #428).
 *
 * Per-position buys / sells / dividends / corporate actions for depot
 * accounts. This module covers listing and manual entry; giro-booking
 * derivation (source='giro-derived') and CSV import land in follow-ups.
 *
 * Access mirrors finance/holdings.ts and finance/transactions.ts:
 *   - `finance.view` is the module-level read permission.
 *   - Reads additionally require a finance_account_access row (ACL) or
 *     `finance.admin`.
 *   - Manual writes additionally require `level='write'` on the ACL
 *     (admins always count as write).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeDepotTransaction,
} from "../db/schema";
import { deriveDepotTransactionsForBankcontact } from "./depot-derivation";

console.log("[boot] finance/depot-transactions.ts: all imports resolved");

// The set of transaction kinds we accept. Kept as a TS union so Encore's
// request validation rejects anything else at the boundary.
export type DepotTransactionKind =
  | "buy"
  | "sell"
  | "in"
  | "out"
  | "dividend"
  | "split"
  | "corp_action";

const VALID_KINDS: ReadonlySet<string> = new Set<DepotTransactionKind>([
  "buy",
  "sell",
  "in",
  "out",
  "dividend",
  "split",
  "corp_action",
]);

interface DepotTransactionView {
  id: number;
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  kind: string;
  executed_at: string;
  amount: string | null;
  price: string | null;
  gross_amount: string | null;
  fees: string | null;
  tax: string | null;
  net_amount: string | null;
  currency: string | null;
  source: string;
  linked_transaction_id: number | null;
  note: string | null;
  created_at: string | null;
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

/**
 * Returns the caller's ACL level for the account ("read" | "write"),
 * or null when the caller has no access at all. Admins are always
 * "write".
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(raw: string, field: string): string {
  if (!ISO_DATE_RE.test(raw)) {
    throw APIError.invalidArgument(`${field} must be YYYY-MM-DD`);
  }
  return raw;
}

/**
 * Parse an optional numeric input into a fixed-scale string (or null).
 * We keep numerics as strings end-to-end to avoid float drift, matching
 * the rest of the finance module.
 */
function toNumericString(
  value: number | string | null | undefined,
  field: string,
  scale: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw APIError.invalidArgument(`${field} must be a number`);
  }
  return n.toFixed(scale);
}

function toView(
  r: typeof financeDepotTransaction.$inferSelect,
): DepotTransactionView {
  return {
    id: r.id,
    account_id: r.account_id,
    isin: r.isin,
    wkn: r.wkn,
    name: r.name,
    kind: r.kind,
    executed_at:
      typeof r.executed_at === "string"
        ? r.executed_at.slice(0, 10)
        : r.executed_at,
    amount: r.amount,
    price: r.price,
    gross_amount: r.gross_amount,
    fees: r.fees,
    tax: r.tax,
    net_amount: r.net_amount,
    currency: r.currency,
    source: r.source,
    linked_transaction_id: r.linked_transaction_id,
    note: r.note,
    created_at: r.created_at,
  };
}

// ----------------------------------------------------------------------
// List
// ----------------------------------------------------------------------

interface ListDepotTransactionsParams {
  id: number;
  /** Optional position filter (matches isin OR wkn). */
  isin?: string;
  wkn?: string;
}

interface ListDepotTransactionsResponse {
  items: DepotTransactionView[];
}

export const listDepotTransactions = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id/depot-transactions",
    auth: true,
  },
  async ({
    id,
    isin,
    wkn,
  }: ListDepotTransactionsParams): Promise<ListDepotTransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    const level = await accountAccessLevel(auth, id);
    if (level === null) throw APIError.notFound(`account ${id} not found`);

    const conditions = [eq(financeDepotTransaction.account_id, id)];
    if (isin) conditions.push(eq(financeDepotTransaction.isin, isin));
    if (wkn) conditions.push(eq(financeDepotTransaction.wkn, wkn));

    const rows = await db
      .select()
      .from(financeDepotTransaction)
      .where(and(...conditions))
      .orderBy(
        desc(financeDepotTransaction.executed_at),
        desc(financeDepotTransaction.id),
      );

    return { items: rows.map(toView) };
  },
);

// ----------------------------------------------------------------------
// Create (manual)
// ----------------------------------------------------------------------

interface CreateDepotTransactionParams {
  id: number;
  isin?: string | null;
  wkn?: string | null;
  name?: string | null;
  kind: DepotTransactionKind;
  executed_at: string;
  amount?: number | string | null;
  price?: number | string | null;
  gross_amount?: number | string | null;
  fees?: number | string | null;
  tax?: number | string | null;
  net_amount?: number | string | null;
  currency?: string | null;
  note?: string | null;
}

export const createDepotTransaction = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/accounts/:id/depot-transactions",
    auth: true,
  },
  async (p: CreateDepotTransactionParams): Promise<DepotTransactionView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select({
        id: financeAccount.id,
        currency_code: financeAccount.currency_code,
      })
      .from(financeAccount)
      .where(eq(financeAccount.id, p.id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${p.id} not found`);

    const level = await accountAccessLevel(auth, p.id);
    if (level === null) throw APIError.notFound(`account ${p.id} not found`);
    if (level !== "write") {
      throw APIError.permissionDenied(
        `write access required on account ${p.id}`,
      );
    }

    if (!VALID_KINDS.has(p.kind)) {
      throw APIError.invalidArgument(`invalid kind '${p.kind}'`);
    }

    const isin = p.isin?.trim() || null;
    const wkn = p.wkn?.trim() || null;
    const name = p.name?.trim() || null;
    if (!isin && !wkn && !name) {
      throw APIError.invalidArgument(
        "one of isin, wkn or name is required to identify the position",
      );
    }

    const executedAt = toDateString(p.executed_at, "executed_at");
    const amount = toNumericString(p.amount, "amount", 8);
    const price = toNumericString(p.price, "price", 6);
    const gross = toNumericString(p.gross_amount, "gross_amount", 2);
    const fees = toNumericString(p.fees, "fees", 2);
    const tax = toNumericString(p.tax, "tax", 2);
    const net = toNumericString(p.net_amount, "net_amount", 2);
    const currency = (p.currency?.trim() || account.currency_code).toUpperCase();

    const inserted = await db
      .insert(financeDepotTransaction)
      .values({
        account_id: p.id,
        isin,
        wkn,
        name,
        kind: p.kind,
        executed_at: executedAt,
        amount,
        price,
        gross_amount: gross,
        fees,
        tax,
        net_amount: net,
        currency,
        source: "manual",
        note: p.note?.trim() || null,
      })
      .returning();

    return toView(inserted[0]);
  },
);

// ----------------------------------------------------------------------
// Delete
// ----------------------------------------------------------------------

interface DeleteDepotTransactionParams {
  txId: number;
}

interface DeleteDepotTransactionResponse {
  deleted: true;
}

export const deleteDepotTransaction = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/depot-transactions/:txId",
    auth: true,
  },
  async ({
    txId,
  }: DeleteDepotTransactionParams): Promise<DeleteDepotTransactionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [row] = await db
      .select({
        id: financeDepotTransaction.id,
        account_id: financeDepotTransaction.account_id,
        source: financeDepotTransaction.source,
      })
      .from(financeDepotTransaction)
      .where(eq(financeDepotTransaction.id, txId))
      .limit(1);
    if (!row) throw APIError.notFound(`depot transaction ${txId} not found`);

    const level = await accountAccessLevel(auth, row.account_id);
    // Hide existence from users without any access to the account.
    if (level === null) {
      throw APIError.notFound(`depot transaction ${txId} not found`);
    }
    if (level !== "write") {
      throw APIError.permissionDenied(
        `write access required on account ${row.account_id}`,
      );
    }
    if (row.source !== "manual") {
      throw APIError.failedPrecondition(
        `only manually entered depot transactions can be deleted (source=${row.source})`,
      );
    }

    await db
      .delete(financeDepotTransaction)
      .where(eq(financeDepotTransaction.id, txId));

    return { deleted: true };
  },
);

// ----------------------------------------------------------------------
// Re-derive from giro bookings (Phase 2b)
//
// Triggers `deriveDepotTransactionsForBankcontact` for the bankcontact
// owning the target account. Idempotent — only adds rows for SECU giro
// bookings that don't yet have a derived counterpart. Useful for
// backfilling history that predates Phase 2.
// ----------------------------------------------------------------------

interface DeriveDepotTransactionsParams {
  id: number;
}

interface DeriveDepotTransactionsResponse {
  derived: number;
  skipped: number;
  duplicates: number;
  errors: string[];
}

export const deriveDepotTransactionsFromGiro = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/accounts/:id/depot-transactions/derive",
    auth: true,
  },
  async ({
    id,
  }: DeriveDepotTransactionsParams): Promise<DeriveDepotTransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select({
        id: financeAccount.id,
        bankcontact_id: financeAccount.bankcontact_id,
      })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    const level = await accountAccessLevel(auth, id);
    if (level === null) throw APIError.notFound(`account ${id} not found`);
    if (level !== "write") {
      throw APIError.permissionDenied(
        `write access required on account ${id}`,
      );
    }
    if (account.bankcontact_id === null) {
      throw APIError.failedPrecondition(
        `account ${id} has no bankcontact — derivation only works for bank-linked depots`,
      );
    }

    const stats = await deriveDepotTransactionsForBankcontact(
      account.bankcontact_id,
    );
    return stats;
  },
);
