/**
 * Portfolio performance — the arithmetic, free of the database (#1700).
 *
 * One fold turns holdings snapshots, depot transactions and stored prices
 * into a day series of the portfolio's market value, its external cash
 * flows and the net invested capital. From that series every period's
 * figures are read:
 *
 *   - time-weighted return (TWR): the daily returns chained, each day's
 *     return net of that day's flows — how the securities did, whatever
 *     money was moved in or out;
 *   - money-weighted return (XIRR): the rate at which the value at the
 *     start, every flow and the value at the end discount to zero — how
 *     the investor's money did, timing of buys and sells included.
 *
 * Flows are seen from the securities: a buy or a transfer in brings money
 * in, a sell, a transfer out or a dividend takes it out (a dividend is
 * paid to the cash account, so it leaves the portfolio as part of its
 * return). Tax on a fund's kept income is paid from outside without
 * adding value, so it counts as money in.
 *
 * Shares held on a day come from the transactions, set right by each of
 * the bank's snapshots; a split's `amount` is the change in the share
 * count. Shares a snapshot shows without a trade explaining them (holdings
 * older than the records, a transfer nobody booked) count as moved in at
 * that day's price, so they never read as a gain. A day is valued only
 * when every security held has a price from that day or at most
 * PRICE_STALE_DAYS before; otherwise the day stays without a value and is
 * reported as a gap — never interpolated.
 */

/** A price older than this many days no longer values a holding. */
export const PRICE_STALE_DAYS = 10;

/** Beyond this many points a period's series is thinned to one point per week. */
const MAX_POINTS = 800;

const EPS = 1e-9;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PerformancePeriod = "1M" | "YTD" | "1Y" | "3Y" | "max";
export const PERFORMANCE_PERIODS: readonly PerformancePeriod[] = ["1M", "YTD", "1Y", "3Y", "max"];

/** One row of a holdings snapshot, keyed by position. */
export interface PerfSnapshotRow {
  account_id: number;
  /** YYYY-MM-DD */
  day: string;
  key: string;
  amount: number | null;
  price: number | null;
}

/** One depot transaction with its cash already read off the row. */
export interface PerfTx {
  account_id: number;
  key: string;
  kind: string;
  /** YYYY-MM-DD */
  day: string;
  /** Shares moved (unsigned for buy/sell/in/out, signed change for a split). */
  amount: number | null;
  /** Price per share on the row, if any. */
  price: number | null;
  /** Cash paid for a buy / received for a sell (unsigned); null when unknown. */
  cash: number | null;
  /** Net income of a dividend (positive) or a tax on kept income (negative). */
  income: number | null;
}

/** A stored close or quote of a position. */
export interface PriceObservation {
  key: string;
  /** YYYY-MM-DD */
  day: string;
  price: number;
}

export interface PerformanceInput {
  snapshots: PerfSnapshotRow[];
  txs: PerfTx[];
  prices: PriceObservation[];
  /** YYYY-MM-DD; nothing after it is used. */
  today: string;
}

export interface SeriesDay {
  day: string;
  /** Market value; null when a security held has no recent price. */
  value: number | null;
  /** Securities held without a recent price. */
  missing: number;
  /** Net external flow that day (in − out), implied opening values included. */
  flow: number;
  /** Net invested capital at the end of the day (buys − sells ± transfers, plus implied openings). */
  invested: number;
  /** Net income that day (dividends minus tax on kept income). */
  income: number;
  /** Chained TWR index (1 = start of the history); null on a day without value. */
  index: number | null;
}

export interface ValueSeries {
  days: SeriesDay[];
  /** Flows that could not be valued (a buy without cash or price, a transfer without price). */
  unvalued_flows: number;
  /**
   * Net value of shares a snapshot showed beyond (or short of) the trades,
   * booked as moved in (or out) at that day's price.
   */
  implied_inflow: number;
}

// ----------------------------------------------------------------------
// Days
// ----------------------------------------------------------------------

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((dayMs(b) - dayMs(a)) / MS_PER_DAY);
}

export function addDays(day: string, n: number): string {
  return new Date(dayMs(day) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The day a period starts on (its reference value is the last one on or before it); null for max. */
export function periodStart(period: PerformancePeriod, today: string): string | null {
  switch (period) {
    case "1M":
      return addMonths(today, -1);
    case "YTD":
      return addDays(`${today.slice(0, 4)}-01-01`, -1);
    case "1Y":
      return addMonths(today, -12);
    case "3Y":
      return addMonths(today, -36);
    default:
      return null;
  }
}

// ----------------------------------------------------------------------
// The fold
// ----------------------------------------------------------------------

/** Effect of a transaction on the share count; null when it has none or it is unknown. */
function shareEffect(tx: PerfTx): number | null {
  if (tx.amount === null || !Number.isFinite(tx.amount)) return null;
  switch (tx.kind) {
    case "buy":
    case "in":
      return Math.abs(tx.amount);
    case "sell":
    case "out":
      return -Math.abs(tx.amount);
    case "split":
      return tx.amount;
    default:
      return null;
  }
}

export function buildValueSeries(input: PerformanceInput): ValueSeries {
  const { today } = input;
  const snapshots = input.snapshots.filter((s) => s.day <= today && s.key);
  const txs = input.txs.filter((t) => t.day <= today && t.key);

  let first: string | null = null;
  for (const s of snapshots) if (!first || s.day < first) first = s.day;
  for (const t of txs) if (!first || t.day < first) first = t.day;
  if (!first) return { days: [], unvalued_flows: 0, implied_inflow: 0 };
  const start = first;

  // Every day something is known about: a snapshot, a trade or a price.
  const daySet = new Set<string>();
  for (const s of snapshots) daySet.add(s.day);
  for (const t of txs) daySet.add(t.day);
  for (const p of input.prices) if (p.day >= start && p.day <= today) daySet.add(p.day);
  const days = [...daySet].sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const n = days.length;

  const keys = new Set<string>([...snapshots.map((s) => s.key), ...txs.map((t) => t.key)]);
  const accounts = new Set<number>([...snapshots.map((s) => s.account_id), ...txs.map((t) => t.account_id)]);

  // Prices per position: the stored ones and the bank's, the trade's own
  // price only where neither is known that day.
  const obs = new Map<string, Map<string, number>>();
  const observe = (key: string, day: string, price: number | null, weak: boolean) => {
    if (price === null || !Number.isFinite(price) || price <= 0 || day > today) return;
    const m = obs.get(key) ?? new Map<string, number>();
    if (!weak || !m.has(day)) m.set(day, price);
    obs.set(key, m);
  };
  for (const t of txs) if (t.kind === "buy" || t.kind === "sell") observe(t.key, t.day, t.price, true);
  for (const s of snapshots) observe(s.key, s.day, s.price, false);
  for (const p of input.prices) observe(p.key, p.day, p.price, false);

  const priceOn = new Map<string, Array<number | null>>();
  for (const key of keys) {
    const list = [...(obs.get(key) ?? new Map()).entries()].sort(([a], [b]) => a.localeCompare(b));
    const out: Array<number | null> = new Array(n).fill(null);
    let p = -1;
    for (let i = 0; i < n; i++) {
      while (p + 1 < list.length && list[p + 1]![0] <= days[i]!) p++;
      if (p >= 0 && daysBetween(list[p]![0], days[i]!) <= PRICE_STALE_DAYS) out[i] = list[p]![1];
    }
    priceOn.set(key, out);
  }

  // Shares held per position and day, summed over the depots: the trades
  // replayed forward, set right by every snapshot. What a snapshot shows
  // beyond (or short of) the trades came in (or went out) without a trade
  // we know of — a transfer, a missing statement, holdings older than the
  // records — and is booked as moved in (or out) at that day's price, not
  // as a gain.
  const held = new Map<string, Float64Array>();
  for (const k of keys) held.set(k, new Float64Array(n));
  const implied: Array<{ i: number; key: string; shares: number }> = [];

  for (const account of accounts) {
    // The account's snapshot days, each a full picture of what it held.
    const snapDays = new Map<number, Map<string, number>>();
    for (const s of snapshots) {
      if (s.account_id !== account) continue;
      const i = dayIdx.get(s.day)!;
      const m = snapDays.get(i) ?? new Map<string, number>();
      m.set(s.key, (m.get(s.key) ?? 0) + (s.amount ?? 0));
      snapDays.set(i, m);
    }
    const accountKeys = new Set<string>();
    for (const m of snapDays.values()) for (const k of m.keys()) accountKeys.add(k);
    const effects = new Map<string, Float64Array>();
    for (const t of txs) {
      if (t.account_id !== account) continue;
      accountKeys.add(t.key);
      const e = shareEffect(t);
      if (e === null) continue;
      const arr = effects.get(t.key) ?? new Float64Array(n);
      arr[dayIdx.get(t.day)!] += e;
      effects.set(t.key, arr);
    }

    for (const key of accountKeys) {
      const eff = effects.get(key);
      const out = held.get(key)!;
      let running = 0;
      for (let i = 0; i < n; i++) {
        if (eff) running += eff[i]!;
        const snap = snapDays.get(i);
        if (snap) {
          const truth = snap.get(key) ?? 0;
          const diff = truth - Math.max(running, 0);
          if (Math.abs(diff) > EPS) implied.push({ i, key, shares: diff });
          running = truth;
        }
        if (running > EPS) out[i] = out[i]! + running;
      }
    }
  }

  // Flows per day.
  const inflow = new Float64Array(n);
  const outflow = new Float64Array(n);
  const investedFlow = new Float64Array(n);
  const income = new Float64Array(n);
  let unvaluedFlows = 0;
  for (const t of txs) {
    const i = dayIdx.get(t.day)!;
    const shares = t.amount === null ? null : Math.abs(t.amount);
    const market = priceOn.get(t.key)![i] ?? t.price;
    const worth = shares === null || market === null ? null : shares * market;
    switch (t.kind) {
      case "buy":
      case "in": {
        const cash = t.kind === "buy" ? (t.cash ?? worth) : worth;
        if (cash === null) unvaluedFlows += 1;
        else {
          inflow[i] += cash;
          investedFlow[i] += cash;
        }
        break;
      }
      case "sell":
      case "out": {
        const cash = t.kind === "sell" ? (t.cash ?? worth) : worth;
        if (cash === null) unvaluedFlows += 1;
        else {
          outflow[i] += cash;
          investedFlow[i] -= cash;
        }
        break;
      }
      case "dividend":
      case "tax": {
        if (t.income === null) break;
        income[i] += t.income;
        if (t.income >= 0) outflow[i] += t.income;
        else inflow[i] += -t.income;
        break;
      }
      default:
        break;
    }
  }
  let impliedTotal = 0;
  for (const m of implied) {
    const price = priceOn.get(m.key)![m.i];
    if (price === null || price === undefined) {
      unvaluedFlows += 1;
      continue;
    }
    const worth = m.shares * price;
    impliedTotal += worth;
    investedFlow[m.i] += worth;
    if (worth > 0) inflow[m.i] += worth;
    else outflow[m.i] += -worth;
  }

  // Values, then the chained index.
  const out: SeriesDay[] = [];
  let prevValue = 0;
  let prevIndex = 1;
  let pendingIn = 0;
  let pendingOut = 0;
  let invested = 0;
  for (let i = 0; i < n; i++) {
    let value = 0;
    let missing = 0;
    for (const key of keys) {
      const amount = held.get(key)![i]!;
      if (amount <= EPS) continue;
      const price = priceOn.get(key)![i];
      if (price === null || price === undefined) missing += 1;
      else value += amount * price;
    }
    pendingIn += inflow[i]!;
    pendingOut += outflow[i]!;
    invested += investedFlow[i]!;
    let flow = inflow[i]! - outflow[i]!;
    let index: number | null = null;
    if (missing === 0) {
      const den = prevValue + pendingIn;
      const num = value + pendingOut;
      if (den <= EPS) {
        // Value without money in: shares older than the transactions. They
        // count as brought in at that day's value.
        if (num > EPS) {
          impliedTotal += num;
          invested += num;
          flow += num;
        }
        index = prevIndex;
      } else {
        index = prevIndex * (num / den);
      }
      prevIndex = index;
      prevValue = value;
      pendingIn = 0;
      pendingOut = 0;
    }
    out.push({
      day: days[i]!,
      value: missing === 0 ? value : null,
      missing,
      flow,
      invested,
      income: income[i]!,
      index,
    });
  }

  return { days: out, unvalued_flows: unvaluedFlows, implied_inflow: impliedTotal };
}

/**
 * The input of one position alone. A snapshot that does not list it still
 * says the depot held none of it that day, so each snapshot day of a depot
 * stays in as a zero row.
 */
export function restrictToKey(input: PerformanceInput, key: string): PerformanceInput {
  const listed = new Set<string>();
  const snapshotDays = new Set<string>();
  const snapshots: PerfSnapshotRow[] = [];
  for (const s of input.snapshots) {
    snapshotDays.add(`${s.account_id}|${s.day}`);
    if (s.key !== key) continue;
    listed.add(`${s.account_id}|${s.day}`);
    snapshots.push(s);
  }
  for (const id of snapshotDays) {
    if (listed.has(id)) continue;
    const [account, day] = id.split("|") as [string, string];
    snapshots.push({ account_id: Number(account), day, key, amount: 0, price: null });
  }
  return {
    snapshots,
    txs: input.txs.filter((t) => t.key === key),
    prices: input.prices.filter((p) => p.key === key),
    today: input.today,
  };
}

// ----------------------------------------------------------------------
// XIRR
// ----------------------------------------------------------------------

export interface DatedFlow {
  /** Years since the first flow. */
  t: number;
  /** Seen from the investor: paid in negative, received positive. */
  amount: number;
}

function npv(rate: number, flows: DatedFlow[]): number {
  let s = 0;
  for (const f of flows) s += f.amount / Math.pow(1 + rate, f.t);
  return s;
}

function dnpv(rate: number, flows: DatedFlow[]): number {
  let s = 0;
  for (const f of flows) s += (-f.t * f.amount) / Math.pow(1 + rate, f.t + 1);
  return s;
}

/** The annual rate at which the flows discount to zero; null when there is none. */
export function xirr(flows: DatedFlow[]): number | null {
  const relevant = flows.filter((f) => Math.abs(f.amount) > EPS);
  if (!relevant.some((f) => f.amount > 0) || !relevant.some((f) => f.amount < 0)) return null;
  if (relevant.every((f) => f.t === relevant[0]!.t)) return null;

  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, relevant);
    const d = dnpv(rate, relevant);
    if (!Number.isFinite(f) || !Number.isFinite(d) || Math.abs(d) < 1e-12) break;
    const next = rate - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < 1e-10) return next;
    rate = next;
  }

  // Newton did not settle: bisect where the sign changes.
  let lo = -0.999999;
  let hi = 10;
  let flo = npv(lo, relevant);
  let fhi = npv(hi, relevant);
  while (flo * fhi > 0 && hi < 1e6) {
    hi *= 10;
    fhi = npv(hi, relevant);
  }
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid, relevant);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (flo * fm < 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

// ----------------------------------------------------------------------
// One period
// ----------------------------------------------------------------------

export interface PeriodPoint {
  day: string;
  value: number | null;
  invested: number;
  /** TWR since the period's start, in percent; null on a day without value. */
  twr_pct: number | null;
}

export interface PeriodGap {
  /** First day without a valuation (or the day after the last one). */
  from: string;
  /** Last day without a valuation (or the day before the next one). */
  to: string;
}

export interface PeriodPerformance {
  /** Day of the reference value the period is measured from. */
  from: string;
  /** Day of the last value. */
  to: string;
  /** The period did not reach back as far as asked: there was no value earlier. */
  shortened: boolean;
  start_value: number;
  end_value: number;
  /** Money in minus money out over the period (dividends count as out). */
  net_flow: number;
  income: number;
  /** end − start − net flow: what the securities earned, income included. */
  gain: number;
  /** Time-weighted return over the period (fraction). */
  twr: number | null;
  /** The same per year; null for periods shorter than a year. */
  twr_pa: number | null;
  /** Money-weighted return per year (XIRR). */
  xirr: number | null;
  /** The money-weighted return over the period, not annualised. */
  mwr: number | null;
  /** Days in the period without a valuation. */
  unvalued_days: number;
  gaps: PeriodGap[];
  points: PeriodPoint[];
}

/** Keep the last point of each week once a series is too long to draw day by day. */
function thin(points: PeriodPoint[]): PeriodPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const out: PeriodPoint[] = [];
  let week: number | null = null;
  for (const p of points) {
    const w = Math.floor((dayMs(p.day) / MS_PER_DAY + 3) / 7);
    if (week === w) out[out.length - 1] = p;
    else out.push(p);
    week = w;
  }
  return out;
}

export function periodPerformance(
  series: ValueSeries,
  period: PerformancePeriod,
  today: string,
): PeriodPerformance | null {
  const days = series.days;
  if (days.length === 0) return null;

  const wanted = periodStart(period, today);
  // The reference: the last value on or before the start; with none and no
  // history before the start, an empty portfolio the day before the first.
  let refIdx = -1;
  let shortened = false;
  if (wanted !== null) {
    for (let i = 0; i < days.length && days[i]!.day <= wanted; i++) {
      if (days[i]!.value !== null) refIdx = i;
    }
    if (refIdx < 0 && days[0]!.day <= wanted) {
      refIdx = days.findIndex((d) => d.value !== null && d.day > wanted);
      if (refIdx < 0) return null;
      shortened = true;
    }
  }
  const virtual = refIdx < 0;
  if (virtual && wanted !== null) shortened = days[0]!.day > addDays(wanted, PRICE_STALE_DAYS);
  const ref = virtual
    ? { day: addDays(days[0]!.day, -1), value: 0, index: 1 }
    : { day: days[refIdx]!.day, value: days[refIdx]!.value!, index: days[refIdx]!.index! };

  let endIdx = -1;
  for (let i = days.length - 1; i > refIdx; i--) {
    if (days[i]!.value !== null) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;
  const end = days[endIdx]!;

  const inPeriod = days.slice(refIdx + 1, endIdx + 1);
  let netFlow = 0;
  let income = 0;
  for (const d of inPeriod) {
    netFlow += d.flow;
    income += d.income;
  }

  const twr = end.index! / ref.index - 1;
  const spanYears = daysBetween(ref.day, end.day) / 365;
  const twrPa = spanYears >= 1 ? Math.pow(1 + twr, 1 / spanYears) - 1 : null;

  // XIRR, seen from the investor.
  const t0 = virtual ? (inPeriod.find((d) => Math.abs(d.flow) > EPS)?.day ?? ref.day) : ref.day;
  const flows: DatedFlow[] = [];
  if (ref.value > EPS) flows.push({ t: 0, amount: -ref.value });
  for (const d of inPeriod) {
    if (Math.abs(d.flow) > EPS) flows.push({ t: daysBetween(t0, d.day) / 365, amount: -d.flow });
  }
  flows.push({ t: daysBetween(t0, end.day) / 365, amount: end.value! });
  const rate = xirr(flows);
  const mwrYears = daysBetween(t0, end.day) / 365;
  const mwr = rate === null ? null : Math.pow(1 + rate, mwrYears) - 1;

  // Gaps: runs of days without a value, and stretches between two values
  // longer than a price stays valid.
  const gaps: PeriodGap[] = [];
  let unvalued = 0;
  let lastValued = ref.day;
  let open: string | null = null;
  for (const d of inPeriod) {
    if (d.value === null) {
      unvalued += 1;
      if (open === null) open = d.day;
      continue;
    }
    if (open !== null) {
      gaps.push({ from: open, to: addDays(d.day, -1) });
      open = null;
    } else if (!virtual || lastValued !== ref.day) {
      if (daysBetween(lastValued, d.day) > PRICE_STALE_DAYS) {
        gaps.push({ from: addDays(lastValued, 1), to: addDays(d.day, -1) });
      }
    }
    lastValued = d.day;
  }

  const points: PeriodPoint[] = [];
  if (!virtual) points.push({ day: ref.day, value: ref.value, invested: days[refIdx]!.invested, twr_pct: 0 });
  for (const d of inPeriod) {
    points.push({
      day: d.day,
      value: d.value,
      invested: d.invested,
      twr_pct: d.index === null ? null : (d.index / ref.index - 1) * 100,
    });
  }

  return {
    from: virtual ? days[0]!.day : ref.day,
    to: end.day,
    shortened,
    start_value: ref.value,
    end_value: end.value!,
    net_flow: netFlow,
    income,
    gain: end.value! - ref.value - netFlow,
    twr,
    twr_pa: twrPa,
    xirr: rate,
    mwr,
    unvalued_days: unvalued,
    gaps,
    points: thin(points),
  };
}
