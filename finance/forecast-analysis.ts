// Retirement forecast — what-if questions on top of the simulation
// (issues #1339 and #1340). Pure: every function here only calls
// `simulate` with a changed input, so it is testable without a database
// and cheap enough to answer on demand.
//
// #1339: how fragile is "you can leave at 61"? A table of earliest ages
// over return × inflation, and the one assumption that moves the age most.
// #1340: the reverse question — "I want to leave at 60, what does it
// take?" — answered by bisection over one lever at a time.

import {
  ageAtStart,
  earliestLeaveAge,
  simulate,
  withLeaveAge,
  type ForecastInput,
  type ForecastItem,
  type ForecastScenario,
  type TimeRef,
} from "./forecast-engine";

console.log("[boot] finance/forecast-analysis.ts: all imports resolved");

// -----------------------------------------------------------------------
// Sensitivity (#1339)
// -----------------------------------------------------------------------

export interface SensitivityCell {
  returnRate: number;
  inflationRate: number;
  /** Earliest leave-work age under these two rates; null when no age works. */
  age: number | null;
}

export interface SensitivityTable {
  personId: number;
  /** The scenario's own rates, so the UI can mark the base cell. */
  baseReturnRate: number;
  baseInflationRate: number;
  returnRates: number[];
  inflationRates: number[];
  cells: SensitivityCell[];
}

const MAX_AGE = 75;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function withRates(input: ForecastInput, returnRate: number, inflationRate: number): ForecastInput {
  return { ...input, scenario: { ...input.scenario, defaultReturnRate: returnRate, inflationRate } };
}

/** Rates in `steps` (as fractions, e.g. 0.01) around `base`, never below zero, deduplicated and sorted. */
export function rateSteps(base: number, steps: number[]): number[] {
  return [...new Set(steps.map((d) => round4(Math.max(0, base + d))))].sort((a, b) => a - b);
}

/**
 * Earliest leave-work age of `personId` for every return × inflation pair.
 * The pairs are the scenario's rates ± the given steps.
 */
export function sensitivityTable(
  input: ForecastInput,
  personId: number,
  returnSteps: number[] = [-0.02, -0.01, 0, 0.01, 0.02],
  inflationSteps: number[] = [-0.01, 0, 0.01],
): SensitivityTable {
  const returnRates = rateSteps(input.scenario.defaultReturnRate, returnSteps);
  const inflationRates = rateSteps(input.scenario.inflationRate, inflationSteps);
  const cells: SensitivityCell[] = [];
  for (const returnRate of returnRates) {
    for (const inflationRate of inflationRates) {
      cells.push({ returnRate, inflationRate, age: earliestLeaveAge(withRates(input, returnRate, inflationRate), personId, MAX_AGE).age });
    }
  }
  return {
    personId,
    baseReturnRate: round4(input.scenario.defaultReturnRate),
    baseInflationRate: round4(input.scenario.inflationRate),
    returnRates,
    inflationRates,
    cells,
  };
}

// -----------------------------------------------------------------------
// Levers (#1339): one step on one assumption, how many years does it cost?
// -----------------------------------------------------------------------

export type LeverKey = "return" | "inflation" | "spending" | "crash";

export interface Lever {
  key: LeverKey;
  /** What was changed, for the UI ("Rendite 1 % niedriger"). */
  label: string;
  /** Earliest age with the change; null when no age works any more. */
  age: number | null;
  /** Years the earliest age moves (positive = later); null when either side has no age. */
  deltaYears: number | null;
}

export interface LeverAnalysis {
  personId: number;
  /** Earliest age without any change. */
  baseAge: number | null;
  levers: Lever[];
  /** The lever with the largest effect, or null when none has one. */
  biggest: LeverKey | null;
}

/** Living expenses scaled by `factor`, everything else unchanged. */
function withSpendingFactor(input: ForecastInput, factor: number): ForecastInput {
  return {
    ...input,
    items: input.items.map((it) => (it.type === "living_expense" ? { ...it, amount: it.amount * factor } : it)),
  };
}

/** A crash of `size` on the depot in the year the person leaves work (at the given age). */
function withCrashAtLeave(input: ForecastInput, personId: number, size: number): (age: number) => ForecastInput {
  const p = input.persons.find((x) => x.id === personId);
  const birthYear = p ? Number(p.birthDate.slice(0, 4)) : 0;
  return (age) => ({ ...input, scenario: { ...input.scenario, stress: { crashYear: birthYear + age, crashSize: size } } });
}

/**
 * Earliest age when the depot crashes in the very year the person leaves:
 * the crash year moves with the age tried, so every candidate age is hit.
 */
function earliestWithCrashAtLeave(input: ForecastInput, personId: number, size: number): number | null {
  const current = ageAtStart(input, personId);
  if (current == null) return null;
  const make = withCrashAtLeave(input, personId, size);
  for (let age = Math.max(current, 40); age <= MAX_AGE; age++) {
    if (simulate(withLeaveAge(make(age), personId, age)).ok) return age;
  }
  return null;
}

export function leverAnalysis(input: ForecastInput, personId: number): LeverAnalysis {
  const baseAge = earliestLeaveAge(input, personId, MAX_AGE).age;
  const delta = (age: number | null) => (age == null || baseAge == null ? null : age - baseAge);
  const variants: Array<{ key: LeverKey; label: string; age: number | null }> = [
    {
      key: "return",
      label: "Rendite 1 Prozentpunkt niedriger",
      age: earliestLeaveAge(withRates(input, Math.max(0, input.scenario.defaultReturnRate - 0.01), input.scenario.inflationRate), personId, MAX_AGE).age,
    },
    {
      key: "inflation",
      label: "Inflation 1 Prozentpunkt höher",
      age: earliestLeaveAge(withRates(input, input.scenario.defaultReturnRate, input.scenario.inflationRate + 0.01), personId, MAX_AGE).age,
    },
    { key: "spending", label: "Lebenshaltung 10 % höher", age: earliestLeaveAge(withSpendingFactor(input, 1.1), personId, MAX_AGE).age },
    { key: "crash", label: "Depot verliert 30 % im Jahr des Ausstiegs", age: earliestWithCrashAtLeave(input, personId, 0.3) },
  ];
  const levers: Lever[] = variants.map((v) => ({ ...v, deltaYears: delta(v.age) }));
  // The largest loss of years wins; a lever that makes every age fail counts as the largest of all.
  let biggest: LeverKey | null = null;
  let worst = 0;
  for (const l of levers) {
    const score = baseAge != null && l.age == null ? Number.POSITIVE_INFINITY : (l.deltaYears ?? 0);
    if (score > worst) {
      worst = score;
      biggest = l.key;
    }
  }
  return { personId, baseAge, levers, biggest };
}

// -----------------------------------------------------------------------
// Reverse calculation (#1340)
// -----------------------------------------------------------------------

export interface ReverseLever {
  key: "savings" | "spending" | "return" | "one_off";
  /** The value that just makes the target age work; null when nothing within the bounds does. */
  value: number | null;
  /** For "spending": the monthly amount the percentage means in today's money. */
  monthlyAmount: number | null;
  /** The bound the search stopped at when `value` is null. */
  bound: number;
}

export interface ReverseResult {
  personId: number;
  targetAge: number;
  /** The target works as things stand. */
  reachable: boolean;
  /** When reachable: how much more the household could spend per month (today's money) and still make it. */
  bufferMonthly: number | null;
  /** When not reachable: each lever on its own, all other values unchanged. */
  levers: ReverseLever[];
}

/** Synthetic ids far away from real items. */
const SYNTH = 1_000_000_000;

function leaveRef(input: ForecastInput, personId: number): TimeRef | null {
  const ms = input.milestones.find((m) => m.personId === personId && m.kind === "leave_work");
  return ms ? { kind: "milestone", milestoneId: ms.id } : null;
}

/**
 * Save `monthly` more until the person leaves work: the household spends
 * that much less (an income line) and puts it into the depot (a savings plan).
 */
export function withExtraSavings(input: ForecastInput, personId: number, monthly: number): ForecastInput {
  const end = leaveRef(input, personId);
  const extra: ForecastItem[] = [
    { id: SYNTH + 1, type: "income", label: "Zusätzliches Sparen", personId: null, amount: monthly, frequency: "monthly", growthRate: 0, taxRate: 0, end },
    {
      id: SYNTH + 2,
      type: "asset",
      label: "Zusätzliches Sparen",
      personId: null,
      pot: "depot",
      currentValue: 0,
      returnRate: null,
      monthlyContribution: monthly,
      contributionEnd: end,
    },
  ];
  return { ...input, items: [...input.items, ...extra] };
}

/** Living expenses cut by `share` (0.1 = 10 %) from the day the person leaves work. */
export function withSpendingCutAfterLeave(input: ForecastInput, personId: number, share: number): ForecastInput {
  const at = leaveRef(input, personId);
  if (!at) return withSpendingFactor(input, 1 - share);
  const items: ForecastItem[] = [];
  for (const it of input.items) {
    if (it.type !== "living_expense") {
      items.push(it);
      continue;
    }
    items.push({ ...it, end: at });
    items.push({ ...it, id: SYNTH + 100 + it.id, start: at, amount: it.amount * (1 - share) });
  }
  return { ...input, items };
}

/** All depot and other investments earn `rate`; cash and real estate keep theirs. */
export function withReturnRate(input: ForecastInput, rate: number): ForecastInput {
  return {
    ...input,
    scenario: { ...input.scenario, defaultReturnRate: rate },
    items: input.items.map((it) => (it.type === "asset" && (it.pot === "depot" || it.pot === "other") ? { ...it, returnRate: null } : it)),
  };
}

/** A one-off amount arriving today, invested in the depot. */
export function withOneOff(input: ForecastInput, amount: number): ForecastInput {
  const item: ForecastItem = {
    id: SYNTH + 3,
    type: "asset",
    label: "Einmalbetrag",
    personId: null,
    pot: "depot",
    currentValue: amount,
    returnRate: null,
    monthlyContribution: 0,
  };
  return { ...input, items: [...input.items, item] };
}

/** Spend `monthly` more for the rest of the horizon (today's money, follows inflation). */
function withExtraSpending(input: ForecastInput, monthly: number): ForecastInput {
  const item: ForecastItem = { id: SYNTH + 4, type: "expense", label: "Mehr ausgeben", personId: null, amount: monthly, frequency: "monthly", growthRate: null };
  return { ...input, items: [...input.items, item] };
}

/**
 * Smallest x in [lo, hi] for which `ok(x)` holds, assuming ok is monotone
 * (false below some threshold, true above). null when ok(hi) is false.
 * `ok(lo)` true returns lo.
 */
export function bisectMin(lo: number, hi: number, ok: (x: number) => boolean, iterations = 24): number | null {
  if (ok(lo)) return lo;
  if (!ok(hi)) return null;
  let bad = lo;
  let good = hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (bad + good) / 2;
    if (ok(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

/** Largest x in [lo, hi] for which `ok(x)` holds, assuming ok is true at lo and turns false above some threshold. */
export function bisectMax(lo: number, hi: number, ok: (x: number) => boolean, iterations = 24): number {
  if (ok(hi)) return hi;
  let good = lo;
  let bad = hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (good + bad) / 2;
    if (ok(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

export const REVERSE_BOUNDS = {
  /** € per month of additional savings. */
  savingsMonthly: 20_000,
  /** Share of living expenses cut after leaving work. */
  spendingShare: 0.9,
  /** Yearly return on investments. */
  returnRate: 0.15,
  /** One-off amount today. */
  oneOff: 5_000_000,
  /** € per month of additional spending (the buffer). */
  bufferMonthly: 50_000,
} as const;

/** Up to the next multiple of `step`, forgiving the bisection's last fraction. */
const ceilTo = (n: number, step: number) => Math.ceil((n - step * 0.01) / step) * step;
const floorTo = (n: number, step: number) => Math.floor((n + step * 0.01) / step) * step;

/**
 * What it takes to leave work at `targetAge`, each lever on its own; or,
 * when the target already works, how much more could be spent per month.
 */
export function reverseCalculation(input: ForecastInput, personId: number, targetAge: number): ReverseResult {
  const at = withLeaveAge(input, personId, targetAge);
  const ok = (i: ForecastInput) => simulate(i).ok;
  const scenario: ForecastScenario = input.scenario;
  if (ok(at)) {
    const buffer = bisectMax(0, REVERSE_BOUNDS.bufferMonthly, (x) => ok(withExtraSpending(at, x)));
    return { personId, targetAge, reachable: true, bufferMonthly: floorTo(buffer, 10), levers: [] };
  }
  const livingMonthly = input.items.reduce((s, it) => s + (it.type === "living_expense" ? it.amount : 0), 0);
  const savings = bisectMin(0, REVERSE_BOUNDS.savingsMonthly, (x) => ok(withExtraSavings(at, personId, x)));
  const spending = bisectMin(0, REVERSE_BOUNDS.spendingShare, (x) => ok(withSpendingCutAfterLeave(at, personId, x)));
  const ret = bisectMin(scenario.defaultReturnRate, REVERSE_BOUNDS.returnRate, (x) => ok(withReturnRate(at, x)));
  const oneOff = bisectMin(0, REVERSE_BOUNDS.oneOff, (x) => ok(withOneOff(at, x)));
  return {
    personId,
    targetAge,
    reachable: false,
    bufferMonthly: null,
    levers: [
      { key: "savings", value: savings == null ? null : ceilTo(savings, 10), monthlyAmount: null, bound: REVERSE_BOUNDS.savingsMonthly },
      {
        key: "spending",
        value: spending == null ? null : ceilTo(spending, 0.001),
        monthlyAmount: spending == null ? null : ceilTo(livingMonthly * spending, 10),
        bound: REVERSE_BOUNDS.spendingShare,
      },
      { key: "return", value: ret == null ? null : ceilTo(ret, 0.0001), monthlyAmount: null, bound: REVERSE_BOUNDS.returnRate },
      { key: "one_off", value: oneOff == null ? null : ceilTo(oneOff, 1000), monthlyAmount: null, bound: REVERSE_BOUNDS.oneOff },
    ],
  };
}
