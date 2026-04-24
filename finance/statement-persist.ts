/**
 * Persists a `FetchResult` from `fints-client.runFetchAccounts` into
 * the DB. Called after a successful sync (manual trigger,
 * TAN-complete, or cron).
 *
 * What gets written:
 *   - `finance_account`: auto-created on first sighting (keyed by
 *     `(bankcontact_id, account_number)`). Existing rows are
 *     left alone — even if the bank has updated metadata — to avoid
 *     clobbering user-set labels.
 *   - `finance_transaction`: inserted with `onConflictDoNothing` on
 *     the same `(account_id, dedupe_hash)` unique index the importer
 *     uses. `dedupe_hash` is SHA-256 over the canonical fields so a
 *     re-sync is a no-op.
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
  financeAccountAccess,
  financeAccountBalance,
  financeAccountKindEnum,
  financeAccountType,
  financeTransaction,
} from "../db/schema";
import type { FetchResult, FintsTransactionData } from "./types";
import { suggestTagsForTransaction } from "./tag-suggester";

console.log("[boot] finance/statement-persist.ts: all imports resolved");

export interface PersistStats {
  accounts_seen: number;
  accounts_created: number;
  transactions_inserted: number;
  transactions_skipped_duplicate: number;
  balances_written: number;
  acl_grants: number;
  errors: string[];
}

export interface PersistOptions {
  /**
   * When set, every newly-auto-created finance_account gets a
   * `write`-level ACL entry for this user id. Without this, the
   * freshly-seen account would stay invisible to non-admin callers
   * (the ACL join filters them out of /finance/accounts).
   *
   * Manual-trigger callers pass the getAuthData().userID; the cron
   * passes the "responsible user" picked from the existing ACL. When
   * neither is available (cold start through an uncommon path) the
   * caller can omit the field and have a finance.admin user grant
   * access afterwards via AccountAssignmentView.
   */
  grantAclToUserId?: number;
}

export async function persistFetchResult(
  bankcontactId: number,
  result: FetchResult,
  opts: PersistOptions = {},
): Promise<PersistStats> {
  const stats: PersistStats = {
    accounts_seen: 0,
    accounts_created: 0,
    transactions_inserted: 0,
    transactions_skipped_duplicate: 0,
    balances_written: 0,
    acl_grants: 0,
    errors: [],
  };

  // Preload the account-type id per finance_account_kind enum value so
  // we can auto-create finance_account rows without a per-insert query.
  const typeRows = await db.select().from(financeAccountType);
  const typeIdByKind = new Map(typeRows.map((t) => [t.kind as string, t.id]));

  for (const snapshot of result.accounts) {
    stats.accounts_seen++;

    // ---- Find or auto-create the account ----
    let accountId: number;
    const [existing] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(
        and(
          eq(financeAccount.bankcontact_id, bankcontactId),
          eq(financeAccount.account_number, snapshot.accountNumber),
        ),
      )
      .limit(1);

    if (existing) {
      accountId = existing.id;
    } else {
      const kind =
        (financeAccountKindEnum.enumValues as readonly string[]).includes(
          snapshot.accountKind,
        )
          ? snapshot.accountKind
          : "sonstige";
      const typeId = typeIdByKind.get(kind);
      if (!typeId) {
        stats.errors.push(
          `account ${snapshot.accountNumber}: finance_account_type ` +
            `seed missing for '${kind}'`,
        );
        continue;
      }
      try {
        const [inserted] = await db
          .insert(financeAccount)
          .values({
            bankcontact_id: bankcontactId,
            type_id: typeId,
            currency_code: snapshot.currency.toUpperCase(),
            iban: snapshot.iban ?? null,
            account_number: snapshot.accountNumber,
            label: snapshot.label,
          })
          .returning({ id: financeAccount.id });
        accountId = inserted.id;
        stats.accounts_created++;

        // Auto-grant write ACL to the user who drove the sync so the
        // freshly seen account is immediately visible in their
        // AccountsView. Conflict target covers the (account,user)
        // unique; a race where another concurrent sync wrote the row
        // first is a no-op.
        if (opts.grantAclToUserId !== undefined) {
          try {
            const granted = await db
              .insert(financeAccountAccess)
              .values({
                account_id: accountId,
                user_id: opts.grantAclToUserId,
                level: "write",
              })
              .onConflictDoNothing({
                target: [
                  financeAccountAccess.account_id,
                  financeAccountAccess.user_id,
                ],
              })
              .returning({ account_id: financeAccountAccess.account_id });
            if (granted.length > 0) stats.acl_grants++;
          } catch (err) {
            stats.errors.push(
              `account ${snapshot.accountNumber}: acl grant failed: ` +
                ((err as Error).message ?? String(err)),
            );
          }
        }
      } catch (err) {
        stats.errors.push(
          `account ${snapshot.accountNumber}: create failed: ` +
            ((err as Error).message ?? String(err)),
        );
        continue;
      }
    }

    // Forward per-account soft errors (tan-required, bank answers) so
    // the caller can surface them in the sync response.
    for (const e of snapshot.errors) {
      stats.errors.push(`account ${snapshot.accountNumber}: ${e}`);
    }

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
            fints_id: tx.fintsId,
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

    // Kick off KI-tag suggestion for each fresh row — best effort,
    // errors are already swallowed inside suggestTagsForTransaction.
    for (const id of freshlyInsertedIds) {
      void suggestTagsForTransaction(id);
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
