/**
 * Portfolio analyses — the arithmetic, free of the database (#1700):
 *
 *   - allocation of the market value by security, by type of security
 *     (as the quote provider names it) and by currency, with a hint for
 *     positions above a threshold the user sets;
 *   - income over time: dividends net of tax per month and per year, the
 *     last twelve months, and their yield on today's value next to the
 *     yield on what the positions cost;
 *   - savings plans: buys of one security in one depot at a regular
 *     interval and a steady amount.
 */

const EPS = 1e-9;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------
// Allocation
// ----------------------------------------------------------------------

/** An open position as the overview values it. */
export interface AllocationInput {
  key: string;
  name: string | null;
  currency: string | null;
  value: number | null;
  /** "equity" | "etf" | "fund" | "other" | null (unknown). */
  security_type: string | null;
}

export interface AllocationSlice {
  /** The security's key, the type or the currency. */
  key: string;
  label: string;
  value: number;
  /** Share of the group's value in percent. */
  weight_pct: number;
  positions: number;
}

export interface Allocation {
  market_value: number;
  by_security: AllocationSlice[];
  by_type: AllocationSlice[];
  /** Positions whose weight is above the threshold. */
  concentrated: AllocationSlice[];
  /** Open positions without a value (no price): left out of the weights. */
  unvalued: number;
}

export const TYPE_LABELS: Record<string, string> = {
  equity: "Aktien",
  etf: "ETFs",
  fund: "Fonds",
  other: "Sonstige",
  unknown: "Unbekannt",
};

function slices(groups: Map<string, { label: string; value: number; positions: number }>, total: number): AllocationSlice[] {
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: g.label,
      value: g.value,
      weight_pct: total > EPS ? (g.value / total) * 100 : 0,
      positions: g.positions,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** The allocation of positions that share one currency of account. */
export function allocate(positions: AllocationInput[], thresholdPct: number): Allocation {
  const valued = positions.filter((p) => p.value !== null && p.value > EPS);
  const total = valued.reduce((s, p) => s + p.value!, 0);

  const bySecurity = new Map<string, { label: string; value: number; positions: number }>();
  const byType = new Map<string, { label: string; value: number; positions: number }>();
  for (const p of valued) {
    bySecurity.set(p.key, { label: p.name ?? p.key, value: p.value!, positions: 1 });
    const type = p.security_type && TYPE_LABELS[p.security_type] ? p.security_type : "unknown";
    const t = byType.get(type) ?? { label: TYPE_LABELS[type]!, value: 0, positions: 0 };
    t.value += p.value!;
    t.positions += 1;
    byType.set(type, t);
  }
  const securities = slices(bySecurity, total);
  return {
    market_value: total,
    by_security: securities,
    by_type: slices(byType, total),
    concentrated: securities.filter((s) => s.weight_pct > thresholdPct + EPS),
    unvalued: positions.length - valued.length,
  };
}

// ----------------------------------------------------------------------
// Income over time
// ----------------------------------------------------------------------

export interface IncomeEvent {
  /** YYYY-MM-DD */
  day: string;
  /** Net income: a dividend positive, a tax on kept income negative. */
  amount: number;
  /** A payout (dividend) rather than a tax on kept income. */
  payout: boolean;
}

export interface IncomeMonth {
  /** YYYY-MM */
  month: string;
  income: number;
  payouts: number;
}

export interface IncomeYear {
  year: number;
  income: number;
  payouts: number;
}

export interface IncomeOverTime {
  months: IncomeMonth[];
  years: IncomeYear[];
  /** Income of the twelve months up to today (today's month included, its first day a year back excluded). */
  ttm: number;
  ttm_from: string;
  /** ttm / today's market value, percent; null without a value. */
  current_yield_pct: number | null;
  /** ttm / cost basis of the open positions, percent; null without a cost basis. */
  yield_on_cost_pct: number | null;
}

function shiftMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Income per month (every month from the first income to today, empty
 * ones included, so a bar chart shows the gaps) and per year.
 */
export function incomeOverTime(
  events: IncomeEvent[],
  today: string,
  marketValue: number,
  costBasis: number | null,
): IncomeOverTime {
  const byMonth = new Map<string, IncomeMonth>();
  for (const e of events) {
    if (e.day > today) continue;
    const month = e.day.slice(0, 7);
    const m = byMonth.get(month) ?? { month, income: 0, payouts: 0 };
    m.income += e.amount;
    if (e.payout) m.payouts += 1;
    byMonth.set(month, m);
  }

  const months: IncomeMonth[] = [];
  const known = [...byMonth.keys()].sort();
  if (known.length > 0) {
    let cursor = `${known[0]}-01`;
    const last = today.slice(0, 7);
    while (cursor.slice(0, 7) <= last) {
      const month = cursor.slice(0, 7);
      months.push(byMonth.get(month) ?? { month, income: 0, payouts: 0 });
      cursor = shiftMonths(cursor, 1);
    }
  }

  const byYear = new Map<number, IncomeYear>();
  for (const m of months) {
    const year = Number(m.month.slice(0, 4));
    const y = byYear.get(year) ?? { year, income: 0, payouts: 0 };
    y.income += m.income;
    y.payouts += m.payouts;
    byYear.set(year, y);
  }

  const ttmFrom = shiftMonths(today, -12);
  let ttm = 0;
  for (const e of events) if (e.day > ttmFrom && e.day <= today) ttm += e.amount;

  return {
    months,
    years: [...byYear.values()].sort((a, b) => a.year - b.year),
    ttm,
    ttm_from: ttmFrom,
    current_yield_pct: marketValue > EPS ? (ttm / marketValue) * 100 : null,
    yield_on_cost_pct: costBasis !== null && costBasis > EPS ? (ttm / costBasis) * 100 : null,
  };
}

// ----------------------------------------------------------------------
// Savings plans
// ----------------------------------------------------------------------

export interface PlanBuy {
  account_id: number;
  key: string;
  /** YYYY-MM-DD */
  day: string;
  /** Cash paid; null when unknown. */
  cash: number | null;
}

export type PlanInterval = "monthly" | "bimonthly" | "quarterly" | "semiannual" | "annual";

/** Days between two executions each interval accepts (bank holidays, weekends, month lengths). */
const INTERVALS: Array<{ interval: PlanInterval; min: number; max: number; days: number }> = [
  { interval: "monthly", min: 24, max: 38, days: 30.44 },
  { interval: "bimonthly", min: 53, max: 69, days: 60.88 },
  { interval: "quarterly", min: 81, max: 101, days: 91.31 },
  { interval: "semiannual", min: 170, max: 196, days: 182.62 },
  { interval: "annual", min: 350, max: 380, days: 365.25 },
];

/** A savings plan needs this many executions in a row. */
export const PLAN_MIN_BUYS = 3;

/** Amounts within this share of the plan's median count as the same rate. */
const PLAN_AMOUNT_TOLERANCE = 0.15;

export interface SavingsPlan {
  account_id: number;
  key: string;
  interval: PlanInterval;
  /** Median cash per execution. */
  amount: number;
  executions: number;
  first: string;
  last: string;
  /** The next execution was due no longer ago than half an interval. */
  active: boolean;
  /** When the next execution is due, for an active plan. */
  next: string | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + Math.round(n) * MS_PER_DAY).toISOString().slice(0, 10);
}

function intervalOf(gap: number): PlanInterval | null {
  return INTERVALS.find((i) => gap >= i.min && gap <= i.max)?.interval ?? null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function steady(amounts: number[]): boolean {
  if (amounts.length === 0) return false;
  const m = median(amounts);
  return m > EPS && amounts.every((a) => Math.abs(a - m) <= m * PLAN_AMOUNT_TOLERANCE + EPS);
}

/**
 * Savings plans among the buys: per depot and security, the runs of at
 * least PLAN_MIN_BUYS buys in a row at one interval and a steady amount.
 * A buy off the rhythm (a one-off purchase) ends a run; a plan whose rate
 * changed shows as two plans.
 */
export function detectSavingsPlans(buys: PlanBuy[], today: string): SavingsPlan[] {
  const groups = new Map<string, PlanBuy[]>();
  for (const b of buys) {
    if (b.cash === null || b.cash <= EPS || b.day > today) continue;
    const id = `${b.account_id}|${b.key}`;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(b);
  }

  const plans: SavingsPlan[] = [];
  for (const list of groups.values()) {
    // Two executions on one day are one (a split order, a fee row read twice).
    const byDay = new Map<string, PlanBuy>();
    for (const b of list) {
      const prev = byDay.get(b.day);
      byDay.set(b.day, prev ? { ...prev, cash: prev.cash! + b.cash! } : b);
    }
    const sorted = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

    let start = 0;
    while (start < sorted.length - 1) {
      const interval = intervalOf(daysBetween(sorted[start]!.day, sorted[start + 1]!.day));
      if (!interval) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end + 1 < sorted.length) {
        const next = sorted[end + 1]!;
        if (intervalOf(daysBetween(sorted[end]!.day, next.day)) !== interval) break;
        if (!steady(sorted.slice(start, end + 2).map((b) => b.cash!))) break;
        end += 1;
      }
      const run = sorted.slice(start, end + 1);
      if (run.length >= PLAN_MIN_BUYS && steady(run.map((b) => b.cash!))) {
        const spec = INTERVALS.find((i) => i.interval === interval)!;
        const last = run[run.length - 1]!.day;
        const due = addDays(last, spec.days);
        const active = daysBetween(due, today) <= spec.days / 2;
        plans.push({
          account_id: run[0]!.account_id,
          key: run[0]!.key,
          interval,
          amount: median(run.map((b) => b.cash!)),
          executions: run.length,
          first: run[0]!.day,
          last,
          active,
          next: active ? due : null,
        });
        start = end + 1;
      } else {
        start += 1;
      }
    }
  }
  return plans.sort((a, b) => Number(b.active) - Number(a.active) || b.last.localeCompare(a.last) || a.key.localeCompare(b.key));
}
