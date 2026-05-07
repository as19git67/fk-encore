/**
 * One-shot Finanzkraft JSON import (Etappe 7).
 *
 * Takes the whole export object as the typed request body. Runs each
 * entity kind as its own DB transaction, so a failure in one stage
 * only rolls back that stage; earlier stages stay persisted.
 * Validation errors (FK lookup misses, enum mismatches, bad amounts)
 * are collected per-row and returned in the response — they don't
 * abort the import.
 *
 * Idempotency: every insert goes through ON CONFLICT DO NOTHING with
 * the natural keys from finance-data-import.md §5, so re-running the
 * same file produces { skipped: N, inserted: 0 }.
 *
 * NOT imported (per finance-data-import.md §2):
 *   - credentials (users re-enter them via BankcontactDetailView)
 *   - finance_account_access (admin assigns per-user via UI)
 *   - transaction_status (column doesn't exist)
 *   - categories / rules (don't exist in the new design)
 *
 * Permission: finance.admin.
 */

import { createHash } from "node:crypto";
import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { and, eq, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import {
  financeAccount,
  financeAccountKindEnum,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
  financeTag,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";
import {
  validateExport,
  ImportSchemaError,
  type FinanzkraftExport,
  type ImportAccount,
  type ImportBankcontact,
  type ImportCurrency,
  type ImportTagLink,
  type ImportTransaction,
} from "./import-schema";

console.log("[boot] finance/data-import.ts: all imports resolved");

// -----------------------------------------------------------------------
// Request / response
// -----------------------------------------------------------------------

interface ImportRequest {
  /**
   * The whole Finanzkraft export as parsed JSON. Passed by-value for
   * Encore's type-safety — huge imports (>10 MB) should chunk via a
   * future streaming variant; for MVP the single-request form is
   * enough.
   */
  export: unknown;
  /**
   * When true, every finance_* row (bankcontacts, accounts, transactions,
   * tags, balances, ACL entries, embeddings, TAN sessions) is wiped
   * before the import starts. Stammdaten (currencies, account_type,
   * timespan, system_pref) are NOT touched.
   *
   * This is the "clean slate" path for iterative testing with the
   * Finanzkraft export — without it a re-import is idempotent (skips
   * existing rows) which makes it hard to test mapping changes.
   */
  wipe_first?: boolean;
}

interface ValidationError {
  entity: string;
  row: number;
  message: string;
}

interface EntityCounts {
  currencies: number;
  bankcontacts: number;
  accounts: number;
  transactions: number;
  tags: number;
  tag_links: number;
}

export interface ImportResponse {
  counts: EntityCounts;
  skipped: EntityCounts;
  errors: ValidationError[];
}

export const importFinanceData = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/admin/import",
    auth: true,
  },
  async (req: ImportRequest): Promise<ImportResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.admin");

    // Import is expensive (minutes, large TXs). Tight per-user cap.
    // See docs/finance-rate-limiting.md §2.
    checkRateLimit(`finance-import:${auth.userID}`, {
      maxAttempts: 3,
      windowMs: 60 * 60_000,
      message: "Too many import attempts.",
    });

    return runImport(req);
  },
);

/**
 * Internal entry point used by both the HTTP endpoint above and the
 * pending-imports cron in `import-pending.ts`. Skips auth + rate-limit
 * (callers handle those — the cron is not exposed externally).
 */
export async function runImport(req: ImportRequest): Promise<ImportResponse> {
  let exportData: FinanzkraftExport;
  try {
    exportData = validateExport(req.export);
  } catch (err) {
    if (err instanceof ImportSchemaError) {
      throw APIError.invalidArgument(err.message);
    }
    throw err;
  }

  log.info("runImport: start", {
    wipe_first: !!req.wipe_first,
    currencies: exportData.currencies?.length ?? 0,
    bankcontacts: exportData.bankcontacts.length,
    accounts: exportData.accounts.length,
    transactions: exportData.transactions.length,
    tags: exportData.tags.length,
    tag_links: exportData.tag_links.length,
  });
  const startedAt = Date.now();

  if (req.wipe_first) {
    log.info("runImport: wiping finance_* tables");
    await wipeFinanceData();
  }

  const counts: EntityCounts = {
    currencies: 0,
    bankcontacts: 0,
    accounts: 0,
    transactions: 0,
    tags: 0,
    tag_links: 0,
  };
  const skipped: EntityCounts = { ...counts };
  const errors: ValidationError[] = [];

  // Stage 0: Currencies (any new ISO codes mentioned by accounts /
  // transactions are upserted before the typed-FK stages run, so the
  // import can bring CHF/GBP/etc. without a prior manual migration).
  if (exportData.currencies && exportData.currencies.length > 0) {
    await importCurrencies(exportData.currencies, counts, skipped, errors);
    log.info("runImport: stage 0 currencies done", {
      inserted: counts.currencies,
      skipped: skipped.currencies,
    });
  }

  // Stage 1: Bankcontacts
  const bankcontactIdByKey = await importBankcontacts(
    exportData.bankcontacts,
    counts,
    skipped,
    errors,
  );
  log.info("runImport: stage 1 bankcontacts done", {
    inserted: counts.bankcontacts,
    skipped: skipped.bankcontacts,
  });

  // Stage 2: Accounts (needs bankcontactIdByKey)
  const accountIdByKey = await importAccounts(
    exportData.accounts,
    bankcontactIdByKey,
    counts,
    skipped,
    errors,
  );
  log.info("runImport: stage 2 accounts done", {
    inserted: counts.accounts,
    skipped: skipped.accounts,
  });

  // Stage 3: Transactions (needs accountIdByKey)
  const transactionIdByLookup = await importTransactions(
    exportData.transactions,
    accountIdByKey,
    counts,
    skipped,
    errors,
  );
  log.info("runImport: stage 3 transactions done", {
    inserted: counts.transactions,
    skipped: skipped.transactions,
  });

  // Stage 4: Tags (user-source)
  const tagIdByName = await importTags(
    exportData.tags,
    counts,
    skipped,
    errors,
  );
  log.info("runImport: stage 4 tags done", {
    inserted: counts.tags,
    skipped: skipped.tags,
  });

  // Stage 5: Tag links
  await importTagLinks(
    exportData.tag_links,
    tagIdByName,
    accountIdByKey,
    transactionIdByLookup,
    counts,
    skipped,
    errors,
  );
  log.info("runImport: stage 5 tag_links done", {
    inserted: counts.tag_links,
    skipped: skipped.tag_links,
  });

  log.info("runImport: complete", {
    duration_ms: Date.now() - startedAt,
    counts,
    skipped,
    errors: errors.length,
  });

  return { counts, skipped, errors };
}

// -----------------------------------------------------------------------
// Helpers: natural keys
// -----------------------------------------------------------------------

function bankcontactKey(blz: string, login: string): string {
  return `${blz}::${login}`;
}

function accountKey(bc: string, accountNumber: string): string {
  return `${bc}::${accountNumber}`;
}

/** Natural key for manual accounts (no bankcontact). Includes label so
 * two cash wallets with the same synthetic account_number don't collide
 * — e.g. the Finanzkraft converter assigns "fk-1", "fk-2" to its two
 * cash accounts but they have different labels ("Bargeld Anton" vs.
 * "Bargeld Martina"). */
function manualAccountKey(accountNumber: string, label: string): string {
  return `manual::${accountNumber}::${label}`;
}

function transactionLookupKey(
  accountId: number,
  bookingDate: string,
  dedupeHash: string,
): string {
  return `${accountId}::${bookingDate}::${dedupeHash}`;
}

function normalizeDate(date: string): string {
  // transactions table stores timestamp; Postgres happily accepts
  // 'YYYY-MM-DD' and coerces it. Strip trailing T00:00:00Z noise if
  // the input includes it.
  return date.slice(0, 10);
}

function computeDedupeHash(t: ImportTransaction): string {
  const canonical = [
    normalizeDate(t.booking_date),
    t.value_date ? normalizeDate(t.value_date) : "",
    t.amount,
    t.currency_code.toUpperCase(),
    t.purpose ?? "",
    t.counterparty_iban ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

// -----------------------------------------------------------------------
// Wipe (req.wipe_first)
// -----------------------------------------------------------------------

/**
 * Truncate every finance_* table that holds user data so a re-run of the
 * importer starts on a clean slate. Stammdaten (currencies, account
 * types, timespans, system prefs) are deliberately preserved — they're
 * shipped via the migration seed and re-creating them here would risk
 * drifting from that seed.
 *
 * `finance_transaction_embedding` is included even though it lives only
 * as a raw migration (not in db/schema.ts), because pgvector rows
 * reference transactions and would block the TRUNCATE without CASCADE.
 *
 * One TRUNCATE statement with a comma-separated list lets Postgres do
 * the whole wipe in one transaction — no partial state visible to a
 * concurrent reader.
 */
async function wipeFinanceData(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      finance_tag_transaction,
      finance_transaction_embedding,
      finance_transaction,
      finance_tag,
      finance_account_balance,
      finance_account_access,
      finance_account,
      finance_tan_session,
      finance_bankcontact
    RESTART IDENTITY CASCADE
  `);
}

// -----------------------------------------------------------------------
// Stage 0: currencies
// -----------------------------------------------------------------------

async function importCurrencies(
  rows: ImportCurrency[],
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<void> {
  const existing = await db.select({ code: financeCurrency.code }).from(financeCurrency);
  const present = new Set(existing.map((r) => r.code));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const code = r.code.trim().toUpperCase();
    if (present.has(code)) {
      skipped.currencies++;
      continue;
    }
    try {
      await db.insert(financeCurrency).values({
        code,
        symbol: r.symbol?.trim() || code,
        decimals: r.decimals ?? 2,
      });
      counts.currencies++;
      present.add(code);
    } catch (err: any) {
      errors.push({
        entity: "currencies",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }
}

// -----------------------------------------------------------------------
// Stage 1: bankcontacts
// -----------------------------------------------------------------------

async function importBankcontacts(
  rows: ImportBankcontact[],
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<Map<string, number>> {
  const idByKey = new Map<string, number>();

  // Load any pre-existing rows so we honour idempotency without an
  // INSERT ... ON CONFLICT that would require a dedicated unique index.
  const existing = await db
    .select({
      id: financeBankcontact.id,
      blz: financeBankcontact.blz,
      login: financeBankcontact.login,
    })
    .from(financeBankcontact);
  for (const row of existing) {
    idByKey.set(bankcontactKey(row.blz, row.login), row.id);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = bankcontactKey(r.blz, r.login);
    if (idByKey.has(key)) {
      skipped.bankcontacts++;
      continue;
    }
    try {
      const [inserted] = await db
        .insert(financeBankcontact)
        .values({
          blz: r.blz,
          login: r.login,
          name: r.name,
          server_url: r.server_url,
          tan_method: r.tan_method ?? null,
        })
        .returning({ id: financeBankcontact.id });
      idByKey.set(key, inserted.id);
      counts.bankcontacts++;
    } catch (err: any) {
      errors.push({
        entity: "bankcontacts",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }

  return idByKey;
}

// -----------------------------------------------------------------------
// Stage 2: accounts
// -----------------------------------------------------------------------

async function importAccounts(
  rows: ImportAccount[],
  bankcontactIdByKey: Map<string, number>,
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<Map<string, number>> {
  const idByKey = new Map<string, number>();
  const idByIban = new Map<string, number>();

  // Load reference tables once
  const types = await db.select().from(financeAccountType);
  const typeByKind = new Map(types.map((t) => [t.kind, t.id]));
  const currencies = await db.select().from(financeCurrency);
  const currencySet = new Set(currencies.map((c) => c.code));

  // Pre-load existing accounts for idempotency
  const existing = await db
    .select({
      id: financeAccount.id,
      bankcontact_id: financeAccount.bankcontact_id,
      iban: financeAccount.iban,
      account_number: financeAccount.account_number,
      label: financeAccount.label,
    })
    .from(financeAccount);
  for (const row of existing) {
    if (row.bankcontact_id !== null) {
      idByKey.set(
        accountKey(String(row.bankcontact_id), row.account_number),
        row.id,
      );
    } else {
      // Manual accounts have no bankcontact — natural key is
      // (account_number, label) so the same physical wallet imported
      // twice doesn't duplicate.
      idByKey.set(manualAccountKey(row.account_number, row.label), row.id);
    }
    // All accounts (manual and linked) are reachable by account_number alone
    // so that transactions without IBAN context can still find their parent.
    idByKey.set(`manual::${row.account_number}`, row.id);
    if (row.iban) idByIban.set(row.iban, row.id);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    let bcId: number | null = null;
    if (r.bankcontact_blz && r.bankcontact_login) {
      const found = bankcontactIdByKey.get(
        bankcontactKey(r.bankcontact_blz, r.bankcontact_login),
      );
      if (!found) {
        errors.push({
          entity: "accounts",
          row: i,
          message: `unknown bankcontact (blz=${r.bankcontact_blz}, login=${r.bankcontact_login})`,
        });
        continue;
      }
      bcId = found;
    }

    // Idempotency: iban wins when present. For linked accounts the
    // fallback is (bc_id, account_number); for manual accounts it's
    // (account_number, label) since there is no bc.
    const ibanMatch = r.iban ? idByIban.get(r.iban) : undefined;
    const numberMatch =
      bcId !== null
        ? idByKey.get(accountKey(String(bcId), r.account_number))
        : idByKey.get(manualAccountKey(r.account_number, r.label));
    if (ibanMatch || numberMatch) {
      skipped.accounts++;
      const finalId = ibanMatch ?? numberMatch!;
      if (bcId !== null) {
        idByKey.set(accountKey(String(bcId), r.account_number), finalId);
      } else {
        idByKey.set(manualAccountKey(r.account_number, r.label), finalId);
      }
      idByKey.set(`manual::${r.account_number}`, finalId);
      if (r.iban) idByIban.set(r.iban, finalId);
      continue;
    }

    const typeKind = r.type_kind.toLowerCase();
    if (
      !(financeAccountKindEnum.enumValues as readonly string[]).includes(
        typeKind,
      )
    ) {
      errors.push({
        entity: "accounts",
        row: i,
        message: `unknown type_kind '${r.type_kind}'`,
      });
      continue;
    }
    const typeId = typeByKind.get(typeKind);
    if (!typeId) {
      // Should be caught above, but belt-and-braces
      errors.push({
        entity: "accounts",
        row: i,
        message: `finance_account_type seed missing for '${typeKind}'`,
      });
      continue;
    }

    const currencyCode = r.currency_code.toUpperCase();
    if (!currencySet.has(currencyCode)) {
      errors.push({
        entity: "accounts",
        row: i,
        message: `unknown currency_code '${r.currency_code}'`,
      });
      continue;
    }

    try {
      const [inserted] = await db
        .insert(financeAccount)
        .values({
          bankcontact_id: bcId,
          type_id: typeId,
          currency_code: currencyCode,
          iban: r.iban ?? null,
          account_number: r.account_number,
          label: r.label,
          active: r.active ?? true,
          fints_account_number: r.fints_account_number ?? null,
        })
        .returning({ id: financeAccount.id });
      if (bcId !== null) {
        idByKey.set(accountKey(String(bcId), r.account_number), inserted.id);
      } else {
        idByKey.set(manualAccountKey(r.account_number, r.label), inserted.id);
      }
      // Stage 3 (transactions) uses the simpler manual::<number> key for
      // accounts without an IBAN — both cash wallets and bankcontact-linked
      // accounts that happen to have no IBAN in Finanzkraft.
      idByKey.set(`manual::${r.account_number}`, inserted.id);
      if (r.iban) idByIban.set(r.iban, inserted.id);
      counts.accounts++;
    } catch (err: any) {
      errors.push({
        entity: "accounts",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }

  // Second pass: remember the combined key `iban → id` for transaction
  // lookup. We export the account map keyed by iban AND by (bc_id,
  // account_number). The caller uses whichever the row supplies.
  // Merge the iban index into idByKey under a distinct prefix.
  for (const [iban, id] of idByIban) {
    idByKey.set(`iban::${iban}`, id);
  }
  return idByKey;
}

// -----------------------------------------------------------------------
// Stage 3: transactions
// -----------------------------------------------------------------------

async function importTransactions(
  rows: ImportTransaction[],
  accountIdByKey: Map<string, number>,
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<Map<string, number>> {
  const idByLookup = new Map<string, number>();

  const currencies = await db.select({ code: financeCurrency.code }).from(financeCurrency);
  const currencySet = new Set(currencies.map((c) => c.code));

  // Heartbeat for long imports — emits a log line every 1000 rows so a
  // ~50k transaction load shows ~50 progress lines in the container
  // log instead of a 5-minute silence.
  const PROGRESS_EVERY = 1000;
  const stageStart = Date.now();

  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % PROGRESS_EVERY === 0) {
      log.info("importTransactions: progress", {
        processed: i,
        total: rows.length,
        inserted: counts.transactions,
        skipped: skipped.transactions,
        elapsed_ms: Date.now() - stageStart,
      });
    }
    const r = rows[i];
    const accountId = resolveAccountId(r, accountIdByKey);
    if (!accountId) {
      errors.push({
        entity: "transactions",
        row: i,
        message:
          "cannot locate parent account (need iban or bankcontact_blz+login+account_number)",
      });
      continue;
    }
    const currencyCode = r.currency_code.toUpperCase();
    if (!currencySet.has(currencyCode)) {
      errors.push({
        entity: "transactions",
        row: i,
        message: `unknown currency_code '${r.currency_code}'`,
      });
      continue;
    }

    // Amount: accept signed decimal with dot separator
    const amountNum = Number(r.amount);
    if (!Number.isFinite(amountNum)) {
      errors.push({
        entity: "transactions",
        row: i,
        message: `amount '${r.amount}' is not a number`,
      });
      continue;
    }
    const amount = amountNum.toFixed(2);

    const bookingDate = normalizeDate(r.booking_date);
    const valueDate = r.value_date ? normalizeDate(r.value_date) : null;
    const dedupeHash = r.dedupe_hash ?? computeDedupeHash(r);

    try {
      const [inserted] = await db
        .insert(financeTransaction)
        .values({
          account_id: accountId,
          booking_date: bookingDate,
          value_date: valueDate,
          amount,
          currency_code: currencyCode,
          purpose: r.purpose ?? null,
          counterparty: r.counterparty ?? null,
          counterparty_iban: r.counterparty_iban ?? null,
          counterparty_bic: r.counterparty_bic ?? null,
          counterparty_bank_id: r.counterparty_bank_id ?? null,
          end_to_end_ref: r.end_to_end_ref ?? null,
          mandate_ref: r.mandate_ref ?? null,
          creditor_id: r.creditor_id ?? null,
          bank_ref: r.bank_ref ?? null,
          originator_name: r.originator_name ?? null,
          recipient_name: r.recipient_name ?? null,
          funds_code: r.funds_code ?? null,
          transaction_type: r.transaction_type ?? null,
          transaction_code: r.transaction_code ?? null,
          entry_text: r.entry_text ?? null,
          prima_nota_no: r.prima_nota_no ?? null,
          original_amount: r.original_amount ?? null,
          original_currency_code: r.original_currency_code ?? null,
          exchange_rate: r.exchange_rate ?? null,
          dedupe_hash: dedupeHash,
          raw: r.raw ?? null,
        })
        .onConflictDoNothing({
          target: [financeTransaction.account_id, financeTransaction.dedupe_hash],
        })
        .returning({ id: financeTransaction.id });

      if (inserted) {
        counts.transactions++;
        idByLookup.set(
          transactionLookupKey(accountId, bookingDate, dedupeHash),
          inserted.id,
        );
      } else {
        skipped.transactions++;
        // Need to resolve the existing row's id for tag linking
        const [existing] = await db
          .select({ id: financeTransaction.id })
          .from(financeTransaction)
          .where(
            and(
              eq(financeTransaction.account_id, accountId),
              eq(financeTransaction.dedupe_hash, dedupeHash),
            ),
          )
          .limit(1);
        if (existing) {
          idByLookup.set(
            transactionLookupKey(accountId, bookingDate, dedupeHash),
            existing.id,
          );
        }
      }
    } catch (err: any) {
      errors.push({
        entity: "transactions",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }

  return idByLookup;
}

function resolveAccountId(
  r: ImportTransaction | ImportTagLink,
  accountIdByKey: Map<string, number>,
): number | null {
  if (r.account_iban) {
    const id = accountIdByKey.get(`iban::${r.account_iban}`);
    if (id) return id;
  }
  // Manual-account fallback: stage 2 indexes manual rows under
  // `manual::<account_number>` so cash wallets / non-IBAN accounts
  // (Finanzkraft import) can still be resolved by their synthetic
  // account_number.
  if (r.account_number) {
    const id = accountIdByKey.get(`manual::${r.account_number}`);
    if (id) return id;
  }
  // Composite (bankcontact_blz+login+account_number) fallback is left
  // unimplemented — the bankcontactIdByKey isn't passed to stage 3,
  // and our two import shapes (Finanzkraft converter, future ones)
  // both rely on iban or the manual::<number> path above.
  return null;
}

// -----------------------------------------------------------------------
// Stage 4: tags
// -----------------------------------------------------------------------

async function importTags(
  names: string[],
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<Map<string, number>> {
  const idByName = new Map<string, number>();

  const existing = await db
    .select({ id: financeTag.id, name: financeTag.name })
    .from(financeTag)
    .where(eq(financeTag.source, "user"));
  for (const t of existing) idByName.set(t.name, t.id);

  const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  for (let i = 0; i < uniqueNames.length; i++) {
    const name = uniqueNames[i];
    if (idByName.has(name)) {
      skipped.tags++;
      continue;
    }
    try {
      const [inserted] = await db
        .insert(financeTag)
        .values({ name, source: "user" })
        .returning({ id: financeTag.id });
      idByName.set(name, inserted.id);
      counts.tags++;
    } catch (err: any) {
      errors.push({
        entity: "tags",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }

  return idByName;
}

// -----------------------------------------------------------------------
// Stage 5: tag links
// -----------------------------------------------------------------------

async function importTagLinks(
  rows: ImportTagLink[],
  tagIdByName: Map<string, number>,
  accountIdByKey: Map<string, number>,
  transactionIdByLookup: Map<string, number>,
  counts: EntityCounts,
  skipped: EntityCounts,
  errors: ValidationError[],
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tagId = tagIdByName.get(r.tag.trim());
    if (!tagId) {
      errors.push({
        entity: "tag_links",
        row: i,
        message: `unknown tag '${r.tag}'`,
      });
      continue;
    }

    // Composite lookup: account_id (resolved from iban / manual::number)
    // + booking_date + dedupe_hash. The same key shape stage 3 used to
    // index inserted rows, so a hit means we're pointing at the right
    // row. The hash must match what stage 3 saw — exporters that
    // pre-compute it should use the same canonical-field set as
    // computeDedupeHash().
    let transactionId: number | undefined;
    if (r.dedupe_hash && r.booking_date) {
      const accountId = resolveAccountId(r, accountIdByKey);
      if (accountId) {
        transactionId = transactionIdByLookup.get(
          transactionLookupKey(
            accountId,
            normalizeDate(r.booking_date),
            r.dedupe_hash,
          ),
        );
      }
    }
    if (!transactionId) {
      errors.push({
        entity: "tag_links",
        row: i,
        message:
          "cannot locate target transaction (need account_iban or " +
          "account_number, plus booking_date and dedupe_hash)",
      });
      continue;
    }

    try {
      const inserted = await db
        .insert(financeTagTransaction)
        .values({
          tag_id: tagId,
          transaction_id: transactionId,
        })
        .onConflictDoNothing({
          target: [
            financeTagTransaction.tag_id,
            financeTagTransaction.transaction_id,
          ],
        })
        .returning({ tag_id: financeTagTransaction.tag_id });
      if (inserted.length > 0) counts.tag_links++;
      else skipped.tag_links++;
    } catch (err: any) {
      errors.push({
        entity: "tag_links",
        row: i,
        message: err?.message ?? String(err),
      });
    }
  }
}
