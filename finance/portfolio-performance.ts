/**
 * Portfolio performance over time (#1700): the value of the depots in
 * scope as a day series, the net invested capital next to it, and the
 * time-weighted (TWR) and money-weighted (XIRR) return of a period — for
 * the whole portfolio and for each position.
 *
 * The arithmetic lives in portfolio-performance-calc.ts; this module reads
 * the snapshots, transactions and stored closes the same way the overview
 * does (scope, ACL, one identity per security) and hands them over.
 *
 * Depots of different currencies are never added up: each currency is its
 * own group with its own series and returns, until amounts can be
 * converted.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, eq, inArray } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeAccountHolding, financeQuote } from "../db/schema";
import { dedupeSnapshotRows, securityIdentity } from "./security-identity";
import { isoTimestamp, latestQuotes, quoteDay, quoteFitsCurrency } from "./quote-store";
import {
  accumulationTax,
  cashOf,
  dividendNet,
  loadTransactions,
  normalizeKey,
  parseAccountIds,
  positionKey,
  scopeDepots,
  visibleDepots,
  withData,
  type DepotAccount,
  type DepotTxRow,
} from "./portfolio";
import {
  buildValueSeries,
  periodPerformance,
  PERFORMANCE_PERIODS,
  PRICE_STALE_DAYS,
  restrictToKey,
  type PerfSnapshotRow,
  type PerfTx,
  type PerformanceInput,
  type PerformancePeriod,
  type PeriodPerformance,
  type PriceObservation,
} from "./portfolio-performance-calc";

// ----------------------------------------------------------------------
// Response
// ----------------------------------------------------------------------

export interface PerformancePoint {
  /** YYYY-MM-DD */
  day: string;
  /** Market value (scale 2); null when a security held had no recent price. */
  value: string | null;
  /** Net invested capital (scale 2). */
  invested: string;
  /** Time-weighted return since the period's start, in percent (scale 2). */
  twr_pct: string | null;
}

export interface PerformanceGap {
  from: string;
  to: string;
}

export interface PerformanceFigures {
  /** Day of the value the period is measured from. */
  from: string;
  /** Day of the last value. */
  to: string;
  /** The history does not reach back to the period's start. */
  shortened: boolean;
  start_value: string;
  end_value: string;
  /** Money into the securities minus money out (dividends count as out), scale 2. */
  net_flow: string;
  /** Dividends net of tax over the period, scale 2. */
  income: string;
  /** end − start − net flow, scale 2. */
  gain: string;
  /** Time-weighted return over the period, percent (scale 2). */
  twr_pct: string | null;
  /** The same per year; null for periods shorter than a year. */
  twr_pa_pct: string | null;
  /** Money-weighted return per year (XIRR), percent (scale 2). */
  xirr_pct: string | null;
  /** The money-weighted return over the period, not annualised, percent (scale 2). */
  mwr_pct: string | null;
  unvalued_days: number;
}

export interface PositionPerformance extends PerformanceFigures {
  key: string;
}

export interface PerformanceGroup extends PerformanceFigures {
  currency: string;
  account_ids: number[];
  points: PerformancePoint[];
  gaps: PerformanceGap[];
  /** Buys, sells or transfers that could not be valued (no cash, no price). */
  unvalued_flows: number;
  /** Net value of shares the snapshots showed without a trade, counted as moved in or out (scale 2). */
  implied_inflow: string;
  /** Per position, in the group's currency; empty when one position was asked for. */
  positions: PositionPerformance[];
}

interface PerformanceParams {
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
  /** 1M | YTD | 1Y | 3Y | max (default 1Y). */
  period?: string;
  /** Position key: the figures of this security alone. */
  position?: string;
}

interface PerformanceResponse {
  period: PerformancePeriod;
  /** YYYY-MM-DD (Berlin) the figures run up to. */
  today: string;
  /** A price older than this many days does not value a holding. */
  price_stale_days: number;
  /** True when the depots in scope use more than one currency: one group per currency. */
  mixed_currency: boolean;
  groups: PerformanceGroup[];
}

// ----------------------------------------------------------------------
// Loading
// ----------------------------------------------------------------------

function dateOnly(raw: string): string {
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

function num(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Every snapshot row of these depots, the newest snapshot of each day only. */
async function loadSnapshots(
  accountIds: number[],
  identity: Awaited<ReturnType<typeof securityIdentity>>,
): Promise<Array<PerfSnapshotRow & { currency: string | null }>> {
  if (accountIds.length === 0) return [];
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
      source: financeAccountHolding.source,
    })
    .from(financeAccountHolding)
    .where(inArray(financeAccountHolding.account_id, accountIds))
    .orderBy(asc(financeAccountHolding.as_of), asc(financeAccountHolding.id));

  // A depot synced twice a day: the later picture of that day stands.
  const newest = new Map<string, string>();
  for (const r of rows) {
    const id = `${r.account_id}|${dateOnly(r.as_of)}`;
    const prev = newest.get(id);
    if (!prev || r.as_of > prev) newest.set(id, r.as_of);
  }
  const ofDay = rows.filter((r) => newest.get(`${r.account_id}|${dateOnly(r.as_of)}`) === r.as_of);

  return dedupeSnapshotRows(ofDay.map((r) => identity.complete(r))).map((r) => {
    const amount = num(r.amount);
    const value = num(r.value);
    const price = num(r.price) ?? (amount && value !== null ? value / amount : null);
    return {
      account_id: r.account_id,
      day: dateOnly(r.as_of),
      key: positionKey(r),
      amount,
      price,
      currency: r.currency,
    };
  });
}

function toPerfTx(tx: DepotTxRow): PerfTx {
  const kind = tx.kind;
  const income = kind === "dividend" ? dividendNet(tx) : kind === "tax" ? accumulationTax(tx) : null;
  return {
    account_id: tx.account_id,
    key: positionKey(tx),
    kind,
    day: dateOnly(tx.executed_at),
    amount: num(tx.amount),
    price: num(tx.price),
    cash: kind === "buy" || kind === "sell" ? cashOf(tx) : null,
    income,
  };
}

/** The daily closes of these positions, plus each one's newest price as today's. */
async function loadPrices(keys: string[], currencyOf: ReadonlyMap<string, string | null>): Promise<PriceObservation[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({
      key: financeQuote.position_key,
      at: financeQuote.at,
      price: financeQuote.price,
      currency: financeQuote.currency,
    })
    .from(financeQuote)
    .where(and(inArray(financeQuote.position_key, keys), eq(financeQuote.kind, "daily")))
    .orderBy(asc(financeQuote.at));
  const out: PriceObservation[] = [];
  for (const r of rows) {
    const price = Number(r.price);
    if (!Number.isFinite(price) || !quoteFitsCurrency(r.currency, currencyOf.get(r.key) ?? null)) continue;
    out.push({ key: r.key, day: quoteDay(isoTimestamp(r.at)), price });
  }
  for (const [key, q] of await latestQuotes(keys)) {
    if (!quoteFitsCurrency(q.currency, currencyOf.get(key) ?? null)) continue;
    out.push({ key, day: quoteDay(q.at), price: q.price });
  }
  return out;
}

// ----------------------------------------------------------------------
// Shaping
// ----------------------------------------------------------------------

function pct(x: number | null): string | null {
  return x === null || !Number.isFinite(x) ? null : (x * 100).toFixed(2);
}

function figures(p: PeriodPerformance): PerformanceFigures {
  return {
    from: p.from,
    to: p.to,
    shortened: p.shortened,
    start_value: p.start_value.toFixed(2),
    end_value: p.end_value.toFixed(2),
    net_flow: p.net_flow.toFixed(2),
    income: p.income.toFixed(2),
    gain: p.gain.toFixed(2),
    twr_pct: pct(p.twr),
    twr_pa_pct: pct(p.twr_pa),
    xirr_pct: pct(p.xirr),
    mwr_pct: pct(p.mwr),
    unvalued_days: p.unvalued_days,
  };
}

function parsePeriod(raw: string | undefined): PerformancePeriod {
  if (!raw) return "1Y";
  const p = PERFORMANCE_PERIODS.find((x) => x.toLowerCase() === raw.toLowerCase());
  if (!p) throw APIError.invalidArgument(`period must be one of ${PERFORMANCE_PERIODS.join(", ")}`);
  return p;
}

/** The figures of one group of depots sharing a currency. */
export function groupPerformance(
  input: PerformanceInput,
  period: PerformancePeriod,
  meta: { currency: string; account_ids: number[] },
  withPositions: boolean,
): PerformanceGroup | null {
  const series = buildValueSeries(input);
  const p = periodPerformance(series, period, input.today);
  if (!p) return null;

  const positions: PositionPerformance[] = [];
  if (withPositions) {
    const keys = new Set([...input.snapshots.map((s) => s.key), ...input.txs.map((t) => t.key)]);
    for (const key of keys) {
      const pp = periodPerformance(buildValueSeries(restrictToKey(input, key)), period, input.today);
      // A position neither held nor traded in the period has nothing to say.
      if (!pp || (pp.start_value === 0 && pp.end_value === 0 && pp.net_flow === 0 && pp.income === 0)) continue;
      positions.push({ key, ...figures(pp) });
    }
    positions.sort((a, b) => Number(b.end_value) - Number(a.end_value) || a.key.localeCompare(b.key));
  }

  return {
    currency: meta.currency,
    account_ids: meta.account_ids,
    ...figures(p),
    points: p.points.map((pt) => ({
      day: pt.day,
      value: pt.value === null ? null : pt.value.toFixed(2),
      invested: pt.invested.toFixed(2),
      twr_pct: pt.twr_pct === null ? null : pt.twr_pct.toFixed(2),
    })),
    gaps: p.gaps,
    unvalued_flows: series.unvalued_flows,
    implied_inflow: series.implied_inflow.toFixed(2),
    positions,
  };
}

/** Depots grouped by their currency, the larger groups first. */
function byCurrency(depots: DepotAccount[]): Array<{ currency: string; account_ids: number[] }> {
  const groups = new Map<string, number[]>();
  for (const d of depots) {
    const code = d.currency_code || "EUR";
    (groups.get(code) ?? groups.set(code, []).get(code)!).push(d.id);
  }
  return [...groups.entries()]
    .map(([currency, account_ids]) => ({ currency, account_ids }))
    .sort((a, b) => b.account_ids.length - a.account_ids.length || a.currency.localeCompare(b.currency));
}

export const getPortfolioPerformance = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/portfolio/performance",
    auth: true,
  },
  async ({ accounts, closed, period: rawPeriod, position }: PerformanceParams): Promise<PerformanceResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const period = parsePeriod(rawPeriod);
    const today = quoteDay(new Date().toISOString());

    const depots = scopeDepots(await withData(await visibleDepots(auth, null)), parseAccountIds(accounts), closed === true);
    const groups = byCurrency(depots);
    const response: PerformanceResponse = {
      period,
      today,
      price_stale_days: PRICE_STALE_DAYS,
      mixed_currency: groups.length > 1,
      groups: [],
    };
    if (depots.length === 0) return response;

    const identity = await securityIdentity();
    const ids = depots.map((d) => d.id);
    const [snapshots, txRows] = await Promise.all([loadSnapshots(ids, identity), loadTransactions(ids, identity)]);
    const txs = txRows.map(toPerfTx);
    const wantedKey = position && position.trim() ? normalizeKey(identity, position.trim()) : null;
    if (wantedKey && !snapshots.some((s) => s.key === wantedKey) && !txs.some((t) => t.key === wantedKey)) {
      throw APIError.notFound(`position ${wantedKey} not found`);
    }

    const currencyOf = new Map<string, string | null>();
    for (const s of snapshots) if (s.currency && !currencyOf.has(s.key)) currencyOf.set(s.key, s.currency);
    for (const t of txRows) {
      const key = positionKey(t);
      if (t.currency && !currencyOf.has(key)) currencyOf.set(key, t.currency);
    }
    // Quotes are kept under the position key (ISIN or WKN); a name finds none.
    const quoted = wantedKey
      ? [wantedKey]
      : [...new Set([...snapshots.map((s) => s.key), ...txs.map((t) => t.key)])];
    const prices = await loadPrices(quoted, currencyOf);

    for (const g of groups) {
      const inGroup = new Set(g.account_ids);
      let input: PerformanceInput = {
        snapshots: snapshots.filter((s) => inGroup.has(s.account_id)),
        txs: txs.filter((t) => inGroup.has(t.account_id)),
        prices,
        today,
      };
      if (wantedKey) input = restrictToKey(input, wantedKey);
      const out = groupPerformance(input, period, g, wantedKey === null);
      if (out) response.groups.push(out);
    }
    return response;
  },
);
