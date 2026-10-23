import { describe, it, expect } from "vitest";

import { allocate, detectSavingsPlans, incomeOverTime, type PlanBuy } from "./portfolio-analysis-calc";

// Synthetic securities and depots only.
const A = "DE0000000AAA1";
const B = "DE0000000BBB2";
const C = "DE0000000CCC3";

describe("portfolio analysis — allocation", () => {
  it("weighs by security and by type, and flags what is above the threshold", () => {
    const a = allocate(
      [
        { key: A, name: "Alpha AG", currency: "EUR", value: 6000, security_type: "equity" },
        { key: B, name: "Beta ETF", currency: "EUR", value: 3000, security_type: "etf" },
        { key: C, name: null, currency: "EUR", value: 1000, security_type: null },
        { key: "Gamma", name: "Gamma", currency: "EUR", value: null, security_type: "fund" },
      ],
      25,
    );
    expect(a.market_value).toBe(10000);
    expect(a.by_security.map((s) => [s.key, s.weight_pct])).toEqual([
      [A, 60],
      [B, 30],
      [C, 10],
    ]);
    expect(a.by_security[2]!.label).toBe(C);
    expect(a.by_type.map((t) => [t.key, t.label, t.weight_pct])).toEqual([
      ["equity", "Aktien", 60],
      ["etf", "ETFs", 30],
      ["unknown", "Unbekannt", 10],
    ]);
    expect(a.concentrated.map((s) => s.key)).toEqual([A, B]);
    expect(a.unvalued).toBe(1);
  });

  it("does not flag a position exactly at the threshold", () => {
    const a = allocate(
      [
        { key: A, name: "A", currency: "EUR", value: 50, security_type: "etf" },
        { key: B, name: "B", currency: "EUR", value: 50, security_type: "etf" },
      ],
      50,
    );
    expect(a.concentrated).toEqual([]);
    expect(a.by_type).toHaveLength(1);
    expect(a.by_type[0]!.positions).toBe(2);
  });
});

describe("portfolio analysis — income over time", () => {
  it("sums per month and year, fills empty months and reads the last twelve months", () => {
    const r = incomeOverTime(
      [
        { day: "2025-03-15", amount: 40, payout: true },
        { day: "2025-03-20", amount: 10, payout: true },
        { day: "2025-11-02", amount: 30, payout: true },
        // Tax on a fund's kept income lowers the income, it is no payout.
        { day: "2026-01-02", amount: -5, payout: false },
        { day: "2026-03-10", amount: 60, payout: true },
      ],
      "2026-03-31",
      2000,
      1500,
    );
    expect(r.months[0]).toEqual({ month: "2025-03", income: 50, payouts: 2 });
    expect(r.months).toHaveLength(13);
    expect(r.months.find((m) => m.month === "2025-06")).toEqual({ month: "2025-06", income: 0, payouts: 0 });
    expect(r.years).toEqual([
      { year: 2025, income: 80, payouts: 3 },
      { year: 2026, income: 55, payouts: 1 },
    ]);
    // 2025-03-31 is the day before the twelve months.
    expect(r.ttm_from).toBe("2025-03-31");
    expect(r.ttm).toBeCloseTo(30 - 5 + 60, 10);
    expect(r.current_yield_pct).toBeCloseTo(85 / 2000 * 100, 10);
    expect(r.yield_on_cost_pct).toBeCloseTo(85 / 1500 * 100, 10);
  });

  it("has no yields without a value or a cost basis", () => {
    const r = incomeOverTime([], "2026-03-31", 0, null);
    expect(r.months).toEqual([]);
    expect(r.current_yield_pct).toBeNull();
    expect(r.yield_on_cost_pct).toBeNull();
  });
});

function monthly(account: number, key: string, from: string, count: number, cash: number, dayOfMonth = 1): PlanBuy[] {
  const [y, m] = from.split("-").map(Number) as [number, number];
  const out: PlanBuy[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, dayOfMonth));
    out.push({ account_id: account, key, day: d.toISOString().slice(0, 10), cash });
  }
  return out;
}

describe("portfolio analysis — savings plans", () => {
  it("finds a monthly plan, active while the next execution is not overdue", () => {
    const plans = detectSavingsPlans(monthly(1, A, "2026-01", 6, 100), "2026-07-10");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ account_id: 1, key: A, interval: "monthly", amount: 100, executions: 6, first: "2026-01-01", last: "2026-06-01", active: true });
    expect(plans[0]!.next).toBe("2026-07-01");
  });

  it("calls a plan without an execution for more than half an interval past due inactive", () => {
    const plans = detectSavingsPlans(monthly(1, A, "2025-01", 4, 100), "2026-07-10");
    expect(plans[0]!.active).toBe(false);
    expect(plans[0]!.next).toBeNull();
  });

  it("tolerates weekends, fees and rounding, but not a one-off purchase", () => {
    const buys: PlanBuy[] = [
      { account_id: 1, key: A, day: "2026-01-02", cash: 100.0 },
      { account_id: 1, key: A, day: "2026-02-03", cash: 101.5 },
      { account_id: 1, key: A, day: "2026-02-15", cash: 2500 },
      { account_id: 1, key: A, day: "2026-03-02", cash: 99.0 },
      { account_id: 1, key: A, day: "2026-04-01", cash: 100.0 },
      { account_id: 1, key: A, day: "2026-05-04", cash: 100.0 },
    ];
    const plans = detectSavingsPlans(buys, "2026-05-10");
    // The one-off buy splits the rhythm: what follows it is the plan.
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ first: "2026-03-02", last: "2026-05-04", executions: 3, interval: "monthly" });
  });

  it("splits a plan whose rate changed, and keeps depots and securities apart", () => {
    const buys = [
      ...monthly(1, A, "2025-01", 4, 100),
      ...monthly(1, A, "2025-05", 4, 200),
      ...monthly(2, A, "2025-01", 2, 100),
      ...monthly(1, B, "2025-01", 3, 50, 15),
    ];
    const plans = detectSavingsPlans(buys, "2025-08-20");
    expect(plans.map((p) => [p.account_id, p.key, p.amount, p.executions]).sort()).toEqual(
      [
        [1, A, 100, 4],
        [1, A, 200, 4],
        [1, B, 50, 3],
      ].sort(),
    );
  });

  it("finds a quarterly plan and ignores irregular buys", () => {
    const quarterly: PlanBuy[] = ["2025-01-15", "2025-04-15", "2025-07-15", "2025-10-15"].map((day) => ({ account_id: 1, key: A, day, cash: 300 }));
    const irregular: PlanBuy[] = ["2025-01-10", "2025-03-01", "2025-03-20", "2025-09-01"].map((day) => ({ account_id: 1, key: B, day, cash: 300 }));
    const plans = detectSavingsPlans([...quarterly, ...irregular], "2025-11-01");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ key: A, interval: "quarterly", executions: 4 });
  });

  it("needs three executions and a known amount", () => {
    expect(detectSavingsPlans(monthly(1, A, "2026-01", 2, 100), "2026-03-01")).toEqual([]);
    expect(detectSavingsPlans(monthly(1, A, "2026-01", 4, 100).map((b) => ({ ...b, cash: null })), "2026-05-01")).toEqual([]);
  });
});
