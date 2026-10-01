/**
 * Portfolio — securities across every depot the caller may read (#1336).
 *
 * The per-account endpoints in holdings.ts and depot-transactions.ts
 * answer "what is in this depot". This module answers "what do I own",
 * aggregating the latest holdings snapshot of every visible depot and
 * replaying every depot transaction into one set of positions:
 *
 *   - market value, cost basis and unrealized G/L from the latest snapshot
 *     per depot (same valuation as holdings.ts: bank Einstandskurs first,
 *     weighted average cost from buys as the fallback),
 *   - realized G/L from sells, walked per depot and position with the WAC
 *     method of holdings.ts (lots live in one depot, so a transfer between
 *     depots is not a sale and must not mix the two cost bases),
 *   - income from `kind='dividend'` rows, fees and taxes from every row,
 *     each as a total and per calendar year.
 *
 * Positions are keyed by COALESCE(isin, wkn, name), the identity every
 * other depot module uses. A position with transactions but no current
 * holding (sold out, transferred away) is still returned, with `open:
 * false`, so the realized G/L and the income it produced do not vanish
 * from the yearly figures.
 *
 * Access: `finance.view` plus the account ACL (`finance_account_access`)
 * or `finance.admin` — the same rule as listAccounts. An `accounts`
 * parameter narrows the scope, but never beyond what the ACL allows: an
 * id the caller may not read is dropped silently rather than erroring, so
 * a shared link with a stale id still renders.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeDepotTransaction,
} from "../db/schema";
import {
  computeCostBasis,
  computeRealizedForPosition,
  type CostBasisSource,
  type WacIndex,
} from "./holdings";
import {
  documentIdsByDepotTransaction,
  enrichDocument,
  enrichPendingDocuments,
  type EnrichResult,
} from "./depot-document-enrichment";
import { reconcileHoldings, type HoldingGap } from "./depot-holding-reconciliation";

console.log("[boot] finance/portfolio.ts: all imports resolved");

// ----------------------------------------------------------------------
// Scope: which depots the caller may see
// ----------------------------------------------------------------------

interface DepotAccount {
  id: number;
  label: string;
  currency_code: string;
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

/**
 * Every depot account the caller may read, optionally narrowed to the
 * ids in `requested`. Ids outside the readable set are ignored.
 */
async function visibleDepots(
  auth: { userID: string; permissions: string[] },
  requested: number[] | null,
): Promise<DepotAccount[]> {
  const conditions = [eq(financeAccountType.kind, "depot")];
  if (requested && requested.length > 0) {
    conditions.push(inArray(financeAccount.id, requested));
  }

  const base = db
    .select({
      id: financeAccount.id,
      label: financeAccount.label,
      currency_code: financeAccount.currency_code,
    })
    .from(financeAccount)
    .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id));

  const rows = hasAdmin(auth)
    ? await base.where(and(...conditions)).orderBy(asc(financeAccount.label))
    : await base
        .innerJoin(
          financeAccountAccess,
          and(
            eq(financeAccountAccess.account_id, financeAccount.id),
            eq(financeAccountAccess.user_id, Number(auth.userID)),
          ),
        )
        .where(and(...conditions))
        .orderBy(asc(financeAccount.label));

  return rows;
}

/**
 * The depots among `visibleDepots` the caller may write to: every one for
 * an admin, otherwise those with `level='write'` on the ACL.
 */
async function writableDepots(
  auth: { userID: string; permissions: string[] },
  requested: number[] | null,
): Promise<DepotAccount[]> {
  const visible = await visibleDepots(auth, requested);
  if (hasAdmin(auth) || visible.length === 0) return visible;
  const rows = await db
    .select({ account_id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.user_id, Number(auth.userID)),
        eq(financeAccountAccess.level, "write"),
        inArray(financeAccountAccess.account_id, visible.map((d) => d.id)),
      ),
    );
  const writable = new Set(rows.map((r) => r.account_id));
  return visible.filter((d) => writable.has(d.id));
}

/** "1,2,3" → [1, 2, 3]; anything that is not a positive integer is an error. */
function parseAccountIds(raw: string | undefined): number[] | null {
  if (!raw || raw.trim() === "") return null;
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const parsed: number[] = [];
  for (const s of ids) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw APIError.invalidArgument(`accounts must be a comma-separated list of ids`);
    }
    parsed.push(n);
  }
  return parsed;
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
  return r.isin || r.wkn || r.name || "";
}

function num(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function yearOf(date: string): number | null {
  if (!date || date.length < 4) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

// ----------------------------------------------------------------------
// Portfolio (summary + positions + per-year figures)
// ----------------------------------------------------------------------

export interface PortfolioPosition {
  /** COALESCE(isin, wkn, name) — stable identity across depots. */
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  /** Depots that hold or held this position. */
  account_ids: number[];
  /** False when no depot currently holds it (sold out / transferred). */
  open: boolean;
  /** Sum of the current amounts across depots (scale 8). */
  amount: string | null;
  /** Latest price seen in any depot's snapshot (scale 6). */
  price: string | null;
  /** Date of that price. */
  price_as_of: string | null;
  /** Sum of the current values across depots (scale 2). */
  value: string | null;
  /** Sum of the cost bases across depots (scale 2); null when unknown. */
  cost_basis: string | null;
  /** Per-unit cost basis = cost_basis / amount (scale 6). */
  cost_basis_per_unit: string | null;
  /** "bank" when every depot reported an Einstandskurs, else "tx-wac", else null. */
  cost_basis_source: CostBasisSource;
  unrealized_gain: string | null;
  unrealized_gain_pct: string | null;
  /** Share of the position's value in the portfolio's market value (scale 2, %). */
  weight_pct: string | null;
  /** Sum of realized G/L from sells (scale 2); null when no sell contributed. */
  realized_gain: string | null;
  realized_gain_complete: boolean;
  /** Net dividends / distributions received (scale 2); null when none. */
  income: string | null;
  /** income / cost_basis × 100 (scale 2); null when either is unknown. */
  yield_on_cost_pct: string | null;
  /** Sum of `fees` over every transaction of the position (scale 2). */
  fees: string | null;
  /** Sum of `tax` over every transaction of the position (scale 2). */
  taxes: string | null;
  /** unrealized + realized + income (scale 2); null when nothing is known. */
  total_return: string | null;
  /** total_return / cost_basis × 100 (scale 2). */
  total_return_pct: string | null;
  buy_count: number;
  sell_count: number;
  dividend_count: number;
  first_transaction_at: string | null;
  last_transaction_at: string | null;
}

export interface PortfolioYear {
  year: number;
  realized: string;
  sell_count: number;
  realized_complete: boolean;
  income: string;
  dividend_count: number;
  fees: string;
  taxes: string;
  /** Net invested that year: buys − sells by net amount (scale 2). */
  net_invested: string;
}

export interface PortfolioSummary {
  /** Date of the newest snapshot across the depots; null without snapshots. */
  as_of: string | null;
  market_value: string;
  /** Sum of the cost bases of the open positions that have one. */
  cost_basis: string;
  /** True when every open position has a cost basis. */
  cost_basis_complete: boolean;
  unrealized_gain: string;
  unrealized_gain_pct: string | null;
  realized_gain: string;
  realized_gain_ytd: string;
  realized_gain_complete: boolean;
  income: string;
  income_ytd: string;
  fees: string;
  taxes: string;
  /** unrealized + realized + income. */
  total_return: string;
  total_return_pct: string | null;
  open_positions: number;
  closed_positions: number;
  transaction_count: number;
}

interface PortfolioParams {
  /** Comma-separated depot account ids; omitted = every readable depot. */
  accounts?: string;
}

interface PortfolioResponse {
  accounts: DepotAccount[];
  currency: string;
  /** True when the depots in scope use more than one currency; sums are then nominal. */
  mixed_currency: boolean;
  summary: PortfolioSummary;
  positions: PortfolioPosition[];
  years: PortfolioYear[];
}

interface DepotTxRow {
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
}

interface HoldingRow {
  account_id: number;
  as_of: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  amount: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  acquisition_price: string | null;
}

/** Mutable accumulator per position while the rows are folded in. */
interface PositionAcc {
  key: string;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
  accountIds: Set<number>;
  open: boolean;
  amount: number;
  price: number | null;
  priceAsOf: string | null;
  value: number;
  hasValue: boolean;
  costBasis: number;
  /** False once a holding in any depot has no cost basis. */
  costComplete: boolean;
  /** Number of holdings with each source, to pick the position's label. */
  costSources: Set<CostBasisSource>;
  holdingCount: number;
  realized: number;
  realizedHasData: boolean;
  realizedComplete: boolean;
  income: number;
  hasIncome: boolean;
  fees: number;
  taxes: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
  first: string | null;
  last: string | null;
}

function newAcc(key: string): PositionAcc {
  return {
    key,
    isin: null,
    wkn: null,
    name: null,
    currency: null,
    accountIds: new Set(),
    open: false,
    amount: 0,
    price: null,
    priceAsOf: null,
    value: 0,
    hasValue: false,
    costBasis: 0,
    costComplete: true,
    costSources: new Set(),
    holdingCount: 0,
    realized: 0,
    realizedHasData: false,
    realizedComplete: true,
    income: 0,
    hasIncome: false,
    fees: 0,
    taxes: 0,
    buyCount: 0,
    sellCount: 0,
    dividendCount: 0,
    first: null,
    last: null,
  };
}

function adoptIdentity(
  acc: PositionAcc,
  r: { isin: string | null; wkn: string | null; name: string | null; currency: string | null },
) {
  if (r.isin && !acc.isin) acc.isin = r.isin;
  if (r.wkn && !acc.wkn) acc.wkn = r.wkn;
  if (r.name) acc.name = r.name;
  if (r.currency && !acc.currency) acc.currency = r.currency;
}

/**
 * Latest snapshot per depot: the newest `as_of` of each account, then
 * every holding row of that day. One query per account keeps it simple;
 * a household has a handful of depots, not hundreds.
 */
async function latestHoldings(accountIds: number[]): Promise<HoldingRow[]> {
  const out: HoldingRow[] = [];
  for (const id of accountIds) {
    const [latest] = await db
      .select({ as_of: financeAccountHolding.as_of })
      .from(financeAccountHolding)
      .where(eq(financeAccountHolding.account_id, id))
      .orderBy(desc(financeAccountHolding.as_of))
      .limit(1);
    if (!latest) continue;
    const rows = await db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
        currency: financeAccountHolding.currency,
        acquisition_price: financeAccountHolding.acquisition_price,
      })
      .from(financeAccountHolding)
      .where(
        and(
          eq(financeAccountHolding.account_id, id),
          eq(financeAccountHolding.as_of, latest.as_of),
        ),
      );
    out.push(...rows);
  }
  return out;
}

/**
 * WAC per account from its buys — the same index holdings.ts builds, but
 * from rows already in memory so the transactions are read once.
 */
function wacIndexFromRows(txs: DepotTxRow[]): WacIndex {
  const byIsin = new Map<string, { weightedCost: number; totalQty: number }>();
  const byWkn = new Map<string, { weightedCost: number; totalQty: number }>();
  for (const tx of txs) {
    if (tx.kind !== "buy") continue;
    const qty = num(tx.amount);
    const price = num(tx.price);
    if (qty === null || price === null || qty <= 0 || price <= 0) continue;
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

function dateOnly(raw: string): string {
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

/** Signed net of a dividend row: net_amount first, gross − fees − tax as the fallback. */
function dividendNet(tx: DepotTxRow): number | null {
  const net = num(tx.net_amount);
  if (net !== null) return net;
  const gross = num(tx.gross_amount);
  if (gross === null) return null;
  return gross - (num(tx.fees) ?? 0) - (num(tx.tax) ?? 0);
}

/** Cash moved for a buy/sell: net first, then gross, then amount × price. */
function cashOf(tx: DepotTxRow): number | null {
  const net = num(tx.net_amount);
  if (net !== null) return Math.abs(net);
  const gross = num(tx.gross_amount);
  if (gross !== null) return Math.abs(gross);
  const a = num(tx.amount);
  const p = num(tx.price);
  if (a === null || p === null) return null;
  return Math.abs(a * p);
}

export function buildPortfolio(
  holdings: HoldingRow[],
  txs: DepotTxRow[],
): Pick<PortfolioResponse, "summary" | "positions" | "years"> {
  const positions = new Map<string, PositionAcc>();
  const acc = (key: string) => {
    let p = positions.get(key);
    if (!p) {
      p = newAcc(key);
      positions.set(key, p);
    }
    return p;
  };

  // Transactions per account, for the WAC index and the realized walk.
  const txsByAccount = new Map<number, DepotTxRow[]>();
  for (const tx of txs) {
    const list = txsByAccount.get(tx.account_id) ?? [];
    list.push(tx);
    txsByAccount.set(tx.account_id, list);
  }
  const wacByAccount = new Map<number, WacIndex>();
  for (const [id, list] of txsByAccount) wacByAccount.set(id, wacIndexFromRows(list));

  // 1. Holdings → open positions with value and cost basis.
  let asOf: string | null = null;
  for (const h of holdings) {
    const key = positionKey(h);
    if (!key) continue;
    const day = dateOnly(h.as_of);
    if (!asOf || day > asOf) asOf = day;

    const p = acc(key);
    adoptIdentity(p, h);
    p.accountIds.add(h.account_id);
    p.holdingCount += 1;

    const amount = num(h.amount);
    if (amount !== null && amount > 0) {
      p.open = true;
      p.amount += amount;
    }
    const value = num(h.value);
    if (value !== null) {
      p.value += value;
      p.hasValue = true;
    }
    const price = num(h.price);
    if (price !== null && (!p.priceAsOf || day >= p.priceAsOf)) {
      p.price = price;
      p.priceAsOf = day;
    }

    const wac = wacByAccount.get(h.account_id) ?? { byIsin: new Map(), byWkn: new Map() };
    const valuation = computeCostBasis(h, wac);
    if (valuation.costBasisTotal !== null) {
      p.costBasis += Number(valuation.costBasisTotal);
      p.costSources.add(valuation.source);
    } else if (amount !== null && amount > 0) {
      p.costComplete = false;
    }
  }

  // 2. Transactions → realized, income, fees, taxes, counts, years.
  const years = new Map<
    number,
    {
      realized: number;
      sellCount: number;
      realizedComplete: boolean;
      income: number;
      dividendCount: number;
      fees: number;
      taxes: number;
      netInvested: number;
    }
  >();
  const yearBucket = (y: number) => {
    let b = years.get(y);
    if (!b) {
      b = {
        realized: 0,
        sellCount: 0,
        realizedComplete: true,
        income: 0,
        dividendCount: 0,
        fees: 0,
        taxes: 0,
        netInvested: 0,
      };
      years.set(y, b);
    }
    return b;
  };

  for (const tx of txs) {
    const key = positionKey(tx);
    if (!key) continue;
    const p = acc(key);
    adoptIdentity(p, tx);
    p.accountIds.add(tx.account_id);

    const day = dateOnly(tx.executed_at);
    if (!p.first || day < p.first) p.first = day;
    if (!p.last || day > p.last) p.last = day;
    const year = yearOf(day);
    const yb = year === null ? null : yearBucket(year);

    const fees = num(tx.fees);
    if (fees !== null) {
      p.fees += Math.abs(fees);
      if (yb) yb.fees += Math.abs(fees);
    }
    const tax = num(tx.tax);
    if (tax !== null) {
      p.taxes += Math.abs(tax);
      if (yb) yb.taxes += Math.abs(tax);
    }

    if (tx.kind === "buy") {
      p.buyCount += 1;
      const cash = cashOf(tx);
      if (cash !== null && yb) yb.netInvested += cash;
    } else if (tx.kind === "sell") {
      p.sellCount += 1;
      const cash = cashOf(tx);
      if (cash !== null && yb) yb.netInvested -= cash;
    } else if (tx.kind === "dividend") {
      p.dividendCount += 1;
      const net = dividendNet(tx);
      if (net !== null) {
        p.income += net;
        p.hasIncome = true;
        if (yb) {
          yb.income += net;
          yb.dividendCount += 1;
        }
      }
    }
  }

  // Realized G/L: per account and position, so a lot never crosses depots.
  for (const [, list] of txsByAccount) {
    const byKey = new Map<string, DepotTxRow[]>();
    for (const tx of list) {
      const key = positionKey(tx);
      if (!key) continue;
      const bucket = byKey.get(key) ?? [];
      bucket.push(tx);
      byKey.set(key, bucket);
    }
    for (const [key, bucket] of byKey) {
      const r = computeRealizedForPosition(bucket);
      const p = acc(key);
      if (!r.complete) p.realizedComplete = false;
      if (r.hasData) {
        p.realized += r.realized;
        p.realizedHasData = true;
      }
      for (const [year, yr] of r.byYear) {
        const yb = yearBucket(year);
        yb.realized += yr.realized;
        yb.sellCount += yr.sellCount;
        if (!r.complete) yb.realizedComplete = false;
      }
    }
  }

  // 3. Totals and the response shape.
  let marketValue = 0;
  let costBasis = 0;
  let costComplete = true;
  let realized = 0;
  let realizedComplete = true;
  let income = 0;
  let fees = 0;
  let taxes = 0;
  let openCount = 0;
  let closedCount = 0;

  for (const p of positions.values()) {
    if (p.open) {
      openCount += 1;
      marketValue += p.value;
      if (p.costComplete && p.costSources.size > 0) costBasis += p.costBasis;
      else costComplete = false;
    } else {
      closedCount += 1;
    }
    realized += p.realized;
    if (!p.realizedComplete) realizedComplete = false;
    income += p.income;
    fees += p.fees;
    taxes += p.taxes;
  }

  const out: PortfolioPosition[] = [];
  for (const p of positions.values()) {
    const hasCost = p.open && p.costComplete && p.costSources.size > 0;
    const cost = hasCost ? p.costBasis : null;
    const unrealized = p.open && hasCost && p.hasValue ? p.value - p.costBasis : null;
    const realizedOut = p.realizedHasData ? p.realized : null;
    const incomeOut = p.hasIncome ? p.income : null;
    const totalReturn =
      unrealized === null && realizedOut === null && incomeOut === null
        ? null
        : (unrealized ?? 0) + (realizedOut ?? 0) + (incomeOut ?? 0);
    const source: CostBasisSource = !hasCost
      ? null
      : p.costSources.size === 1 && p.costSources.has("bank")
        ? "bank"
        : "tx-wac";

    out.push({
      key: p.key,
      isin: p.isin,
      wkn: p.wkn,
      name: p.name,
      currency: p.currency,
      account_ids: [...p.accountIds].sort((a, b) => a - b),
      open: p.open,
      amount: p.open ? p.amount.toFixed(8) : null,
      price: p.price === null ? null : p.price.toFixed(6),
      price_as_of: p.priceAsOf,
      value: p.open && p.hasValue ? p.value.toFixed(2) : null,
      cost_basis: cost === null ? null : cost.toFixed(2),
      cost_basis_per_unit:
        cost === null || p.amount <= 0 ? null : (cost / p.amount).toFixed(6),
      cost_basis_source: source,
      unrealized_gain: unrealized === null ? null : unrealized.toFixed(2),
      unrealized_gain_pct:
        unrealized === null || cost === null || cost === 0
          ? null
          : ((unrealized / cost) * 100).toFixed(2),
      weight_pct:
        p.open && p.hasValue && marketValue > 0
          ? ((p.value / marketValue) * 100).toFixed(2)
          : null,
      realized_gain: realizedOut === null ? null : realizedOut.toFixed(2),
      realized_gain_complete: p.realizedComplete,
      income: incomeOut === null ? null : incomeOut.toFixed(2),
      yield_on_cost_pct:
        incomeOut === null || cost === null || cost === 0
          ? null
          : ((incomeOut / cost) * 100).toFixed(2),
      fees: p.fees > 0 ? p.fees.toFixed(2) : null,
      taxes: p.taxes > 0 ? p.taxes.toFixed(2) : null,
      total_return: totalReturn === null ? null : totalReturn.toFixed(2),
      total_return_pct:
        totalReturn === null || cost === null || cost === 0
          ? null
          : ((totalReturn / cost) * 100).toFixed(2),
      buy_count: p.buyCount,
      sell_count: p.sellCount,
      dividend_count: p.dividendCount,
      first_transaction_at: p.first,
      last_transaction_at: p.last,
    });
  }

  // Open positions by value, then closed ones by name.
  out.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.open) {
      const av = a.value === null ? -1 : Number(a.value);
      const bv = b.value === null ? -1 : Number(b.value);
      if (av !== bv) return bv - av;
    }
    const an = (a.name ?? a.key).toLowerCase();
    const bn = (b.name ?? b.key).toLowerCase();
    return an.localeCompare(bn);
  });

  const unrealizedTotal = marketValue - costBasis;
  const totalReturn = unrealizedTotal + realized + income;
  const thisYear = new Date().getFullYear();
  const ytd = years.get(thisYear);

  const yearsOut: PortfolioYear[] = [...years.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, b]) => ({
      year,
      realized: b.realized.toFixed(2),
      sell_count: b.sellCount,
      realized_complete: b.realizedComplete,
      income: b.income.toFixed(2),
      dividend_count: b.dividendCount,
      fees: b.fees.toFixed(2),
      taxes: b.taxes.toFixed(2),
      net_invested: b.netInvested.toFixed(2),
    }));

  return {
    summary: {
      as_of: asOf,
      market_value: marketValue.toFixed(2),
      cost_basis: costBasis.toFixed(2),
      cost_basis_complete: costComplete,
      unrealized_gain: unrealizedTotal.toFixed(2),
      unrealized_gain_pct:
        costBasis > 0 ? ((unrealizedTotal / costBasis) * 100).toFixed(2) : null,
      realized_gain: realized.toFixed(2),
      realized_gain_ytd: (ytd?.realized ?? 0).toFixed(2),
      realized_gain_complete: realizedComplete,
      income: income.toFixed(2),
      income_ytd: (ytd?.income ?? 0).toFixed(2),
      fees: fees.toFixed(2),
      taxes: taxes.toFixed(2),
      total_return: totalReturn.toFixed(2),
      total_return_pct:
        costBasis > 0 ? ((totalReturn / costBasis) * 100).toFixed(2) : null,
      open_positions: openCount,
      closed_positions: closedCount,
      transaction_count: txs.length,
    },
    positions: out,
    years: yearsOut,
  };
}

async function loadTransactions(accountIds: number[]): Promise<DepotTxRow[]> {
  if (accountIds.length === 0) return [];
  return db
    .select({
      id: financeDepotTransaction.id,
      account_id: financeDepotTransaction.account_id,
      isin: financeDepotTransaction.isin,
      wkn: financeDepotTransaction.wkn,
      name: financeDepotTransaction.name,
      kind: financeDepotTransaction.kind,
      executed_at: financeDepotTransaction.executed_at,
      amount: financeDepotTransaction.amount,
      price: financeDepotTransaction.price,
      gross_amount: financeDepotTransaction.gross_amount,
      fees: financeDepotTransaction.fees,
      tax: financeDepotTransaction.tax,
      net_amount: financeDepotTransaction.net_amount,
      currency: financeDepotTransaction.currency,
      source: financeDepotTransaction.source,
      linked_transaction_id: financeDepotTransaction.linked_transaction_id,
      note: financeDepotTransaction.note,
    })
    .from(financeDepotTransaction)
    .where(inArray(financeDepotTransaction.account_id, accountIds));
}

function scopeCurrency(accounts: DepotAccount[]): { currency: string; mixed: boolean } {
  const codes = new Set(accounts.map((a) => a.currency_code));
  if (codes.size === 0) return { currency: "EUR", mixed: false };
  return { currency: accounts[0].currency_code, mixed: codes.size > 1 };
}

export const getPortfolio = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio",
    auth: true,
  },
  async ({ accounts }: PortfolioParams): Promise<PortfolioResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const requested = parseAccountIds(accounts);
    const depots = await visibleDepots(auth, requested);
    const ids = depots.map((d) => d.id);
    // The selector offers every readable depot even when the scope is narrowed.
    const allDepots = requested ? await visibleDepots(auth, null) : depots;

    const [holdings, txs] = await Promise.all([
      latestHoldings(ids),
      loadTransactions(ids),
    ]);
    const { currency, mixed } = scopeCurrency(depots);

    return {
      accounts: allDepots,
      currency,
      mixed_currency: mixed,
      ...buildPortfolio(holdings, txs),
    };
  },
);

// ----------------------------------------------------------------------
// Transactions across depots
// ----------------------------------------------------------------------

export interface PortfolioTransaction {
  id: number;
  account_id: number;
  account_label: string;
  /** COALESCE(isin, wkn, name) — links the row to its position. */
  position_key: string;
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
  /** Settlement documents this row was read from or confirmed by. */
  document_ids: number[];
}

type TxSortField = "executed_at" | "net_amount" | "name";

interface PortfolioTransactionsParams {
  /** Comma-separated depot account ids; omitted = every readable depot. */
  accounts?: string;
  /** Position key (isin, wkn or name) to narrow to one security. */
  position?: string;
  /** buy | sell | in | out | dividend | split | corp_action */
  kind?: string;
  /** Case-insensitive substring over name, isin and wkn. */
  q?: string;
  /** YYYY-MM-DD inclusive bounds on executed_at. */
  from?: string;
  to?: string;
  sortBy?: TxSortField;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

interface PortfolioTransactionsResponse {
  items: PortfolioTransaction[];
  total: number;
  /** Sums over the whole filtered set, not just this page (scale 2). */
  sums: {
    net_amount: string;
    fees: string;
    taxes: string;
  };
}

const VALID_KINDS = new Set(["buy", "sell", "in", "out", "dividend", "split", "corp_action"]);

export const listPortfolioTransactions = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/transactions",
    auth: true,
  },
  async (p: PortfolioTransactionsParams): Promise<PortfolioTransactionsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const requested = parseAccountIds(p.accounts);
    const depots = await visibleDepots(auth, requested);
    const ids = depots.map((d) => d.id);
    const empty = { items: [], total: 0, sums: { net_amount: "0.00", fees: "0.00", taxes: "0.00" } };
    if (ids.length === 0) return empty;

    const from = normalizeDate(p.from, "from");
    const to = normalizeDate(p.to, "to");
    if (from && to && from > to) {
      throw APIError.invalidArgument("from must be on or before to");
    }
    if (p.kind && !VALID_KINDS.has(p.kind)) {
      throw APIError.invalidArgument(`invalid kind '${p.kind}'`);
    }
    const limit = Math.min(Math.max(p.limit ?? 100, 1), 500);
    const offset = Math.max(p.offset ?? 0, 0);

    const t = financeDepotTransaction;
    const conditions = [inArray(t.account_id, ids)];
    if (p.kind) conditions.push(eq(t.kind, p.kind));
    if (from) conditions.push(sql`${t.executed_at} >= ${from}::date`);
    if (to) conditions.push(sql`${t.executed_at} <= ${to}::date`);
    if (p.position) {
      const key = p.position;
      conditions.push(
        or(
          eq(t.isin, key),
          and(sql`${t.isin} IS NULL`, eq(t.wkn, key)),
          and(sql`${t.isin} IS NULL`, sql`${t.wkn} IS NULL`, eq(t.name, key)),
        )!,
      );
    }
    const q = p.q?.trim();
    if (q) {
      const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(ilike(t.name, pattern), ilike(t.isin, pattern), ilike(t.wkn, pattern))!,
      );
    }
    const where = and(...conditions);

    const sortField: TxSortField = p.sortBy ?? "executed_at";
    const dir = p.sortDir === "asc" ? asc : desc;
    const orderBy =
      sortField === "net_amount"
        ? [dir(sql`CAST(${t.net_amount} AS NUMERIC)`), desc(t.executed_at), desc(t.id)]
        : sortField === "name"
          ? [dir(sql`COALESCE(${t.name}, ${t.isin}, ${t.wkn})`), desc(t.executed_at), desc(t.id)]
          : [dir(t.executed_at), dir(t.id)];

    const [rows, [agg]] = await Promise.all([
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({
          total: sql<number>`COUNT(*)::int`,
          net: sql<string>`COALESCE(SUM(CAST(${t.net_amount} AS NUMERIC)), 0)::text`,
          fees: sql<string>`COALESCE(SUM(ABS(CAST(${t.fees} AS NUMERIC))), 0)::text`,
          taxes: sql<string>`COALESCE(SUM(ABS(CAST(${t.tax} AS NUMERIC))), 0)::text`,
        })
        .from(t)
        .where(where),
    ]);

    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const docsById = await documentIdsByDepotTransaction(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        id: r.id,
        account_id: r.account_id,
        account_label: labelById.get(r.account_id) ?? "",
        position_key: positionKey(r),
        isin: r.isin,
        wkn: r.wkn,
        name: r.name,
        kind: r.kind,
        executed_at: dateOnly(r.executed_at),
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
        document_ids: docsById.get(r.id) ?? [],
      })),
      total: agg.total,
      sums: {
        net_amount: Number(agg.net).toFixed(2),
        fees: Number(agg.fees).toFixed(2),
        taxes: Number(agg.taxes).toFixed(2),
      },
    };
  },
);

// ----------------------------------------------------------------------
// One position in detail (#1336, stage 3)
//
// Everything the detail page shows for a single security: the aggregated
// position, how it is split across depots, its value/price history as a
// day series summed over the depots, every transaction, each evaluated
// sale with the cost it was matched against, and income per year.
// ----------------------------------------------------------------------

export interface PositionAccountShare {
  account_id: number;
  account_label: string;
  amount: string | null;
  value: string | null;
  cost_basis: string | null;
  cost_basis_source: CostBasisSource;
  as_of: string | null;
}

export interface PositionHistoryPoint {
  as_of: string;
  /** Sum of the amounts held that day across depots (scale 8). */
  amount: string | null;
  /** Last non-null price reported that day (scale 6). */
  price: string | null;
  /** Sum of the values that day (scale 2). */
  value: string | null;
}

export interface PositionSale {
  transaction_id: number;
  account_id: number;
  executed_at: string;
  quantity: string;
  proceeds: string;
  cost: string;
  cost_per_unit: string;
  gain: string;
}

export interface PositionYear {
  year: number;
  realized: string;
  sell_count: number;
  income: string;
  dividend_count: number;
  fees: string;
  taxes: string;
}

interface PositionParams {
  key: string;
  /** Comma-separated depot account ids; omitted = every readable depot. */
  accounts?: string;
}

interface PositionResponse {
  currency: string;
  position: PortfolioPosition;
  accounts: PositionAccountShare[];
  history: PositionHistoryPoint[];
  transactions: PortfolioTransaction[];
  sales: PositionSale[];
  years: PositionYear[];
  /** Share changes between snapshots no transaction accounts for. */
  holding_gaps: HoldingGap[];
  /** Share changes that could not be checked (a transaction lacks its quantity). */
  unverifiable_changes: number;
}

function matchesKey(
  r: { isin: string | null; wkn: string | null; name: string | null },
  key: string,
): boolean {
  return positionKey(r) === key;
}

export const getPortfolioPosition = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/positions/:key",
    auth: true,
  },
  async ({ key, accounts }: PositionParams): Promise<PositionResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    if (!key || key.trim() === "") {
      throw APIError.invalidArgument("key is required");
    }

    const depots = await visibleDepots(auth, parseAccountIds(accounts));
    const ids = depots.map((d) => d.id);
    if (ids.length === 0) throw APIError.notFound(`position ${key} not found`);

    // The position's figures come from the same fold as the overview, so
    // both pages agree to the cent.
    const [holdings, txs] = await Promise.all([
      latestHoldings(ids),
      loadTransactions(ids),
    ]);
    const built = buildPortfolio(holdings, txs);
    const position = built.positions.find((p) => p.key === key);
    if (!position) throw APIError.notFound(`position ${key} not found`);

    const labelById = new Map(depots.map((d) => [d.id, d.label]));
    const txsByAccount = new Map<number, DepotTxRow[]>();
    for (const tx of txs) {
      if (!matchesKey(tx, key)) continue;
      const list = txsByAccount.get(tx.account_id) ?? [];
      list.push(tx);
      txsByAccount.set(tx.account_id, list);
    }

    // Per-depot share from the latest snapshot of each depot.
    const shares: PositionAccountShare[] = [];
    for (const h of holdings) {
      if (!matchesKey(h, key)) continue;
      const wac = wacIndexFromRows(txsByAccount.get(h.account_id) ?? []);
      const valuation = computeCostBasis(h, wac);
      shares.push({
        account_id: h.account_id,
        account_label: labelById.get(h.account_id) ?? "",
        amount: h.amount,
        value: h.value,
        cost_basis: valuation.costBasisTotal,
        cost_basis_source: valuation.source,
        as_of: dateOnly(h.as_of),
      });
    }
    shares.sort((a, b) => a.account_label.localeCompare(b.account_label));

    // Day series across depots: every snapshot row of this position.
    const historyRows = await db
      .select({
        account_id: financeAccountHolding.account_id,
        as_of: financeAccountHolding.as_of,
        isin: financeAccountHolding.isin,
        wkn: financeAccountHolding.wkn,
        name: financeAccountHolding.name,
        amount: financeAccountHolding.amount,
        price: financeAccountHolding.price,
        value: financeAccountHolding.value,
      })
      .from(financeAccountHolding)
      .where(inArray(financeAccountHolding.account_id, ids))
      .orderBy(asc(financeAccountHolding.as_of), asc(financeAccountHolding.id));
    const byDay = new Map<
      string,
      { amount: number; hasAmount: boolean; value: number; hasValue: boolean; price: number | null }
    >();
    for (const r of historyRows) {
      if (!matchesKey(r, key)) continue;
      const day = dateOnly(r.as_of);
      const d = byDay.get(day) ?? { amount: 0, hasAmount: false, value: 0, hasValue: false, price: null };
      const a = num(r.amount);
      if (a !== null) {
        d.amount += a;
        d.hasAmount = true;
      }
      const v = num(r.value);
      if (v !== null) {
        d.value += v;
        d.hasValue = true;
      }
      const p = num(r.price);
      if (p !== null) d.price = p;
      byDay.set(day, d);
    }
    const history: PositionHistoryPoint[] = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([as_of, d]) => ({
        as_of,
        amount: d.hasAmount ? d.amount.toFixed(8) : null,
        price: d.price === null ? null : d.price.toFixed(6),
        value: d.hasValue ? d.value.toFixed(2) : null,
      }));

    // Sales, replayed per depot exactly as the realized figure is.
    const sales: PositionSale[] = [];
    for (const [accountId, list] of txsByAccount) {
      computeRealizedForPosition(list, (sale) => {
        sales.push({
          transaction_id: sale.transactionId,
          account_id: accountId,
          executed_at: dateOnly(sale.executedAt),
          quantity: sale.quantity.toFixed(8),
          proceeds: sale.proceeds.toFixed(2),
          cost: sale.cost.toFixed(2),
          cost_per_unit: sale.costPerUnit.toFixed(6),
          gain: sale.gain.toFixed(2),
        });
      });
    }
    sales.sort((a, b) => b.executed_at.localeCompare(a.executed_at) || b.transaction_id - a.transaction_id);

    // Per-year figures of this position alone.
    const years = new Map<number, PositionYear>();
    const yearOfPos = (day: string) => {
      const y = yearOf(day);
      if (y === null) return null;
      let b = years.get(y);
      if (!b) {
        b = { year: y, realized: "0", sell_count: 0, income: "0", dividend_count: 0, fees: "0", taxes: "0" };
        years.set(y, b);
      }
      return b;
    };
    const acc = new Map<number, { realized: number; income: number; fees: number; taxes: number }>();
    const accOf = (y: number) => {
      let a = acc.get(y);
      if (!a) {
        a = { realized: 0, income: 0, fees: 0, taxes: 0 };
        acc.set(y, a);
      }
      return a;
    };
    for (const sale of sales) {
      const b = yearOfPos(sale.executed_at);
      if (!b) continue;
      b.sell_count += 1;
      accOf(b.year).realized += Number(sale.gain);
    }
    const positionTxs: PortfolioTransaction[] = [];
    for (const [, list] of txsByAccount) {
      for (const tx of list) {
        const day = dateOnly(tx.executed_at);
        const b = yearOfPos(day);
        if (b) {
          const a = accOf(b.year);
          a.fees += Math.abs(num(tx.fees) ?? 0);
          a.taxes += Math.abs(num(tx.tax) ?? 0);
          if (tx.kind === "dividend") {
            const net = dividendNet(tx);
            if (net !== null) {
              a.income += net;
              b.dividend_count += 1;
            }
          }
        }
        positionTxs.push({
          id: tx.id,
          account_id: tx.account_id,
          account_label: labelById.get(tx.account_id) ?? "",
          position_key: key,
          isin: tx.isin,
          wkn: tx.wkn,
          name: tx.name,
          kind: tx.kind,
          executed_at: day,
          amount: tx.amount,
          price: tx.price,
          gross_amount: tx.gross_amount,
          fees: tx.fees,
          tax: tx.tax,
          net_amount: tx.net_amount,
          currency: tx.currency,
          source: tx.source,
          linked_transaction_id: tx.linked_transaction_id,
          note: tx.note,
          document_ids: [],
        });
      }
    }
    positionTxs.sort((a, b) => b.executed_at.localeCompare(a.executed_at) || b.id - a.id);
    const positionDocs = await documentIdsByDepotTransaction(positionTxs.map((t) => t.id));
    for (const t of positionTxs) t.document_ids = positionDocs.get(t.id) ?? [];

    const yearsOut = [...years.values()]
      .sort((a, b) => b.year - a.year)
      .map((b) => {
        const a = accOf(b.year);
        return {
          ...b,
          realized: a.realized.toFixed(2),
          income: a.income.toFixed(2),
          fees: a.fees.toFixed(2),
          taxes: a.taxes.toFixed(2),
        };
      });

    const recon = await reconcileHoldings(ids, key);

    return {
      currency: scopeCurrency(depots).currency,
      position,
      accounts: shares,
      history,
      transactions: positionTxs,
      sales,
      years: yearsOut,
      holding_gaps: recon.gaps,
      unverifiable_changes: recon.unverifiable,
    };
  },
);

// ----------------------------------------------------------------------
// Read settlement documents into depot transactions (#1336, stage 4)
//
// The same enrichment that runs after a document is classified, on demand
// over every ready settlement that is not linked yet — for a backfill of
// old statements, or after a depot was synced for the first time and the
// holdings that tell a document where it belongs now exist. Only depots
// the caller may write to are touched.
// ----------------------------------------------------------------------

interface EnrichDocumentsParams {
  /** Comma-separated depot account ids; omitted = every writable depot. */
  accounts?: string;
  /** Maximum number of documents examined in this call (default 200). */
  limit?: number;
}

interface EnrichDocumentsResponse {
  documents_examined: number;
  created: number;
  enriched: number;
  linked: number;
  already_linked: number;
  skipped_not_settlement: number;
  skipped_no_holding: number;
  conflicts: number;
  errors: string[];
  /** Per document: only the ones that changed something or need a look. */
  results: EnrichResult[];
}

export const enrichDepotTransactionsFromDocuments = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/enrich",
    auth: true,
  },
  async ({ accounts, limit }: EnrichDocumentsParams): Promise<EnrichDocumentsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await writableDepots(auth, parseAccountIds(accounts));
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const stats = await enrichPendingDocuments(
      depots.map((d) => d.id),
      limit ?? 200,
    );
    return {
      ...stats,
      results: stats.results.filter(
        (r) => r.outcome !== "not_settlement" && r.outcome !== "no_holding",
      ),
    };
  },
);

// ----------------------------------------------------------------------
// What needs a look (#1336, stage 4)
//
// Three kinds of loose ends, across the depots in scope:
//   - conflicts: a settlement whose net disagrees with the transaction it
//     describes (found by a dry run, so the list is always current and
//     disappears once resolved),
//   - unmatched: a settlement no depot in scope holds the security of,
//   - holding gaps: share changes between snapshots no transaction
//     explains.
// Documents are listed only when the caller owns them or is a finance
// admin — a depot being shared does not share its owner's mail.
// ----------------------------------------------------------------------

export interface ReviewConflict {
  document_id: number;
  document_title: string | null;
  account_id: number;
  account_label: string;
  depot_transaction_id: number;
  position_key: string;
  name: string | null;
  kind: string;
  executed_at: string;
  statement_net: string | null;
  transaction_net: string | null;
}

export interface ReviewDocument {
  document_id: number;
  document_title: string | null;
  doc_date: string | null;
}

export interface ReviewHoldingGap extends HoldingGap {
  account_label: string;
  name: string | null;
}

interface ReviewParams {
  accounts?: string;
}

interface ReviewResponse {
  conflicts: ReviewConflict[];
  unmatched_documents: ReviewDocument[];
  holding_gaps: ReviewHoldingGap[];
  unverifiable_changes: number;
}

export const getPortfolioReview = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/review",
    auth: true,
  },
  async ({ accounts }: ReviewParams): Promise<ReviewResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await visibleDepots(auth, parseAccountIds(accounts));
    const ids = depots.map((d) => d.id);
    if (ids.length === 0) {
      return { conflicts: [], unmatched_documents: [], holding_gaps: [], unverifiable_changes: 0 };
    }
    const labelById = new Map(depots.map((d) => [d.id, d.label]));

    const [dry, recon] = await Promise.all([
      enrichPendingDocuments(ids, 200, { dryRun: true }),
      reconcileHoldings(ids),
    ]);

    const relevant = dry.results.filter((r) => r.outcome === "conflict" || r.outcome === "no_holding");
    const docIds = [...new Set(relevant.map((r) => r.document_id))];
    const docRows = docIds.length
      ? await db
          .select({ id: documents.id, title: documents.title, user_id: documents.user_id, doc_date: documents.doc_date })
          .from(documents)
          .where(inArray(documents.id, docIds))
      : [];
    const mayShow = (userId: number) => hasAdmin(auth) || userId === Number(auth.userID);
    const docById = new Map(docRows.filter((d) => mayShow(d.user_id)).map((d) => [d.id, d]));

    const conflictTxIds = relevant
      .filter((r) => r.outcome === "conflict" && r.depot_transaction_id !== null)
      .map((r) => r.depot_transaction_id!);
    const txRows = conflictTxIds.length
      ? await db
          .select({
            id: financeDepotTransaction.id,
            account_id: financeDepotTransaction.account_id,
            isin: financeDepotTransaction.isin,
            wkn: financeDepotTransaction.wkn,
            name: financeDepotTransaction.name,
            kind: financeDepotTransaction.kind,
            executed_at: financeDepotTransaction.executed_at,
          })
          .from(financeDepotTransaction)
          .where(inArray(financeDepotTransaction.id, conflictTxIds))
      : [];
    const txById = new Map(txRows.map((t) => [t.id, t]));

    const conflicts: ReviewConflict[] = [];
    const unmatched: ReviewDocument[] = [];
    for (const r of relevant) {
      const doc = docById.get(r.document_id);
      if (!doc) continue;
      if (r.outcome === "no_holding") {
        unmatched.push({ document_id: doc.id, document_title: doc.title, doc_date: doc.doc_date });
        continue;
      }
      const tx = r.depot_transaction_id === null ? undefined : txById.get(r.depot_transaction_id);
      if (!tx) continue;
      conflicts.push({
        document_id: doc.id,
        document_title: doc.title,
        account_id: tx.account_id,
        account_label: labelById.get(tx.account_id) ?? "",
        depot_transaction_id: tx.id,
        position_key: positionKey(tx),
        name: tx.name,
        kind: tx.kind,
        executed_at: dateOnly(tx.executed_at),
        statement_net: r.statement_net,
        transaction_net: r.transaction_net,
      });
    }

    // Names for the gap rows from the latest snapshot that carries one.
    const names = new Map<string, string | null>();
    if (recon.gaps.length > 0) {
      const rows = await db
        .select({
          isin: financeAccountHolding.isin,
          wkn: financeAccountHolding.wkn,
          name: financeAccountHolding.name,
        })
        .from(financeAccountHolding)
        .where(inArray(financeAccountHolding.account_id, ids))
        .orderBy(desc(financeAccountHolding.as_of));
      for (const row of rows) {
        const k = positionKey(row);
        if (k && !names.has(k) && row.name) names.set(k, row.name);
      }
    }

    return {
      conflicts,
      unmatched_documents: unmatched,
      holding_gaps: recon.gaps.map((g) => ({
        ...g,
        account_label: labelById.get(g.account_id) ?? "",
        name: names.get(g.position_key) ?? null,
      })),
      unverifiable_changes: recon.unverifiable,
    };
  },
);

interface ApplyDocumentParams {
  documentId: number;
}

export const applySettlementDocument = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/portfolio/documents/:documentId/apply",
    auth: true,
  },
  async ({ documentId }: ApplyDocumentParams): Promise<EnrichResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const depots = await writableDepots(auth, null);
    if (depots.length === 0) {
      throw APIError.permissionDenied("write access to at least one depot is required");
    }
    const [doc] = await db
      .select({ user_id: documents.user_id })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc || (!hasAdmin(auth) && doc.user_id !== Number(auth.userID))) {
      throw APIError.notFound(`document ${documentId} not found`);
    }
    const r = await enrichDocument(documentId, depots.map((d) => d.id), { overwrite: true });
    if (r.outcome === "not_settlement" || r.outcome === "no_holding") {
      throw APIError.failedPrecondition(`document ${documentId} cannot be applied (${r.outcome})`);
    }
    return r;
  },
);
