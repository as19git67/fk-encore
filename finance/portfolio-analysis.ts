/**
 * Portfolio analyses (#1700): allocation, income over time and savings
 * plans for the depots in scope — the same scope, ACL and valuation as
 * `/finance/portfolio`, so the figures agree with the overview.
 *
 * Depots of different currencies are never added up: allocation and
 * income come per currency of account. The allocation by currency is the
 * one view across them, and it stays nominal.
 *
 * The threshold above which a position counts as concentrated is the
 * user's setting (`finance_user_pref`, key "portfolio").
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeQuoteSymbol, financeUserPref } from "../db/schema";
import { securityIdentity } from "./security-identity";
import { latestQuotes, quoteDay } from "./quote-store";
import {
  accumulationTax,
  buildPortfolio,
  cashOf,
  dividendNet,
  householdNames,
  latestHoldings,
  loadTransactions,
  parseAccountIds,
  positionKey,
  quotedKeys,
  scopeDepots,
  visibleDepots,
  withData,
  type DepotAccount,
  type DepotTxRow,
} from "./portfolio";
import {
  allocate,
  detectSavingsPlans,
  incomeOverTime,
  type AllocationSlice,
  type IncomeEvent,
  type PlanInterval,
} from "./portfolio-analysis-calc";

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------

const PREF_KEY = "portfolio";

/** The threshold a user who never set one sees. */
export const DEFAULT_CONCENTRATION_PCT = 10;

export interface PortfolioSettings {
  /** A position above this share of its group's value is flagged (percent). */
  concentration_threshold_pct: number;
}

async function loadSettings(userId: number): Promise<PortfolioSettings> {
  const [row] = await db
    .select({ value: financeUserPref.value })
    .from(financeUserPref)
    .where(and(eq(financeUserPref.user_id, userId), eq(financeUserPref.key, PREF_KEY)))
    .limit(1);
  const raw = (row?.value as { concentration_threshold_pct?: unknown } | undefined)?.concentration_threshold_pct;
  const pct = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_CONCENTRATION_PCT;
  return { concentration_threshold_pct: pct };
}

export const getPortfolioSettings = api(
  { expose: true, method: "GET", path: "/finance/portfolio/settings", auth: true },
  async (): Promise<PortfolioSettings> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    return loadSettings(Number(auth.userID));
  },
);

export const savePortfolioSettings = api(
  { expose: true, method: "PUT", path: "/finance/portfolio/settings", auth: true },
  async ({ concentration_threshold_pct }: PortfolioSettings): Promise<PortfolioSettings> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const pct = Number(concentration_threshold_pct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw APIError.invalidArgument("concentration_threshold_pct must be above 0 and at most 100");
    }
    const value = { concentration_threshold_pct: pct };
    await db
      .insert(financeUserPref)
      .values({ user_id: Number(auth.userID), key: PREF_KEY, value })
      .onConflictDoUpdate({
        target: [financeUserPref.user_id, financeUserPref.key],
        set: { value, updated_at: new Date().toISOString() },
      });
    return value;
  },
);

// ----------------------------------------------------------------------
// Analysis
// ----------------------------------------------------------------------

function fixed(n: number | null): string | null {
  return n === null || !Number.isFinite(n) ? null : n.toFixed(2);
}

export interface AllocationSliceOut {
  key: string;
  label: string;
  value: string;
  weight_pct: string;
  positions: number;
}

function slice(s: AllocationSlice): AllocationSliceOut {
  return { key: s.key, label: s.label, value: s.value.toFixed(2), weight_pct: s.weight_pct.toFixed(2), positions: s.positions };
}

export interface AnalysisGroup {
  currency: string;
  account_ids: number[];
  market_value: string;
  by_security: AllocationSliceOut[];
  by_type: AllocationSliceOut[];
  /** Positions above the threshold, heaviest first. */
  concentrated: AllocationSliceOut[];
  /** Open positions without a price, left out of the weights. */
  unvalued_positions: number;
  income: {
    months: Array<{ month: string; income: string; payouts: number }>;
    years: Array<{ year: number; income: string; payouts: number }>;
    /** Income of the last twelve months. */
    ttm: string;
    /** The day before the twelve months start (YYYY-MM-DD). */
    ttm_from: string;
    /** ttm / market value, percent. */
    current_yield_pct: string | null;
    /** ttm / cost basis of the open positions, percent; null when a cost basis is missing. */
    yield_on_cost_pct: string | null;
  };
}

export interface CurrencySlice {
  currency: string;
  /** Nominal sum in that currency, scale 2. */
  value: string;
  positions: number;
}

export interface SavingsPlanOut {
  account_id: number;
  account_label: string;
  key: string;
  name: string | null;
  interval: PlanInterval;
  /** Median cash per execution, scale 2. */
  amount: string;
  currency: string;
  executions: number;
  first: string;
  last: string;
  active: boolean;
  next: string | null;
}

interface AnalysisParams {
  /** Comma-separated depot account ids; omitted = every open readable depot. */
  accounts?: string;
  /** Include closed depots when no `accounts` are given. */
  closed?: boolean;
}

interface AnalysisResponse {
  today: string;
  mixed_currency: boolean;
  concentration_threshold_pct: number;
  groups: AnalysisGroup[];
  /** Value of the open positions per currency of the position, nominal. */
  by_currency: CurrencySlice[];
  savings_plans: SavingsPlanOut[];
}

function incomeEvents(txs: DepotTxRow[]): IncomeEvent[] {
  const out: IncomeEvent[] = [];
  for (const tx of txs) {
    const amount = tx.kind === "dividend" ? dividendNet(tx) : tx.kind === "tax" ? accumulationTax(tx) : null;
    if (amount === null) continue;
    out.push({ day: tx.executed_at.slice(0, 10), amount, payout: tx.kind === "dividend" });
  }
  return out;
}

/** Savings plans among these transactions, keyed and labelled for the response. */
export function savingsPlansOf(
  txs: DepotTxRow[],
  today: string,
  meta: { labelById: ReadonlyMap<number, string>; nameByKey: ReadonlyMap<string, string | null>; currencyById: ReadonlyMap<number, string> },
): SavingsPlanOut[] {
  const buys = txs
    .filter((t) => t.kind === "buy")
    .map((t) => ({ account_id: t.account_id, key: positionKey(t), day: t.executed_at.slice(0, 10), cash: cashOf(t) }));
  return detectSavingsPlans(buys, today).map((p) => ({
    account_id: p.account_id,
    account_label: meta.labelById.get(p.account_id) ?? "",
    key: p.key,
    name: meta.nameByKey.get(p.key) ?? null,
    interval: p.interval,
    amount: p.amount.toFixed(2),
    currency: meta.currencyById.get(p.account_id) ?? "EUR",
    executions: p.executions,
    first: p.first,
    last: p.last,
    active: p.active,
    next: p.next,
  }));
}

function byCurrencyGroups(depots: DepotAccount[]): Array<{ currency: string; account_ids: number[] }> {
  const groups = new Map<string, number[]>();
  for (const d of depots) {
    const code = d.currency_code || "EUR";
    (groups.get(code) ?? groups.set(code, []).get(code)!).push(d.id);
  }
  return [...groups.entries()]
    .map(([currency, account_ids]) => ({ currency, account_ids }))
    .sort((a, b) => b.account_ids.length - a.account_ids.length || a.currency.localeCompare(b.currency));
}

export const getPortfolioAnalysis = api(
  { expose: true, method: "GET", path: "/finance/portfolio/analysis", auth: true },
  async ({ accounts, closed }: AnalysisParams): Promise<AnalysisResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const today = quoteDay(new Date().toISOString());
    const settings = await loadSettings(Number(auth.userID));

    const depots = scopeDepots(await withData(await visibleDepots(auth, null)), parseAccountIds(accounts), closed === true);
    const groups = byCurrencyGroups(depots);
    const response: AnalysisResponse = {
      today,
      mixed_currency: groups.length > 1,
      concentration_threshold_pct: settings.concentration_threshold_pct,
      groups: [],
      by_currency: [],
      savings_plans: [],
    };
    if (depots.length === 0) return response;

    const identity = await securityIdentity();
    const ids = depots.map((d) => d.id);
    const [holdings, txs, people] = await Promise.all([
      latestHoldings(ids, identity),
      loadTransactions(ids, identity),
      householdNames(),
    ]);
    const quotes = await latestQuotes(quotedKeys(holdings));
    const keys = [...new Set([...holdings.map(positionKey), ...txs.map(positionKey)])].filter(Boolean);
    const typeRows = keys.length
      ? await db
          .select({ key: financeQuoteSymbol.position_key, type: financeQuoteSymbol.security_type })
          .from(financeQuoteSymbol)
          .where(inArray(financeQuoteSymbol.position_key, keys))
      : [];
    const typeByKey = new Map(typeRows.map((r) => [r.key, r.type]));

    const nameByKey = new Map<string, string | null>();
    const byCurrency = new Map<string, { value: number; positions: number }>();

    for (const g of groups) {
      const inGroup = new Set(g.account_ids);
      const groupTxs = txs.filter((t) => inGroup.has(t.account_id));
      const built = buildPortfolio(
        holdings.filter((h) => inGroup.has(h.account_id)),
        groupTxs,
        people,
        quotes,
      );
      const open = built.positions.filter((p) => p.open);
      for (const p of built.positions) nameByKey.set(p.key, p.name);
      for (const p of open) {
        if (p.value === null) continue;
        const code = p.currency || g.currency;
        const c = byCurrency.get(code) ?? { value: 0, positions: 0 };
        c.value += Number(p.value);
        c.positions += 1;
        byCurrency.set(code, c);
      }

      const allocation = allocate(
        open.map((p) => ({
          key: p.key,
          name: p.name,
          currency: p.currency,
          value: p.value === null ? null : Number(p.value),
          security_type: typeByKey.get(p.key) ?? null,
        })),
        settings.concentration_threshold_pct,
      );
      const income = incomeOverTime(
        incomeEvents(groupTxs),
        today,
        allocation.market_value,
        built.summary.cost_basis_complete ? Number(built.summary.cost_basis) : null,
      );
      if (allocation.by_security.length === 0 && income.months.length === 0) continue;

      response.groups.push({
        currency: g.currency,
        account_ids: g.account_ids,
        market_value: allocation.market_value.toFixed(2),
        by_security: allocation.by_security.map(slice),
        by_type: allocation.by_type.map(slice),
        concentrated: allocation.concentrated.map(slice),
        unvalued_positions: allocation.unvalued,
        income: {
          months: income.months.map((m) => ({ month: m.month, income: m.income.toFixed(2), payouts: m.payouts })),
          years: income.years.map((y) => ({ year: y.year, income: y.income.toFixed(2), payouts: y.payouts })),
          ttm: income.ttm.toFixed(2),
          ttm_from: income.ttm_from,
          current_yield_pct: fixed(income.current_yield_pct),
          yield_on_cost_pct: fixed(income.yield_on_cost_pct),
        },
      });
    }

    response.by_currency = [...byCurrency.entries()]
      .map(([currency, c]) => ({ currency, value: c.value.toFixed(2), positions: c.positions }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
    response.savings_plans = savingsPlansOf(txs, today, {
      labelById: new Map(depots.map((d) => [d.id, d.label])),
      nameByKey,
      currencyById: new Map(depots.map((d) => [d.id, d.currency_code || "EUR"])),
    });
    return response;
  },
);
