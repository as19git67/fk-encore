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
import { and, eq } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountBalance,
  financeTransaction,
} from "../db/schema";
import type { FetchResult, FintsTransactionData } from "./types";
import { enqueueTagSuggestion } from "./tag-queue";
import { triggerTagWorker } from "./tag-worker";

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
  accounts_unknown: number;
  transactions_inserted: number;
  transactions_skipped_duplicate: number;
  balances_written: number;
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
    accounts_unknown: 0,
    transactions_inserted: 0,
    transactions_skipped_duplicate: 0,
    balances_written: 0,
    unknown: [],
    errors: [],
  };

  for (const snapshot of result.accounts) {
    stats.accounts_seen++;

    // Forward per-account soft errors (tan-required, bank answers) so
    // the caller can surface them in the sync response.
    for (const e of snapshot.errors) {
      stats.errors.push(`account ${snapshot.accountNumber}: ${e}`);
    }

    // Look up the linked finance_account, if any.
    const [matched] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(
        and(
          eq(financeAccount.bankcontact_id, bankcontactId),
          eq(financeAccount.fints_account_number, snapshot.accountNumber),
        ),
      )
      .limit(1);

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
            bank_ref: tx.bankRef,
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

    // Enqueue AI tag suggestion for each fresh transaction. The worker
    // processes them asynchronously so a slow llm-service never blocks the sync.
    for (const id of freshlyInsertedIds) {
      await enqueueTagSuggestion(id);
    }
    if (freshlyInsertedIds.length > 0) triggerTagWorker();

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
          })
          .onConflictDoNothing({
            target: [
              financeAccountBalance.account_id,
              financeAccountBalance.as_of,
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
    tx.counterpartyIban ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
