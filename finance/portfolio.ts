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
