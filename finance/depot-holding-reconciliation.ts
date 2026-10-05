/**
 * Holdings reconciliation (#1336, stage 4).
 *
 * The depot snapshots (FinTS HKWPD) say how many shares a depot held on a
 * day; the depot transactions say how many were bought, sold, booked in
 * or out. Between two snapshots the change in shares must equal what the
 * transactions in between moved — otherwise something happened that no
 * transaction records: a transfer, a savings-plan execution without a
 * settlement, a split, a missed document.
 *
 * Settlement lag makes "in between" fuzzy: a trade executed on Monday
 * shows up in Wednesday's snapshot. So transactions are not assigned to
 * the snapshot pair whose dates enclose them, but pooled and handed to
 * the next pair in which the amount actually changed. A trade is
 * explained by the first change after it, however many unchanged
 * snapshots lie between.
 *
 * The lag also runs the other way: a row derived from an account booking
 * carries the value date, which can fall a day or two after the snapshot
 * that already shows the trade. When the pooled transactions do not
 * explain a change, the ones dated up to LOOKAHEAD_DAYS after the snapshot
 * are taken too, but only if they then explain it exactly.
 *
 * A change the pooled transactions cannot be checked against — one of
 * them carries no quantity (a giro-derived row without its settlement),
 * or a split / corporate action is among them — is counted as
 * unverifiable, not reported as a gap.
 */

import { asc, inArray } from "drizzle-orm";

import db from "../db/database";
import { financeAccountHolding, financeDepotTransaction } from "../db/schema";

/** Shares below this are rounding noise, not a gap. */
const QUANTITY_EPSILON = 1e-6;
/** How far after a snapshot a transaction's date may lie and still explain it (value date after a weekend). */
export const LOOKAHEAD_DAYS = 5;

function daysAfter(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export interface SnapshotPoint {
  as_of: string;
  /** Shares held that day; 0 when the position is absent from a snapshot of the depot. */
  amount: number;
}

export interface ReconTx {
  executed_at: string;
  kind: string;
  amount: number | null;
}

export interface HoldingGap {
  account_id: number;
  position_key: string;
  /** Snapshot before the change. */
  from: string;
  /** Snapshot showing the change. */
  to: string;
  amount_before: string;
  amount_after: string;
  /** amount_after − amount_before (scale 8, signed). */
  delta: string;
  /** What the transactions in between moved (scale 8, signed). */
  explained: string;
  /** delta − explained: the shares no transaction accounts for. */
  unexplained: string;
  transaction_count: number;
}

export interface PositionReconciliation {
  gaps: HoldingGap[];
  /** Changes that could not be checked (a transaction lacks a quantity, or a split). */
  unverifiable: number;
}

/** Signed effect of a transaction on the share count, or null when unknown. */
function quantityEffect(tx: ReconTx): number | null | "unknown" {
  switch (tx.kind) {
    case "buy":
    case "in":
      return tx.amount === null ? "unknown" : Math.abs(tx.amount);
    case "sell":
    case "out":
      return tx.amount === null ? "unknown" : -Math.abs(tx.amount);
    case "split":
    case "corp_action":
      return "unknown";
    default:
      // dividend: no effect on the share count
      return null;
  }
}

function fmt(n: number): string {
  return (Math.abs(n) < QUANTITY_EPSILON ? 0 : n).toFixed(8);
}

/**
 * Walk one depot's snapshots of one position. `points` must be sorted by
 * date and contain one entry per snapshot day of the depot from the
 * position's first appearance on (0 where it is absent).
 */
export function reconcilePosition(
  accountId: number,
  positionKey: string,
  points: SnapshotPoint[],
  txs: ReconTx[],
): PositionReconciliation {
  const out: PositionReconciliation = { gaps: [], unverifiable: 0 };
  if (points.length < 2) return out;

  const first = points[0]!.as_of;
  // Trades on or before the first snapshot are part of its starting state.
  const pool = txs
    .filter((t) => t.executed_at > first)
    .sort((a, b) => (a.executed_at < b.executed_at ? -1 : a.executed_at > b.executed_at ? 1 : 0));
  let next = 0;
  const pending: ReconTx[] = [];

  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]!;
    const after = points[i]!;
    // Everything executed up to this snapshot is now waiting to be explained.
    while (next < pool.length && pool[next]!.executed_at <= after.as_of) {
      pending.push(pool[next]!);
      next++;
    }
    const delta = after.amount - before.amount;
    if (Math.abs(delta) < QUANTITY_EPSILON) continue;

    let explained = 0;
    let unknown = false;
    for (const tx of pending) {
      const effect = quantityEffect(tx);
      if (effect === "unknown") unknown = true;
      else if (effect !== null) explained += effect;
    }
    let count = pending.length;
    pending.length = 0;

    if (unknown) {
      out.unverifiable++;
      continue;
    }
    // Dated after the snapshot (a value date), but what makes it add up.
    if (Math.abs(delta - explained) >= QUANTITY_EPSILON) {
      let extra = 0;
      for (let k = next; k < pool.length && daysAfter(after.as_of, pool[k]!.executed_at) <= LOOKAHEAD_DAYS; k++) {
        const effect = quantityEffect(pool[k]!);
        if (effect === "unknown") break;
        if (effect !== null) extra += effect;
        if (Math.abs(delta - explained - extra) < QUANTITY_EPSILON) {
          explained += extra;
          count += k + 1 - next;
          next = k + 1;
          break;
        }
      }
    }
    const unexplained = delta - explained;
    if (Math.abs(unexplained) < QUANTITY_EPSILON) continue;
    out.gaps.push({
      account_id: accountId,
      position_key: positionKey,
      from: before.as_of,
      to: after.as_of,
      amount_before: fmt(before.amount),
      amount_after: fmt(after.amount),
      delta: fmt(delta),
      explained: fmt(explained),
      unexplained: fmt(unexplained),
      transaction_count: count,
    });
  }
  return out;
}

function keyOf(r: { isin: string | null; wkn: string | null; name: string | null }): string {
  return r.isin || r.wkn || r.name || "";
}

function day(raw: string): string {
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

/**
 * Reconcile every position of the given depots (optionally only one
 * position key). Returns the gaps newest first and the number of changes
 * that could not be checked.
 */
export async function reconcileHoldings(
  accountIds: number[],
  onlyKey: string | null = null,
): Promise<PositionReconciliation> {
  const result: PositionReconciliation = { gaps: [], unverifiable: 0 };
  if (accountIds.length === 0) return result;

  const [holdings, txs] = await Promise.all([
    db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
      })
      .from(financeAccountHolding)
      .where(inArray(financeAccountHolding.account_id, accountIds))
      .orderBy(asc(financeAccountHolding.as_of)),
    db
      .select({
        account_id: financeDepotTransaction.account_id,
        isin: financeDepotTransaction.isin,
        wkn: financeDepotTransaction.wkn,
        name: financeDepotTransaction.name,
        kind: financeDepotTransaction.kind,
        executed_at: financeDepotTransaction.executed_at,
        amount: financeDepotTransaction.amount,
      })
      .from(financeDepotTransaction)
      .where(inArray(financeDepotTransaction.account_id, accountIds)),
  ]);

  // Per depot: every snapshot day, and the amount per position per day.
  const daysByAccount = new Map<number, string[]>();
  const amounts = new Map<string, Map<string, number>>(); // `${account}|${key}` → day → amount
  for (const h of holdings) {
    const d = day(h.as_of);
    const days = daysByAccount.get(h.account_id) ?? [];
    if (days[days.length - 1] !== d) days.push(d);
    daysByAccount.set(h.account_id, days);
    const key = keyOf(h);
    if (!key || (onlyKey !== null && key !== onlyKey)) continue;
    const id = `${h.account_id}|${key}`;
    const byDay = amounts.get(id) ?? new Map<string, number>();
    const a = h.amount === null ? 0 : Number(h.amount);
    byDay.set(d, (byDay.get(d) ?? 0) + (Number.isFinite(a) ? a : 0));
    amounts.set(id, byDay);
  }

  const txsById = new Map<string, ReconTx[]>();
  for (const t of txs) {
    const key = keyOf(t);
    if (!key || (onlyKey !== null && key !== onlyKey)) continue;
    const id = `${t.account_id}|${key}`;
    const list = txsById.get(id) ?? [];
    const a = t.amount === null ? null : Number(t.amount);
    list.push({ executed_at: day(t.executed_at), kind: t.kind, amount: a !== null && Number.isFinite(a) ? a : null });
    txsById.set(id, list);
  }

  for (const [id, byDay] of amounts) {
    const sep = id.indexOf("|");
    const accountId = Number(id.slice(0, sep));
    const key = id.slice(sep + 1);
    const days = daysByAccount.get(accountId) ?? [];
    const firstSeen = [...byDay.keys()].sort()[0]!;
    const points: SnapshotPoint[] = days
      .filter((d) => d >= firstSeen)
      .map((d) => ({ as_of: d, amount: byDay.get(d) ?? 0 }));
    const r = reconcilePosition(accountId, key, points, txsById.get(id) ?? []);
    result.gaps.push(...r.gaps);
    result.unverifiable += r.unverifiable;
  }

  result.gaps.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
  return result;
}
