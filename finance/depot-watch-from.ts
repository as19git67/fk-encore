/**
 * The day from which a depot is looked at.
 *
 * A depot moved between banks, or whose papers reach back decades, holds
 * history the user does not want to account for: a yearly statement from
 * long ago lists securities sold since, and the holdings reconciliation
 * then reports every one of them as a gap. With a start day set, nothing
 * before it counts:
 *
 *   - Setting the day deletes what was read in before it — holdings rows
 *     (bank or statement) and transactions created from papers or derived
 *     from bookings. The papers stay in the documents module; moving the
 *     day back and reading them again brings the rows back.
 *   - Readers do not take anything in before it: a statement stating an
 *     earlier day, a settlement executed earlier, a booking made earlier.
 *   - Transactions entered by hand are never deleted; the reconciliation,
 *     the performance and the portfolio leave those before the day out.
 */

import { and, eq, inArray, lt, notLike, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import db from "../db/database";
import { financeAccount, financeAccountHolding, financeDepotTransaction } from "../db/schema";

/** account → first day looked at (YYYY-MM-DD); depots without one are absent. */
export async function watchFromByAccount(accountIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ id: financeAccount.id, watch_from: financeAccount.watch_from })
    .from(financeAccount)
    .where(inArray(financeAccount.id, accountIds));
  for (const r of rows) if (r.watch_from) out.set(r.id, r.watch_from.slice(0, 10));
  return out;
}

/** Whether a day (YYYY-MM-DD or a timestamp) lies before the depot's start day. */
export function beforeWatch(watch: ReadonlyMap<number, string>, accountId: number, day: string | null | undefined): boolean {
  const from = watch.get(accountId);
  return from !== undefined && !!day && day.slice(0, 10) < from;
}

/** The start day of one depot, or null. */
export async function watchFromOf(accountId: number): Promise<string | null> {
  return (await watchFromByAccount([accountId])).get(accountId) ?? null;
}

/**
 * SQL condition: the row's day is not before its depot's start day. For
 * queries over holdings or transactions, with the row's account and day
 * column.
 */
export function notBeforeWatch(accountColumn: PgColumn, dayColumn: PgColumn): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM finance_account wf
    WHERE wf.id = ${accountColumn}
      AND wf.watch_from IS NOT NULL
      AND ${dayColumn}::date < wf.watch_from
  )`;
}

export interface WatchFromResult {
  account_id: number;
  watch_from: string | null;
  /** Holdings rows deleted because they lie before the day. */
  holdings_removed: number;
  /** Transactions from papers or bookings deleted because they lie before the day. */
  transactions_removed: number;
}

/** Set (or clear) a depot's start day and delete what was read in before it. */
export async function setWatchFrom(accountId: number, day: string | null): Promise<WatchFromResult> {
  const result: WatchFromResult = { account_id: accountId, watch_from: day, holdings_removed: 0, transactions_removed: 0 };
  await db.transaction(async (tx) => {
    await tx.update(financeAccount).set({ watch_from: day }).where(eq(financeAccount.id, accountId));
    if (day === null) return;
    const holdings = await tx
      .delete(financeAccountHolding)
      .where(and(eq(financeAccountHolding.account_id, accountId), lt(financeAccountHolding.as_of, day)))
      .returning({ id: financeAccountHolding.id });
    result.holdings_removed = holdings.length;
    const txs = await tx
      .delete(financeDepotTransaction)
      .where(
        and(
          eq(financeDepotTransaction.account_id, accountId),
          lt(financeDepotTransaction.executed_at, day),
          notLike(financeDepotTransaction.source, "manual%"),
        ),
      )
      .returning({ id: financeDepotTransaction.id });
    result.transactions_removed = txs.length;
  });
  return result;
}
