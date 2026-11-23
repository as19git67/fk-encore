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
 * or a split without a quantity / a corporate action is among them — is
 * counted as unverifiable, not reported as a gap. A split booked with a
 * quantity moves the share count by that (signed) quantity, as in the
 * performance calculation.
 *
 * A stock split nobody booked multiplies the shares held before it, and
 * trades before it are in the old count, trades after it in the new one.
 * Summing them cannot explain the change, and worse: the lookahead, which
 * only takes trades that make a change add up exactly, then leaves a trade
 * dated just after the snapshot to the next pair, which shows it as a
 * second, opposite gap. So when the sum does not explain a change, the
 * walk tries the usual split ratios (SPLIT_RATIOS, both ways) with every
 * point the split could fall between the pooled trades (and the ones the
 * lookahead may take). A ratio that makes the change add up exactly is
 * reported as the gap's `split_ratio` — still a gap, since no transaction
 * records it, but named, and the trades it needs are taken here, not
 * handed on.
 *
 * A position missing from a statement that still names it in its holdings
 * (a row OCR garbled) was not read that day, not sold: the day is left out
 * for it instead of counting as 0.
 *
 * Nothing before the depot's start day counts (see depot-watch-from):
 * an old yearly statement would otherwise open every position it lists.
 *
 * A security the depot ignores (taken out by the user, or a proposal
 * turned down) is left out: its read transactions are gone, so the
 * bank's old snapshots of it would otherwise show as gaps forever.
 */

import { and, asc, inArray } from "drizzle-orm";

import db from "../db/database";
import { documents, financeAccountHolding, financeDepotTransaction } from "../db/schema";
import { statementNamesPosition } from "./depot-statement-parser";
import { ignoredSecurities, isIgnoredIn } from "./depot-securities";
import { notBeforeWatch } from "./depot-watch-from";
import { dedupeSnapshotRows, securityIdentity } from "./security-identity";

/** Shares below this are rounding noise, not a gap. */
const QUANTITY_EPSILON = 1e-6;
/** How far after a snapshot a transaction's date may lie and still explain it (value date after a weekend). */
export const LOOKAHEAD_DAYS = 5;
/** Shares per old share a split usually gives; the reverse ratios (1/n) are tried too. */
export const SPLIT_RATIOS = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 50, 100];

function daysAfter(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export interface SnapshotPoint {
  as_of: string;
  /** Shares held that day; 0 when the position is absent from a snapshot of the depot. */
  amount: number;
  /** The depot statement the figure was read from; null for the bank's sync or an absent position. */
  document_id?: number | null;
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
  /** The depot statements the two snapshots were read from (null: the bank's sync, or not listed). */
  from_document_id: number | null;
  to_document_id: number | null;
  amount_before: string;
  amount_after: string;
  /** amount_after − amount_before (scale 8, signed). */
  delta: string;
  /** What the transactions in between moved (scale 8, signed). */
  explained: string;
  /** delta − explained: the shares no transaction accounts for. */
  unexplained: string;
  transaction_count: number;
  /**
   * New shares per old share of a split nobody booked, when one makes the
   * change add up exactly (4 = one share became four, 0.25 = four became
   * one); null otherwise. `unexplained` is then the split's effect.
   */
  split_ratio: number | null;
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
      // A split booked with a quantity: the change in the share count.
      return tx.amount === null ? "unknown" : tx.amount;
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
 * A split that makes `before` → `after` add up with the given trades: the
 * trades are in date order (`pooled`, then the ones dated just after the
 * snapshot, `ahead`, of which only a leading run may be taken). The split
 * falls between two trades; the shares held up to it are multiplied by the
 * ratio. Fewest trades taken from `ahead` first, then the latest split
 * point, then the smaller ratio.
 */
export function findSplit(
  before: number,
  after: number,
  pooled: number[],
  ahead: number[] = [],
): { ratio: number; ahead: number } | null {
  if (before <= QUANTITY_EPSILON || after <= QUANTITY_EPSILON) return null;
  const ratios = SPLIT_RATIOS.flatMap((n) => [n, 1 / n]);
  for (let m = 0; m <= ahead.length; m++) {
    const trades = [...pooled, ...ahead.slice(0, m)];
    const total = trades.reduce((a, b) => a + b, 0);
    let held = before + total; // shares before the split when it falls after every trade
    let later = 0; // trades after the split point
    for (let cut = trades.length; cut >= 0; cut--) {
      if (cut < trades.length) {
        held -= trades[cut]!;
        later += trades[cut]!;
      }
      if (held <= QUANTITY_EPSILON) continue;
      for (const ratio of ratios) {
        // Whole new shares per old one: compare with a tolerance that scales with the holding.
        if (Math.abs(held * ratio + later - after) < Math.max(QUANTITY_EPSILON, after * 1e-9)) {
          return { ratio, ahead: m };
        }
      }
    }
  }
  return null;
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
    const movedShares: number[] = [];
    for (const tx of pending) {
      const effect = quantityEffect(tx);
      if (effect === "unknown") unknown = true;
      else if (effect !== null) {
        explained += effect;
        movedShares.push(effect);
      }
    }
    let count = pending.length;
    pending.length = 0;

    if (unknown) {
      out.unverifiable++;
      continue;
    }
    // Dated after the snapshot (a value date), but what makes it add up.
    const ahead: number[] = [];
    if (Math.abs(delta - explained) >= QUANTITY_EPSILON) {
      let extra = 0;
      for (let k = next; k < pool.length && daysAfter(after.as_of, pool[k]!.executed_at) <= LOOKAHEAD_DAYS; k++) {
        const effect = quantityEffect(pool[k]!);
        if (effect === "unknown") break;
        ahead.push(effect ?? 0);
        if (effect !== null) extra += effect;
        if (Math.abs(delta - explained - extra) < QUANTITY_EPSILON) {
          explained += extra;
          count += k + 1 - next;
          next = k + 1;
          ahead.length = 0;
          break;
        }
      }
    }
    let splitRatio: number | null = null;
    if (Math.abs(delta - explained) >= QUANTITY_EPSILON) {
      const split = findSplit(before.amount, after.amount, movedShares, ahead);
      if (split) {
        splitRatio = split.ratio;
        for (let k = 0; k < split.ahead; k++) explained += ahead[k]!;
        count += split.ahead;
        next += split.ahead;
      }
    }
    const unexplained = delta - explained;
    if (Math.abs(unexplained) < QUANTITY_EPSILON) continue;
    out.gaps.push({
      account_id: accountId,
      position_key: positionKey,
      from: before.as_of,
      to: after.as_of,
      from_document_id: before.document_id ?? null,
      to_document_id: after.document_id ?? null,
      amount_before: fmt(before.amount),
      amount_after: fmt(after.amount),
      delta: fmt(delta),
      explained: fmt(explained),
      unexplained: fmt(unexplained),
      transaction_count: count,
      split_ratio: splitRatio,
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

  const [rawHoldings, rawTxs, ignored, identity] = await Promise.all([
    db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        source: financeAccountHolding.source,
        document_id: financeAccountHolding.document_id,
      })
      .from(financeAccountHolding)
      .where(
        and(
          inArray(financeAccountHolding.account_id, accountIds),
          notBeforeWatch(financeAccountHolding.account_id, financeAccountHolding.as_of),
        ),
      )
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
      .where(
        and(
          inArray(financeDepotTransaction.account_id, accountIds),
          notBeforeWatch(financeDepotTransaction.account_id, financeDepotTransaction.executed_at),
        ),
      ),
    ignoredSecurities(accountIds),
    securityIdentity(),
  ]);
  // One identity per security: the bank's WKN row and a statement's ISIN
  // row of the same day are one holding, not a sale and a buy.
  const holdings = dedupeSnapshotRows(rawHoldings.map((h) => identity.complete(h))).sort((a, b) =>
    a.as_of < b.as_of ? -1 : a.as_of > b.as_of ? 1 : 0,
  );
  const txs = rawTxs.map((t) => identity.complete(t));

  // Per depot: every snapshot day, and the amount per position per day.
  const daysByAccount = new Map<number, string[]>();
  const amounts = new Map<string, Map<string, number>>(); // `${account}|${key}` → day → amount
  const papers = new Map<string, Map<string, number>>(); // `${account}|${key}` → day → statement document
  // A day the position is absent from: the statement that leaves it out.
  const dayPapers = new Map<number, Map<string, number>>(); // account → day → statement document
  for (const h of holdings) {
    const d = day(h.as_of);
    const days = daysByAccount.get(h.account_id) ?? [];
    if (days[days.length - 1] !== d) days.push(d);
    daysByAccount.set(h.account_id, days);
    if (h.document_id != null) {
      const docs = dayPapers.get(h.account_id) ?? new Map<string, number>();
      if (!docs.has(d)) docs.set(d, h.document_id);
      dayPapers.set(h.account_id, docs);
    }
    const key = keyOf(h);
    if (!key || (onlyKey !== null && key !== onlyKey)) continue;
    if (isIgnoredIn(ignored, h.account_id, h)) continue;
    const id = `${h.account_id}|${key}`;
    const byDay = amounts.get(id) ?? new Map<string, number>();
    const a = h.amount === null ? 0 : Number(h.amount);
    byDay.set(d, (byDay.get(d) ?? 0) + (Number.isFinite(a) ? a : 0));
    amounts.set(id, byDay);
    if (h.document_id != null) {
      const docs = papers.get(id) ?? new Map<string, number>();
      docs.set(d, h.document_id);
      papers.set(id, docs);
    }
  }

  const txsById = new Map<string, ReconTx[]>();
  for (const t of txs) {
    const key = keyOf(t);
    if (!key || (onlyKey !== null && key !== onlyKey)) continue;
    if (isIgnoredIn(ignored, t.account_id, t)) continue;
    const id = `${t.account_id}|${key}`;
    const list = txsById.get(id) ?? [];
    const a = t.amount === null ? null : Number(t.amount);
    list.push({ executed_at: day(t.executed_at), kind: t.kind, amount: a !== null && Number.isFinite(a) ? a : null });
    txsById.set(id, list);
  }

  // What each position is called, to find it in a statement that left it out.
  const namings = new Map<string, { isins: string[]; wkns: string[]; names: string[] }>();
  for (const h of holdings) {
    const key = keyOf(h);
    if (!key) continue;
    const id = `${h.account_id}|${key}`;
    const n = namings.get(id) ?? { isins: [], wkns: [], names: [] };
    if (h.isin && !n.isins.includes(h.isin)) n.isins.push(h.isin);
    if (h.wkn && !n.wkns.includes(h.wkn)) n.wkns.push(h.wkn);
    if (h.name && !n.names.includes(h.name)) n.names.push(h.name);
    namings.set(id, n);
  }
  const paperIds = [...new Set([...dayPapers.values()].flatMap((m) => [...m.values()]))];
  const texts = new Map<number, string | null>();
  if (paperIds.length > 0) {
    const rows = await db
      .select({ id: documents.id, text: documents.extracted_text })
      .from(documents)
      .where(inArray(documents.id, paperIds));
    for (const r of rows) texts.set(r.id, r.text);
  }

  for (const [id, byDay] of amounts) {
    const sep = id.indexOf("|");
    const accountId = Number(id.slice(0, sep));
    const key = id.slice(sep + 1);
    const days = daysByAccount.get(accountId) ?? [];
    const firstSeen = [...byDay.keys()].sort()[0]!;
    const unread = (d: string): boolean => {
      if (byDay.has(d)) return false;
      const paper = dayPapers.get(accountId)?.get(d);
      return paper !== undefined && statementNamesPosition(texts.get(paper), namings.get(id)!);
    };
    const points: SnapshotPoint[] = days
      .filter((d) => d >= firstSeen && !unread(d))
      .map((d) => ({
        as_of: d,
        amount: byDay.get(d) ?? 0,
        document_id: byDay.has(d) ? (papers.get(id)?.get(d) ?? null) : (dayPapers.get(accountId)?.get(d) ?? null),
      }));
    const r = reconcilePosition(accountId, key, points, txsById.get(id) ?? []);
    result.gaps.push(...r.gaps);
    result.unverifiable += r.unverifiable;
  }

  result.gaps.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
  return result;
}
