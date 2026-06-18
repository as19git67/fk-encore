/**
 * Persists a `FetchResult` from `fints-client.runFetchAccounts` into
 * the DB. Called after a successful sync (manual trigger,
 * TAN-complete, or cron).
 *
 * Match semantics (since the manual-account flow landed):
 *   - Snapshots are looked up by `(bankcontact_id, fints_account_number
 *     = snapshot.accountNumber)`. Matching finance_account rows get
 *     transactions + balance written.
 *   - Unknown snapshots (no matching linked row) are NOT auto-created.
 *     They're collected in `unknown` so the UI can offer the user a
 *     choice: link to an existing manual account, import as a new
 *     account, or ignore.
 *
 * What gets written for a *matched* account:
 *   - `finance_transaction`: inserted with `onConflictDoNothing` on
 *     the `(account_id, dedupe_hash)` unique index the importer uses.
 *     `dedupe_hash` is SHA-256 over the canonical fields so a re-sync
 *     is a no-op.
 *   - `finance_account_balance`: one row per account per sync,
 *     `source='fints'`. Conflict on `(account_id, as_of)` — we bump
 *     `as_of` to `now()` to avoid colliding with a balance the bank
 *     reported at midnight on the same day.
 *
 * KI-tag suggestion: every newly inserted transaction triggers
 * `suggestTagsForTransaction` on a best-effort basis (same contract
 * as the manual-booking path in `transactions.ts`).
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeTransaction,
} from "../db/schema";
import type { FetchResult, FintsHoldingData, FintsTransactionData } from "./types";
import { enqueueTagSuggestion } from "./tag-queue";
import { triggerTagWorker } from "./tag-worker";
import type { PaypalBalance, PaypalTransaction } from "./paypal-client";

console.log("[boot] finance/statement-persist.ts: all imports resolved");

/**
 * A bank-side account the sync saw but couldn't map to any linked
 * finance_account. Passed up to the UI so the user can decide
 * account-by-account whether to link or import.
 */
export interface UnknownAccount {
  accountNumber: string;
  iban: string | null;
  accountKind: string;
  currency: string;
  label: string;
  balance: { asOf: string; amount: string; currency: string } | null;
  /** Per-account error strings from the fetch path (e.g. tan-required). */
  errors: string[];
}

export interface PersistStats {
  accounts_seen: number;
  accounts_matched: number;
  /** Matched accounts that were skipped because they are closed. */
  accounts_closed: number;
  accounts_unknown: number;
  transactions_inserted: number;
  transactions_skipped_duplicate: number;
  balances_written: number;
  holdings_written: number;
  unknown: UnknownAccount[];
  errors: string[];
}

export async function persistFetchResult(
  bankcontactId: number,
  result: FetchResult,
): Promise<PersistStats> {
  const stats: PersistStats = {
    accounts_seen: 0,
    accounts_matched: 0,
    accounts_closed: 0,
    accounts_unknown: 0,
    transactions_inserted: 0,
    transactions_skipped_duplicate: 0,
    balances_written: 0,
    holdings_written: 0,
    unknown: [],
    errors: [],
  };

  // ---- Phase 1: gather candidates and exact-match by kind ----
  type Candidate = { id: number; closed_at: string | null; kind: string };
  type SnapshotEntry = {
    snapshot: FetchResult["accounts"][number];
    candidates: Candidate[];
    matched: Candidate | undefined;
  };

  const entries: SnapshotEntry[] = [];
  const claimedIds = new Set<number>();

  for (const snapshot of result.accounts) {
    stats.accounts_seen++;

    for (const e of snapshot.errors) {
      stats.errors.push(`account ${snapshot.accountNumber}: ${e}`);
    }

    const candidates = await db
      .select({
        id: financeAccount.id,
        closed_at: financeAccount.closed_at,
        kind: financeAccountType.kind,
      })
      .from(financeAccount)
      .innerJoin(
        financeAccountType,
        eq(financeAccount.type_id, financeAccountType.id),
      )
      .where(
        and(
          eq(financeAccount.bankcontact_id, bankcontactId),
          eq(financeAccount.fints_account_number, snapshot.accountNumber),
        ),
      );

    const exactMatch = candidates.find((c) => c.kind === snapshot.accountKind);
    if (exactMatch) claimedIds.add(exactMatch.id);
    entries.push({ snapshot, candidates, matched: exactMatch });
  }

  // ---- Phase 2: fallback for unmatched snapshots ----
  // When a snapshot's kind doesn't exactly match any candidate (e.g. the
  // bank reports "sonstige" but the user imported the account as "giro"),
  // fall back to the sole unclaimed candidate for that account number.
  // "Unclaimed" means no other snapshot already matched it by exact kind,
  // so a depot snapshot can never steal the giro's row.
  for (const entry of entries) {
    if (entry.matched) continue;
    const unclaimed = entry.candidates.filter((c) => !claimedIds.has(c.id));
    if (unclaimed.length === 1) {
      entry.matched = unclaimed[0];
      claimedIds.add(unclaimed[0].id);
    }
  }

  // ---- Phase 3: process each snapshot ----
  for (const { snapshot, matched } of entries) {
    if (matched?.closed_at) {
      stats.accounts_closed++;
      stats.errors.push(
        `account ${snapshot.accountNumber}: skipped, account is closed`,
      );
      continue;
    }

    if (!matched) {
      stats.accounts_unknown++;
      stats.unknown.push({
        accountNumber: snapshot.accountNumber,
        iban: snapshot.iban ?? null,
        accountKind: snapshot.accountKind,
        currency: snapshot.currency,
        label: snapshot.label,
        balance: snapshot.balance
          ? {
              asOf: snapshot.balance.asOf,
              amount: snapshot.balance.amount,
              currency: snapshot.balance.currency,
            }
          : null,
        errors: snapshot.errors,
      });
      continue;
    }
    stats.accounts_matched++;
    const accountId = matched.id;

    // ---- Insert transactions ----
    const freshlyInsertedIds: number[] = [];
    for (const tx of snapshot.transactions) {
      const dedupeHash = computeDedupeHash(tx);
      try {
        const inserted = await db
          .insert(financeTransaction)
          .values({
            account_id: accountId,
            booking_date: tx.bookingDate,
            value_date: tx.valueDate,
            amount: tx.amount,
            currency_code: tx.currency.toUpperCase(),
            purpose: tx.purpose,
            counterparty: tx.counterparty,
            counterparty_iban: tx.counterpartyIban,
            counterparty_bic: tx.counterparty_bic,
            counterparty_bank_id: tx.counterparty_bank_id,
            end_to_end_ref: tx.end_to_end_ref,
            mandate_ref: tx.mandate_ref,
            creditor_id: tx.creditor_id,
            originator_name: tx.originator_name,
            recipient_name: tx.recipient_name,
            funds_code: tx.funds_code,
            transaction_type: tx.transaction_type,
            transaction_code: tx.transaction_code,
            entry_text: tx.entry_text,
            prima_nota_no: tx.prima_nota_no,
            bank_ref: tx.bankRef,
            original_amount: tx.originalAmount ?? undefined,
            original_currency_code: tx.originalCurrency ?? undefined,
            exchange_rate: tx.exchangeRate ?? undefined,
            dedupe_hash: dedupeHash,
            raw: tx.raw,
          })
          .onConflictDoNothing({
            target: [
              financeTransaction.account_id,
              financeTransaction.dedupe_hash,
            ],
          })
          .returning({ id: financeTransaction.id });
        if (inserted.length > 0) {
          stats.transactions_inserted++;
          freshlyInsertedIds.push(inserted[0].id);
        } else {
          stats.transactions_skipped_duplicate++;
        }
      } catch (err) {
        stats.errors.push(
          `account ${snapshot.accountNumber}: tx insert failed: ` +
            ((err as Error).message ?? String(err)),
        );
      }
    }

    // Enqueue AI tag suggestion for each fresh transaction — best-effort.
    try {
      for (const id of freshlyInsertedIds) {
        await enqueueTagSuggestion(id);
      }
      if (freshlyInsertedIds.length > 0) triggerTagWorker();
    } catch (err) {
      console.error(`[finance] failed to enqueue tag suggestions:`, (err as Error).message);
    }

    // ---- Write the balance ----
    if (snapshot.balance) {
      const nowIso = new Date().toISOString();
      try {
        await db
          .insert(financeAccountBalance)
          .values({
            account_id: accountId,
            as_of: nowIso,
            balance: snapshot.balance.amount,
            source: "fints",
            currency_code: snapshot.balance.currency.toUpperCase(),
          })
          .onConflictDoNothing({
            target: [
              financeAccountBalance.account_id,
              financeAccountBalance.as_of,
              financeAccountBalance.currency_code,
            ],
          });
        stats.balances_written++;
      } catch (err) {
        stats.errors.push(
          `account ${snapshot.accountNumber}: balance insert failed: ` +
            ((err as Error).message ?? String(err)),
        );
      }
    }

    // ---- Write holdings (depot accounts) ----
    if (snapshot.holdings && snapshot.holdings.length > 0 && snapshot.balance) {
      const asOfDate = snapshot.balance.asOf;
      for (const h of snapshot.holdings) {
        try {
          await db.execute(sql`
            INSERT INTO finance_account_holding
              (account_id, as_of, isin, wkn, name, amount, price, value, currency,
               acquisition_date, acquisition_price)
            VALUES (
              ${accountId}, ${asOfDate}::date,
              ${h.isin}, ${h.wkn}, ${h.name},
              ${h.amount}, ${h.price}, ${h.value}, ${h.currency},
              ${h.acquisitionDate ? sql`${h.acquisitionDate}::date` : sql`NULL`},
              ${h.acquisitionPrice}
            )
            ON CONFLICT (account_id, as_of, COALESCE(isin, wkn, name))
            DO UPDATE SET
              amount = EXCLUDED.amount,
              price  = EXCLUDED.price,
              value  = EXCLUDED.value,
              currency = EXCLUDED.currency,
              acquisition_date  = EXCLUDED.acquisition_date,
              acquisition_price = EXCLUDED.acquisition_price
          `);
          stats.holdings_written++;
        } catch (err) {
          stats.errors.push(
            `account ${snapshot.accountNumber}: holding upsert failed ` +
              `(${h.isin ?? h.wkn ?? h.name}): ` +
              ((err as Error).message ?? String(err)),
          );
        }
      }
    }
  }

  return stats;
}

function computeDedupeHash(tx: FintsTransactionData): string {
  const canonical = [
    tx.bookingDate,
    tx.valueDate ?? "",
    tx.amount,
    tx.currency.toUpperCase(),
    tx.purpose ?? "",
    tx.counterparty ?? "",
    tx.counterpartyIban ?? "",
    tx.bankRef ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// PayPal persistence (Issue #427, Etappe 6).
//
// PayPal returns the *wallet* state: balances per held currency and a
// flat list of transactions. We match the wallet to its single
// finance_account via `bankcontact_id` (the OAuth callback ensures one
// such row exists on first connect) and treat the run like a per-
// account FinTS persist:
//
//   - one finance_transaction row per PayPal transaction, dedupe_hash
//     = PayPal's `transaction_id` (stable, opaque, globally unique).
//   - one finance_account_balance row per currency, source="paypal".
// ---------------------------------------------------------------------------

export interface PaypalSnapshot {
  balances: PaypalBalance[];
  transactions: PaypalTransaction[];
}

/**
 * Persists a PayPal sync result for a single bankcontact. Returns the
 * same PersistStats shape as FinTS so the API caller's existing
 * response mapping continues to work.
 */
export async function persistPaypalSnapshot(
  bankcontactId: number,
  snapshot: PaypalSnapshot,
): Promise<PersistStats> {
  const stats: PersistStats = {
    accounts_seen: 1,
    accounts_matched: 0,
    accounts_closed: 0,
    accounts_unknown: 0,
    transactions_inserted: 0,
    transactions_skipped_duplicate: 0,
    balances_written: 0,
    holdings_written: 0,
    unknown: [],
    errors: [],
  };

  const [account] = await db
    .select({
      id: financeAccount.id,
      closed_at: financeAccount.closed_at,
      currency_code: financeAccount.currency_code,
    })
    .from(financeAccount)
    .where(eq(financeAccount.bankcontact_id, bankcontactId))
    .limit(1);

  if (!account) {
    stats.accounts_unknown = 1;
    const primary = snapshot.balances.find((b) => b.primary) ?? snapshot.balances[0];
    stats.unknown.push({
      accountNumber: "",
      iban: null,
      accountKind: "giro",
      currency: primary?.currency ?? "EUR",
      label: "PayPal",
      balance: primary
        ? { asOf: primary.asOf, amount: primary.total, currency: primary.currency }
        : null,
      errors: [],
    });
    return stats;
  }
  if (account.closed_at) {
    stats.accounts_closed = 1;
    stats.errors.push("PayPal wallet: skipped, account is closed");
    return stats;
  }
  stats.accounts_matched = 1;
  const accountId = account.id;

  // ---- Insert transactions ----
  const freshlyInsertedIds: number[] = [];
  for (const tx of snapshot.transactions) {
    try {
      const inserted = await db
        .insert(financeTransaction)
        .values({
          account_id: accountId,
          booking_date: dateOnly(tx.bookingDate),
          value_date: tx.valueDate ? dateOnly(tx.valueDate) : null,
          amount: normalizeAmount(tx.amount),
          currency_code: tx.currency.toUpperCase(),
          purpose: tx.purpose,
          counterparty: tx.counterparty,
          counterparty_iban: null,
          counterparty_bic: null,
          counterparty_bank_id: null,
          end_to_end_ref: null,
          mandate_ref: null,
          creditor_id: null,
          originator_name: null,
          recipient_name: null,
          funds_code: null,
          transaction_type: tx.eventCode,
          transaction_code: null,
          entry_text: null,
          prima_nota_no: null,
          bank_ref: tx.transactionId,
          dedupe_hash: tx.transactionId,
          raw: tx.raw,
        })
        .onConflictDoNothing({
          target: [
            financeTransaction.account_id,
            financeTransaction.dedupe_hash,
          ],
        })
        .returning({ id: financeTransaction.id });
      if (inserted.length > 0) {
        stats.transactions_inserted++;
        freshlyInsertedIds.push(inserted[0].id);
      } else {
        stats.transactions_skipped_duplicate++;
      }
    } catch (err) {
      stats.errors.push(
        `paypal tx ${tx.transactionId}: insert failed: ` +
          ((err as Error).message ?? String(err)),
      );
    }
  }

  // Same fire-and-forget tag suggestion as FinTS.
  try {
    for (const id of freshlyInsertedIds) {
      await enqueueTagSuggestion(id);
    }
    if (freshlyInsertedIds.length > 0) triggerTagWorker();
  } catch (err) {
    console.error(`[finance] failed to enqueue tag suggestions:`, (err as Error).message);
  }

  // ---- Write balances ----
  // PayPal can return several currencies under one as_of. We persist
  // each as its own row keyed by (account_id, as_of, currency_code).
  const nowIso = new Date().toISOString();
  for (const b of snapshot.balances) {
    try {
      await db
        .insert(financeAccountBalance)
        .values({
          account_id: accountId,
          as_of: nowIso,
          balance: normalizeAmount(b.total),
          source: "paypal",
          currency_code: b.currency.toUpperCase(),
        })
        .onConflictDoNothing({
          target: [
            financeAccountBalance.account_id,
            financeAccountBalance.as_of,
            financeAccountBalance.currency_code,
          ],
        });
      stats.balances_written++;
    } catch (err) {
      stats.errors.push(
        `paypal balance (${b.currency}): insert failed: ` +
          ((err as Error).message ?? String(err)),
      );
    }
  }

  return stats;
}

/** PayPal sends ISO-8601 datetimes; finance_transaction.booking_date
 *  stores the date part (mode:"string"), so we slice. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** finance_transaction.amount is numeric(12,2) — coerce PayPal's
 *  free-form decimal strings (which may have any precision) into a
 *  two-decimal representation so insert doesn't trip over precision. */
function normalizeAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toFixed(2);
}
