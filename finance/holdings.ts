import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
  financeDepotTransaction,
} from "../db/schema";

console.log("[boot] finance/holdings.ts: all imports resolved");

/**
 * Source of the cost-basis figure on a HoldingView:
 *   - "bank": acquisition_price as reported by the bank (FinTS HISAL),
 *     multiplied by the current holding amount.
 *   - "tx-wac": weighted average cost from this account's buy
 *     transactions on the same position (sum(amount*price) / sum(amount),
 *     buys with known amount and price only).
 *   - null: no usable input — neither acquisition_price nor matching
 *     buy txs with quantitative data.
 */
export type CostBasisSource = "bank" | "tx-wac" | null;

interface HoldingView {
  id: number;
  account_id: number;
  as_of: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  amount: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  acquisition_date: string | null;
  acquisition_price: string | null;
  /** Per-unit cost basis applied to the current holding (scale 6). */
  cost_basis_per_unit: string | null;
  /** Total cost basis = amount × cost_basis_per_unit (scale 2). */
  cost_basis: string | null;
  cost_basis_source: CostBasisSource;
  /** value − cost_basis (scale 2, signed). */
  unrealized_gain: string | null;
  /** unrealized_gain / cost_basis × 100 (scale 2, signed). */
  unrealized_gain_pct: string | null;
  /**
   * Sum of realized gains/losses from past sells on this position,
   * computed via chronological WAC walk (scale 2, signed). null when
   * no sells exist or none could be evaluated.
   */
  realized_gain: string | null;
  /**
   * False when some buy/sell transactions on this position lacked the
   * amount/price/net_amount data needed to fold them into the WAC walk
   * (e.g. giro-derived buys with only net_amount). The realized number
   * is still useful but partial — the UI flags this.
   */
  realized_gain_complete: boolean;
}

interface ListHoldingsParams {
  id: number;
  asOf?: string;
}

interface ListHoldingsResponse {
  items: HoldingView[];
  as_of: string | null;
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

async function assertAclRead(accountId: number, userId: number): Promise<void> {
  const [row] = await db
    .select({ user_id: financeAccountAccess.user_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.account_id, accountId),
        eq(financeAccountAccess.user_id, userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw APIError.notFound(`account ${accountId} not found`);
  }
}

export const listHoldings = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id/holdings",
    auth: true,
  },
  async ({ id, asOf }: ListHoldingsParams): Promise<ListHoldingsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const [account] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    if (!hasAdmin(auth)) {
      await assertAclRead(id, Number(auth.userID));
    }

    let resolvedAsOf: string | null = null;

    if (asOf) {
      resolvedAsOf = asOf;
    } else {
      const [latest] = await db
        .select({ as_of: financeAccountHolding.as_of })
        .from(financeAccountHolding)
        .where(eq(financeAccountHolding.account_id, id))
        .orderBy(desc(financeAccountHolding.as_of))
        .limit(1);
      resolvedAsOf = latest?.as_of ?? null;
    }

    if (!resolvedAsOf) {
      return { items: [], as_of: null };
    }

    const rows = await db
      .select()
      .from(financeAccountHolding)
      .where(
        and(
          eq(financeAccountHolding.account_id, id),
          eq(financeAccountHolding.as_of, resolvedAsOf),
        ),
      )
      .orderBy(desc(sql`CAST(${financeAccountHolding.value} AS NUMERIC)`));

    const wacByPosition = await buildBuyWacIndex(id);
    const realizedByPosition = await buildRealizedGainIndex(id);

    return {
      items: rows.map((r) => {
        const valuation = computeCostBasis(r, wacByPosition);
        const realized = lookupRealized(r, realizedByPosition);
        return {
          id: r.id,
          account_id: r.account_id,
          as_of: typeof r.as_of === "string" ? r.as_of.slice(0, 10) : r.as_of,
          isin: r.isin,
          wkn: r.wkn,
          name: r.name,
          amount: r.amount,
          price: r.price,
          value: r.value,
          currency: r.currency,
          acquisition_date: r.acquisition_date
            ? (typeof r.acquisition_date === "string"
                ? r.acquisition_date.slice(0, 10)
                : r.acquisition_date)
            : null,
          acquisition_price: r.acquisition_price,
          cost_basis_per_unit: valuation.costBasisPerUnit,
          cost_basis: valuation.costBasisTotal,
          cost_basis_source: valuation.source,
          unrealized_gain: valuation.unrealizedGain,
          unrealized_gain_pct: valuation.unrealizedGainPct,
          realized_gain: realized.realized,
          realized_gain_complete: realized.complete,
        };
      }),
      as_of: resolvedAsOf.slice(0, 10),
    };
  },
);

// ----------------------------------------------------------------------
// Cost-basis derivation
// ----------------------------------------------------------------------
//
// Strategy per position (#439 — Track AC follow-up):
//   1. If the bank reports `acquisition_price` (FinTS HISAL Einstandskurs),
//      use it × current `amount`. This matches what the user sees in their
//      bank's UI.
//   2. Otherwise, derive a weighted average cost from the account's
//      `kind='buy'` depot transactions where both `amount` and `price`
//      are known. Sells under WAC accounting don't change the per-unit
//      basis, so multiplying by current `amount` is correct.
//   3. If neither input is available (e.g. the bank doesn't ship an
//      Einstandskurs and all buys are giro-derived with null unit data),
//      return null. The UI shows "—" rather than guessing.

/** Aggregated buy data per position, keyed by isin or wkn. */
interface BuyAggregate {
  /** Sum of (amount × price) across qualifying buy txs. */
  weightedCost: number;
  /** Sum of amount across qualifying buy txs. */
  totalQty: number;
}

/**
 * Returns two maps so we can look up by isin OR wkn — the same matching
 * rule used by depot-derivation: holdings on some banks (e.g. MLP) carry
 * only a WKN, while transactions may identify by either or both.
 */
export interface WacIndex {
  byIsin: Map<string, BuyAggregate>;
  byWkn: Map<string, BuyAggregate>;
}

export async function buildBuyWacIndex(accountId: number): Promise<WacIndex> {
  const byIsin = new Map<string, BuyAggregate>();
  const byWkn = new Map<string, BuyAggregate>();

  const buys = await db
    .select({
      isin: financeDepotTransaction.isin,
      wkn: financeDepotTransaction.wkn,
      amount: financeDepotTransaction.amount,
      price: financeDepotTransaction.price,
    })
    .from(financeDepotTransaction)
    .where(
      and(
        eq(financeDepotTransaction.account_id, accountId),
        eq(financeDepotTransaction.kind, "buy"),
      ),
    );

  for (const tx of buys) {
    if (!tx.amount || !tx.price) continue;
    const qty = Number(tx.amount);
    const price = Number(tx.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    if (qty <= 0 || price <= 0) continue;
    const cost = qty * price;
    if (tx.isin) {
      const agg = byIsin.get(tx.isin) ?? { weightedCost: 0, totalQty: 0 };
      agg.weightedCost += cost;
      agg.totalQty += qty;
      byIsin.set(tx.isin, agg);
    }
    if (tx.wkn) {
      const agg = byWkn.get(tx.wkn) ?? { weightedCost: 0, totalQty: 0 };
      agg.weightedCost += cost;
      agg.totalQty += qty;
      byWkn.set(tx.wkn, agg);
    }
  }

  return { byIsin, byWkn };
}

interface ValuationResult {
  costBasisPerUnit: string | null;
  costBasisTotal: string | null;
  source: CostBasisSource;
  unrealizedGain: string | null;
  unrealizedGainPct: string | null;
}

export function computeCostBasis(
  holding: {
    isin: string | null;
    wkn: string | null;
    amount: string | null;
    value: string | null;
    acquisition_price: string | null;
  },
  wacIndex: WacIndex,
): ValuationResult {
  const empty: ValuationResult = {
    costBasisPerUnit: null,
    costBasisTotal: null,
    source: null,
    unrealizedGain: null,
    unrealizedGainPct: null,
  };

  const qty = holding.amount === null ? null : Number(holding.amount);
  if (qty === null || !Number.isFinite(qty)) return empty;

  // Prefer the bank-reported Einstandskurs when available.
  let perUnit: number | null = null;
  let source: CostBasisSource = null;
  if (holding.acquisition_price !== null) {
    const p = Number(holding.acquisition_price);
    if (Number.isFinite(p) && p > 0) {
      perUnit = p;
      source = "bank";
    }
  }

  // Fallback: WAC from buy transactions on this account+position.
  if (perUnit === null) {
    const agg =
      (holding.isin ? wacIndex.byIsin.get(holding.isin) : null) ??
      (holding.wkn ? wacIndex.byWkn.get(holding.wkn) : null);
    if (agg && agg.totalQty > 0) {
      perUnit = agg.weightedCost / agg.totalQty;
      source = "tx-wac";
    }
  }

  if (perUnit === null) return empty;

  const total = qty * perUnit;
  let unrealizedGain: string | null = null;
  let unrealizedGainPct: string | null = null;
  if (holding.value !== null) {
    const v = Number(holding.value);
    if (Number.isFinite(v)) {
      const gain = v - total;
      unrealizedGain = gain.toFixed(2);
      if (total !== 0) {
        unrealizedGainPct = ((gain / total) * 100).toFixed(2);
      }
    }
  }

  return {
    costBasisPerUnit: perUnit.toFixed(6),
    costBasisTotal: total.toFixed(2),
    source,
    unrealizedGain,
    unrealizedGainPct,
  };
}

// ----------------------------------------------------------------------
// Realized gain derivation (chronological WAC walk)
// ----------------------------------------------------------------------
//
// For each position we replay every depot transaction in order:
//   - buy/in:  fold quantity and cost into the running WAC
//   - sell:    realized += proceeds − soldQty × currentWac
//   - out:     reduce inventory at WAC (no realized G/V — transfer)
//   - other:   ignored (dividend/split/corp_action have separate
//              tax treatment; not part of position G/V)
//
// "proceeds" prefers `net_amount` (after fees/tax — closer to what the
// user actually received). Falls back to amount × price.
//
// `complete` is false when any buy/sell on the position lacked the
// quantitative data needed (typical for giro-derived rows with only
// net_amount). The number we return is still useful, just partial.

export interface RealizedAggregate {
  realized: number;
  complete: boolean;
  /** True if any sell contributed to `realized`. */
  hasData: boolean;
}

export interface RealizedIndex {
  byIsin: Map<string, RealizedAggregate>;
  byWkn: Map<string, RealizedAggregate>;
  byName: Map<string, RealizedAggregate>;
}

interface DepotTx {
  id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  kind: string;
  executed_at: string;
  amount: string | null;
  price: string | null;
  net_amount: string | null;
}

export async function buildRealizedGainIndex(
  accountId: number,
): Promise<RealizedIndex> {
  const txs = await db
    .select({
      id: financeDepotTransaction.id,
      isin: financeDepotTransaction.isin,
      wkn: financeDepotTransaction.wkn,
      name: financeDepotTransaction.name,
      kind: financeDepotTransaction.kind,
      executed_at: financeDepotTransaction.executed_at,
      amount: financeDepotTransaction.amount,
      price: financeDepotTransaction.price,
      net_amount: financeDepotTransaction.net_amount,
    })
    .from(financeDepotTransaction)
    .where(eq(financeDepotTransaction.account_id, accountId));

  // Bucket transactions by stable position key. Same matching rule used
  // throughout (isin > wkn > name) — see statement-persist.ts.
  function positionKey(tx: { isin: string | null; wkn: string | null; name: string | null }): string | null {
    return tx.isin || tx.wkn || tx.name || null;
  }
  const buckets = new Map<string, DepotTx[]>();
  for (const tx of txs) {
    const key = positionKey(tx);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(tx);
    buckets.set(key, list);
  }

  const byIsin = new Map<string, RealizedAggregate>();
  const byWkn = new Map<string, RealizedAggregate>();
  const byName = new Map<string, RealizedAggregate>();

  for (const [, list] of buckets) {
    const agg = computeRealizedForPosition(list);
    // Index under every identifier that appears in this bucket, so a
    // holding can be matched by whatever identifier it carries.
    const seenIsin = new Set<string>();
    const seenWkn = new Set<string>();
    const seenName = new Set<string>();
    for (const tx of list) {
      if (tx.isin && !seenIsin.has(tx.isin)) {
        seenIsin.add(tx.isin);
        byIsin.set(tx.isin, agg);
      }
      if (tx.wkn && !seenWkn.has(tx.wkn)) {
        seenWkn.add(tx.wkn);
        byWkn.set(tx.wkn, agg);
      }
      if (tx.name && !seenName.has(tx.name)) {
        seenName.add(tx.name);
        byName.set(tx.name, agg);
      }
    }
  }

  return { byIsin, byWkn, byName };
}

export function computeRealizedForPosition(txs: DepotTx[]): RealizedAggregate {
  const sorted = [...txs].sort((a, b) => {
    if (a.executed_at !== b.executed_at) {
      return a.executed_at < b.executed_at ? -1 : 1;
    }
    return a.id - b.id;
  });

  let qty = 0;
  let costTotal = 0; // qty × current WAC
  let realized = 0;
  let complete = true;
  let hasData = false;

  for (const tx of sorted) {
    if (tx.kind === "buy" || tx.kind === "in") {
      const a = tx.amount === null ? null : Number(tx.amount);
      const p = tx.price === null ? null : Number(tx.price);
      if (a === null || p === null || !Number.isFinite(a) || !Number.isFinite(p) || a <= 0 || p <= 0) {
        complete = false;
        continue;
      }
      qty += a;
      costTotal += a * p;
    } else if (tx.kind === "sell") {
      const a = tx.amount === null ? null : Number(tx.amount);
      if (a === null || !Number.isFinite(a) || a <= 0) {
        complete = false;
        continue;
      }
      // Proceeds: prefer net_amount (after fees/tax), else gross via price.
      let proceeds: number | null = null;
      if (tx.net_amount !== null) {
        const n = Number(tx.net_amount);
        if (Number.isFinite(n)) proceeds = n;
      }
      if (proceeds === null && tx.price !== null) {
        const p = Number(tx.price);
        if (Number.isFinite(p)) proceeds = a * p;
      }
      const wac = qty > 0 ? costTotal / qty : 0;
      const soldQty = Math.min(a, qty);
      const costPortion = soldQty * wac;
      if (proceeds === null) {
        complete = false;
      } else {
        realized += proceeds - costPortion;
        hasData = true;
      }
      qty -= soldQty;
      costTotal -= costPortion;
    } else if (tx.kind === "out") {
      const a = tx.amount === null ? null : Number(tx.amount);
      if (a === null || !Number.isFinite(a) || a <= 0) {
        complete = false;
        continue;
      }
      const wac = qty > 0 ? costTotal / qty : 0;
      const soldQty = Math.min(a, qty);
      qty -= soldQty;
      costTotal -= soldQty * wac;
    }
    // dividend / split / corp_action: ignored for realized G/V.
  }

  return { realized, complete, hasData };
}

function lookupRealized(
  holding: { isin: string | null; wkn: string | null; name: string | null },
  index: RealizedIndex,
): { realized: string | null; complete: boolean } {
  const agg =
    (holding.isin ? index.byIsin.get(holding.isin) : null) ??
    (holding.wkn ? index.byWkn.get(holding.wkn) : null) ??
    (holding.name ? index.byName.get(holding.name) : null);
  if (!agg || !agg.hasData) {
    return { realized: null, complete: agg ? agg.complete : true };
  }
  return { realized: agg.realized.toFixed(2), complete: agg.complete };
}

// ----------------------------------------------------------------------
// Holdings history (Phase 1 of #428 / #439)
//
// Aggregates the per-day holding snapshots into:
//   - a depot-wide total-value series (SUM(value) GROUP BY as_of), and
//   - a per-position series (key = COALESCE(isin, wkn, name), same
//     identity used by the upsert in statement-persist.ts).
//
// Range filtering: optional from/to as YYYY-MM-DD inclusive bounds.
// ----------------------------------------------------------------------

interface HistoryPoint {
  as_of: string;
  amount: string | null;
  price: string | null;
  value: string | null;
}

interface PositionSeries {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  points: HistoryPoint[];
}

interface TotalPoint {
  as_of: string;
  total_value: string;
  currency: string | null;
}

interface HoldingsHistoryParams {
  id: number;
  from?: string;
  to?: string;
}

interface HoldingsHistoryResponse {
  totals: TotalPoint[];
  positions: PositionSeries[];
  from: string | null;
  to: string | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(raw: string | undefined, field: string): string | null {
  if (!raw) return null;
  if (!ISO_DATE_RE.test(raw)) {
    throw APIError.invalidArgument(`${field} must be YYYY-MM-DD`);
  }
  return raw;
}

function positionKey(r: {
  isin: string | null;
  wkn: string | null;
  name: string | null;
}): string {
  return (
    (r.isin && r.isin.length > 0 && r.isin) ||
    (r.wkn && r.wkn.length > 0 && r.wkn) ||
    (r.name && r.name.length > 0 && r.name) ||
    ""
  );
}

export const getHoldingsHistory = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id/holdings/history",
    auth: true,
  },
  async ({
    id,
    from,
    to,
  }: HoldingsHistoryParams): Promise<HoldingsHistoryResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const fromDate = normalizeDate(from, "from");
    const toDate = normalizeDate(to, "to");
    if (fromDate && toDate && fromDate > toDate) {
      throw APIError.invalidArgument("from must be on or before to");
    }

    const [account] = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.id, id))
      .limit(1);
    if (!account) throw APIError.notFound(`account ${id} not found`);

    if (!hasAdmin(auth)) {
      await assertAclRead(id, Number(auth.userID));
    }

    const conditions = [eq(financeAccountHolding.account_id, id)];
    if (fromDate) {
      conditions.push(sql`${financeAccountHolding.as_of} >= ${fromDate}::date`);
    }
    if (toDate) {
      conditions.push(sql`${financeAccountHolding.as_of} <= ${toDate}::date`);
    }

    const rows = await db
      .select({
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
        currency: financeAccountHolding.currency,
      })
      .from(financeAccountHolding)
      .where(and(...conditions))
      .orderBy(financeAccountHolding.as_of);

    if (rows.length === 0) {
      return { totals: [], positions: [], from: fromDate, to: toDate };
    }

    // Totals per as_of — sum of all position values that day.
    const totalsByDate = new Map<string, { sum: number; currency: string | null }>();
    // Positions keyed by COALESCE(isin, wkn, name) so we track the same
    // identity that the upsert uses.
    const positionsByKey = new Map<string, PositionSeries>();

    for (const r of rows) {
      const asOf =
        typeof r.as_of === "string" ? r.as_of.slice(0, 10) : String(r.as_of);

      const v = r.value === null ? null : Number(r.value);
      if (v !== null && Number.isFinite(v)) {
        const entry = totalsByDate.get(asOf) ?? { sum: 0, currency: r.currency };
        entry.sum += v;
        if (!entry.currency) entry.currency = r.currency;
        totalsByDate.set(asOf, entry);
      } else if (!totalsByDate.has(asOf)) {
        totalsByDate.set(asOf, { sum: 0, currency: r.currency });
      }

      const key = positionKey(r);
      if (!key) continue;
      let series = positionsByKey.get(key);
      if (!series) {
        series = {
          key,
          isin: r.isin,
          wkn: r.wkn,
          name: r.name,
          currency: r.currency,
          points: [],
        };
        positionsByKey.set(key, series);
      } else {
        // Keep the most recent non-null name/isin/wkn — older snapshots
        // sometimes have less metadata.
        if (r.isin && !series.isin) series.isin = r.isin;
        if (r.wkn && !series.wkn) series.wkn = r.wkn;
        if (r.name) series.name = r.name;
        if (r.currency && !series.currency) series.currency = r.currency;
      }
      series.points.push({
        as_of: asOf,
        amount: r.amount,
        price: r.price,
        value: r.value,
      });
    }

    const totals: TotalPoint[] = Array.from(totalsByDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([as_of, { sum, currency }]) => ({
        as_of,
        total_value: sum.toFixed(2),
        currency,
      }));

    const positions = Array.from(positionsByKey.values()).sort((a, b) => {
      const an = (a.name ?? a.isin ?? a.wkn ?? "").toLowerCase();
      const bn = (b.name ?? b.isin ?? b.wkn ?? "").toLowerCase();
      return an.localeCompare(bn);
    });

    return { totals, positions, from: fromDate, to: toDate };
  },
);
