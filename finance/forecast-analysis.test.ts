import { describe, it, expect } from "vitest";

import {
  bisectMax,
  bisectMin,
  leverAnalysis,
  rateSteps,
  reverseCalculation,
  sensitivityTable,
  withExtraSavings,
  withSpendingCutAfterLeave,
} from "./forecast-analysis";
import {
  defaultScenario,
  earliestLeaveAge,
  simulate,
  withLeaveAge,
  type ForecastInput,
  type ForecastItem,
  type ForecastMilestone,
  type ForecastPerson,
  type ForecastScenario,
} from "./forecast-engine";

// Every person, amount and date below is invented.

const START = "2026-01-01";
const anna: ForecastPerson = { id: 1, label: "A", birthDate: "1970-01-01" }; // 56 at start

const ms = (id: number, personId: number, kind: ForecastMilestone["kind"], age: number): ForecastMilestone => ({ id, personId, kind, label: kind, age });
const milestones = [ms(1, 1, "leave_work", 62), ms(2, 1, "statutory_pension", 67)];

function scenario(over: Partial<ForecastScenario> = {}): ForecastScenario {
  return defaultScenario({
    inflationRate: 0,
    defaultReturnRate: 0,
    capitalGainsTaxRate: 0,
    endAge: 80,
    spendingCurve: { referencePersonId: null, phases: [{ fromAge: 0, factor: 1 }], careFromAge: null, careMonthly: 0 },
    ...over,
  });
}

const salary = (amount: number): ForecastItem => ({ id: 10, type: "salary", label: "Gehalt", personId: 1, amount, growthRate: 0 });
const living = (amount: number): ForecastItem => ({ id: 20, type: "living_expense", label: "Leben", personId: null, amount });
const depot = (value: number, returnRate: number | null = null): ForecastItem => ({
  id: 30,
  type: "asset",
  label: "Depot",
  personId: null,
  pot: "depot",
  currentValue: value,
  returnRate,
  monthlyContribution: 0,
});
const pension = (amount: number): ForecastItem => ({
  id: 41,
  type: "pension",
  label: "Rente",
  personId: 1,
  kind: "statutory",
  monthlyAmount: amount,
  start: { kind: "milestone", milestoneId: 2 },
  regularAge: null,
  deductionPerMonth: 0,
  deductionOffsetCost: null,
  growthRate: 0,
  monthlyContribution: 0,
  lumpSumOption: null,
  payoutMode: "annuity",
  taxRate: 0,
});

function input(items: ForecastItem[], over: Partial<ForecastScenario> = {}): ForecastInput {
  return { persons: [anna], milestones, items, scenario: scenario(over), startDate: START };
}

// Salary 3 000, living 2 500, pension 2 000 from 67, horizon 2026–2050 (age
// 80). A year of work saves 6 000, a bridge year costs 30 000, a pension
// year 6 000 — and there are 14 of those (2037–2050). Leaving at age L:
// have depot + (L − 56) · 6 000, need (67 − L) · 30 000 + 84 000.
const household = (depotValue: number) => [salary(3_000), living(2_500), depot(depotValue), pension(2_000)];

describe("stress test — a crash on the depot", () => {
  it("removes the configured share at the start of the crash year and shows it as a negative return", () => {
    const base = input([depot(100_000)]);
    const crashed = simulate({ ...base, scenario: { ...base.scenario, stress: { crashYear: 2028, crashSize: 0.3 } } });
    const by = Object.fromEntries(crashed.years.map((y) => [y.year, y]));
    expect(by[2027].pots.depot).toBe(100_000);
    expect(by[2028].pots.depot).toBeCloseTo(70_000, 6);
    expect(by[2028].returns).toBeCloseTo(-30_000, 6);
    expect(by[2029].pots.depot).toBeCloseTo(70_000, 6);
  });

  it("hits in the first simulated month when the crash year is the start year", () => {
    const base = input([depot(100_000)]);
    const crashed = simulate({ ...base, scenario: { ...base.scenario, stress: { crashYear: 2026, crashSize: 0.5 } }, startDate: "2026-04-01" });
    expect(crashed.years[0].pots.depot).toBeCloseTo(50_000, 6);
  });

  it("can turn a plan that works into one that fails, depending on when it hits", () => {
    // Leaving at 62: need 150 000 + 84 000 = 234 000, have 210 000 + 36 000 = 246 000.
    const fine = input(household(210_000));
    expect(simulate(fine).ok).toBe(true);
    const crashIn = (year: number) => simulate({ ...fine, scenario: { ...fine.scenario, stress: { crashYear: year, crashSize: 0.3 } } });
    expect(crashIn(2032).ok).toBe(false); // in the year of leaving: 246 000 · 0.7 < 234 000
    expect(crashIn(2049).ok).toBe(true); // late: 24 000 left, losing 7 200 of it is within the 12 000 margin
    // Before the bridge the crash costs the most in absolute terms — but savings keep coming.
    const before = crashIn(2027);
    const during = crashIn(2035);
    expect(before.ok).toBe(false);
    expect(during.ok).toBe(false);
    expect(before.failYear!).toBeLessThanOrEqual(during.failYear!);
  });
});

describe("sensitivity table", () => {
  it("builds rates around the scenario, never below zero", () => {
    expect(rateSteps(0.01, [-0.02, -0.01, 0, 0.01])).toEqual([0, 0.01, 0.02]);
    expect(rateSteps(0.04, [-0.01, 0, 0.01])).toEqual([0.03, 0.04, 0.05]);
  });

  it("has one earliest age per cell and later ages for worse assumptions", () => {
    const base = input(household(60_000), { defaultReturnRate: 0.03, inflationRate: 0.02, capitalGainsTaxRate: 0 });
    const t = sensitivityTable(base, 1, [-0.02, 0, 0.02], [0, 0.02]);
    expect(t.returnRates).toEqual([0.01, 0.03, 0.05]);
    expect(t.inflationRates).toEqual([0.02, 0.04]);
    expect(t.cells).toHaveLength(6);
    // null (no age works) counts as later than any age.
    const age = (r: number, i: number) => t.cells.find((c) => c.returnRate === r && c.inflationRate === i)!.age ?? 999;
    expect(age(0.03, 0.02)).toBe(earliestLeaveAge(base, 1, 75).age);
    expect(age(0.01, 0.02)).toBeGreaterThanOrEqual(age(0.05, 0.02));
    expect(age(0.03, 0.04)).toBeGreaterThanOrEqual(age(0.03, 0.02));
    expect(t.baseReturnRate).toBe(0.03);
  });
});

describe("levers", () => {
  it("names the assumption that costs the most years", () => {
    // With no returns and a depot, the crash is the only lever with teeth here.
    const base = input(household(60_000));
    const a = leverAnalysis(base, 1);
    expect(a.baseAge).toBe(earliestLeaveAge(base, 1, 75).age);
    expect(a.levers.map((l) => l.key)).toEqual(["return", "inflation", "spending", "crash"]);
    for (const l of a.levers) if (l.age != null) expect(l.age).toBeGreaterThanOrEqual(a.baseAge!);
    const crash = a.levers.find((l) => l.key === "crash")!;
    expect(crash.deltaYears!).toBeGreaterThan(0);
    expect(a.biggest).not.toBeNull();
    const biggest = a.levers.find((l) => l.key === a.biggest)!;
    for (const l of a.levers) expect((l.deltaYears ?? 0) <= (biggest.deltaYears ?? Infinity)).toBe(true);
  });

  it("reports a lever that makes every age fail as the biggest", () => {
    // Horizon 100: even leaving at 75 (salary and pension together from 67) leaves
    // 25 pension years to pay. At 2 700 a month that just works, at 2 970 nothing does.
    const base = input([salary(3_000), living(2_700), depot(0), pension(2_000)], { endAge: 100 });
    const a = leverAnalysis(base, 1);
    expect(a.baseAge).not.toBeNull();
    expect(a.levers.find((l) => l.key === "spending")!.age).toBeNull();
    expect(a.levers.find((l) => l.key === a.biggest)!.age).toBeNull();
  });
});

describe("bisection", () => {
  it("finds the smallest passing value and the largest passing value", () => {
    expect(bisectMin(0, 100, (x) => x >= 37.5)!).toBeCloseTo(37.5, 3);
    expect(bisectMin(0, 100, (x) => x >= 200)).toBeNull();
    expect(bisectMin(50, 100, (x) => x >= 10)).toBe(50);
    expect(bisectMax(0, 100, (x) => x <= 12.25)).toBeCloseTo(12.25, 3);
    expect(bisectMax(0, 100, () => true)).toBe(100);
  });
});

describe("reverse calculation", () => {
  it("says what each lever needs when the target age does not work", () => {
    // Leaving at 60 with 30 000: need 7 · 30 000 + 84 000 = 294 000, have 30 000 + 24 000 = 54 000. Gap 240 000.
    const base = input(household(30_000));
    expect(simulate(withLeaveAge(base, 1, 60)).ok).toBe(false);
    const r = reverseCalculation(base, 1, 60);
    expect(r.reachable).toBe(false);
    expect(r.bufferMonthly).toBeNull();
    const by = Object.fromEntries(r.levers.map((l) => [l.key, l]));
    // 240 000 over 48 months of extra saving = 5 000 a month.
    expect(by.savings.value).toBe(5_000);
    // Cutting living expenses from 60 on: the bridge decides, not the sum over the horizon.
    // 54 000 must carry 7 years of 30 000 · (1 − share) → 74.3 %, about 1 860 a month.
    expect(by.spending.value).toBe(0.743);
    expect(by.spending.monthlyAmount).toBe(1_860);
    // A one-off today closes the gap directly.
    expect(by.one_off.value).toBe(240_000);
    // 30 000 cannot earn 240 000 in four years at any return within the bounds.
    expect(by.return.value).toBeNull();
    // Each proposed value makes the plan work, and it is not wildly generous.
    expect(simulate(withExtraSavings(withLeaveAge(base, 1, 60), 1, by.savings.value!)).ok).toBe(true);
    expect(simulate(withExtraSavings(withLeaveAge(base, 1, 60), 1, by.savings.value! - 20)).ok).toBe(false);
    expect(simulate(withSpendingCutAfterLeave(withLeaveAge(base, 1, 60), 1, by.spending.value!)).ok).toBe(true);
  });

  it("reports the monthly buffer when the target already works", () => {
    // Leaving at 65 with 100 000: need 60 000 + 84 000 = 144 000, have 100 000 + 54 000 = 154 000.
    // 10 000 to spare over the 300 months of the horizon = 33 a month, rounded down to tens.
    const r = reverseCalculation(input(household(100_000)), 1, 65);
    expect(r.reachable).toBe(true);
    expect(r.levers).toEqual([]);
    expect(r.bufferMonthly).toBe(30);
  });

  it("marks a lever as not reachable when the bound does not suffice", () => {
    // Living far beyond the means: no saving from a 100 salary, no cut and no return fixes it.
    const base = input([salary(100), living(5_000), depot(0), pension(500)]);
    const r = reverseCalculation(base, 1, 60);
    expect(r.reachable).toBe(false);
    const by = Object.fromEntries(r.levers.map((l) => [l.key, l]));
    expect(by.savings.value).toBeNull();
    expect(by.savings.bound).toBe(20_000);
    expect(by.return.value).toBeNull();
    expect(by.one_off.value).not.toBeNull(); // five million always do
  });
});
