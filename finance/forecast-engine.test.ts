import { describe, it, expect } from "vitest";

import {
  simulate,
  earliestLeaveAge,
  leaveAgeMatrix,
  deflate,
  defaultScenario,
  type ForecastInput,
  type ForecastItem,
  type ForecastMilestone,
  type ForecastPerson,
  type ForecastScenario,
} from "./forecast-engine";

// All persons, contracts and amounts below are invented.

const START = "2026-01-01";

const anna: ForecastPerson = { id: 1, label: "A", birthDate: "1970-01-01" }; // 56 at start
const ben: ForecastPerson = { id: 2, label: "B", birthDate: "1973-01-01" }; // 53 at start

function ms(
  id: number,
  personId: number,
  kind: ForecastMilestone["kind"],
  age: number,
): ForecastMilestone {
  return { id, personId, kind, label: kind, age };
}

function scenario(over: Partial<ForecastScenario> = {}): ForecastScenario {
  return defaultScenario({
    inflationRate: 0,
    defaultReturnRate: 0,
    capitalGainsTaxRate: 0,
    endAge: 70,
    spendingCurve: {
      referencePersonId: null,
      phases: [{ fromAge: 0, factor: 1 }],
      careFromAge: null,
      careMonthly: 0,
    },
    ...over,
  });
}

function input(
  items: ForecastItem[],
  milestones: ForecastMilestone[],
  over: Partial<ForecastScenario> = {},
  persons: ForecastPerson[] = [anna],
): ForecastInput {
  return { persons, milestones, items, scenario: scenario(over), startDate: START };
}

const salary = (personId: number, amount: number, id = 10): ForecastItem => ({
  id,
  type: "salary",
  label: "Gehalt",
  personId,
  amount,
  growthRate: 0,
});

const living = (amount: number, id = 20): ForecastItem => ({
  id,
  type: "living_expense",
  label: "Leben",
  personId: null,
  amount,
});

const cash = (value: number, id = 30): ForecastItem => ({
  id,
  type: "asset",
  label: "Tagesgeld",
  personId: null,
  pot: "cash",
  currentValue: value,
  returnRate: 0,
  monthlyContribution: 0,
});

const pension = (
  personId: number,
  amount: number,
  milestoneId: number,
  over: Partial<Extract<ForecastItem, { type: "pension" }>> = {},
): ForecastItem => ({
  id: 40 + personId,
  type: "pension",
  label: "Rente",
  personId,
  kind: "statutory",
  monthlyAmount: amount,
  start: { kind: "milestone", milestoneId },
  regularAge: null,
  deductionPerMonth: 0,
  deductionOffsetCost: null,
  growthRate: 0,
  monthlyContribution: 0,
  lumpSumOption: null,
  payoutMode: "annuity",
  taxRate: 0,
  ...over,
});

describe("simulate — horizon and bookkeeping", () => {
  it("runs from the start year until the youngest person reaches endAge", () => {
    const res = simulate(input([cash(1000)], [], { endAge: 60 }, [anna, ben]));
    // Ben turns 60 in 2033; that year is included.
    expect(res.startYear).toBe(2026);
    expect(res.endYear).toBe(2033);
    expect(res.years.map((y) => y.year)).toEqual([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033]);
    expect(res.years[0].ages["1"]).toBe(56);
    expect(res.years[0].ages["2"]).toBe(53);
  });

  it("puts a surplus into cash", () => {
    const res = simulate(input([salary(1, 3000), living(2000)], [], { endAge: 57 }));
    expect(res.years[0].totalIncome).toBe(36_000);
    expect(res.years[0].totalExpenses).toBe(24_000);
    expect(res.years[0].pots.cash).toBeCloseTo(12_000, 6);
    expect(res.ok).toBe(true);
  });

  it("ends the salary when the person leaves work and lets a pension start", () => {
    const milestones = [ms(1, 1, "leave_work", 58), ms(2, 1, "statutory_pension", 60)];
    const res = simulate(
      input([salary(1, 3000), living(1000), cash(50_000), pension(1, 1500, 2)], milestones, { endAge: 62 }),
    );
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2027].income["item:10"]).toBe(36_000); // still working at 57
    expect(by[2028].income["item:10"]).toBeUndefined(); // left at 58 (Jan 2028)
    expect(by[2028].income["item:41"]).toBeUndefined(); // pension not yet
    expect(by[2030].income["item:41"]).toBe(18_000); // pension from 60
    expect(res.milestones.find((m) => m.id === 1)?.year).toBe(2028);
  });
});

describe("simulate — bridge phases and failure", () => {
  const milestones = [ms(1, 1, "leave_work", 58), ms(2, 1, "statutory_pension", 62)];

  it("detects the bridge between leaving work and the pension and says it is covered", () => {
    // 4 years × 12 × 1000 = 48 000 needed, 60 000 in cash.
    const res = simulate(
      input([salary(1, 3000), living(1000), cash(60_000), pension(1, 1500, 2)], milestones, { endAge: 65 }),
    );
    const personal = res.bridges.find((b) => b.personId === 1)!;
    expect(personal.fromYear).toBe(2028);
    expect(personal.toYear).toBe(2031);
    expect(personal.need).toBeCloseTo(48_000, 6);
    expect(personal.liquidAtStart).toBeCloseTo(60_000 + 2 * 24_000, 6); // plus two years of surplus
    expect(personal.covered).toBe(true);
    const household = res.bridges.find((b) => b.personId === null)!;
    expect(household.fromYear).toBe(2028);
    expect(household.toYear).toBe(2031);
    expect(res.ok).toBe(true);
  });

  it("fails in the year liquid wealth drops below the minimum", () => {
    const res = simulate(
      input([salary(1, 1000), living(1000), cash(10_000), pension(1, 1500, 2)], milestones, { endAge: 65 }),
    );
    // Bridge: 48 000 needed, 10 000 there → runs out in the first bridge year.
    expect(res.ok).toBe(false);
    expect(res.failYear).toBe(2028);
    expect(res.bridges.find((b) => b.personId === 1)?.covered).toBe(false);
    expect(res.potDryYear.cash).toBe(2028);
  });

  it("respects a safety buffer", () => {
    const items = [salary(1, 1000), living(1000), cash(50_000), pension(1, 1500, 2)];
    expect(simulate(input(items, milestones, { endAge: 65 })).ok).toBe(true);
    expect(simulate(input(items, milestones, { endAge: 65, minLiquidWealth: 5_000 })).ok).toBe(false);
  });
});

describe("simulate — withdrawal order and pots", () => {
  it("empties cash before the depot and taxes the gain share of depot sales", () => {
    const depot: ForecastItem = {
      id: 31,
      type: "asset",
      label: "Depot",
      personId: null,
      pot: "depot",
      currentValue: 100_000,
      returnRate: 0,
      monthlyContribution: 0,
    };
    const res = simulate(
      input([living(1000), cash(12_000), depot], [], {
        endAge: 58,
        capitalGainsTaxRate: 0.25,
        depotGainShare: 0.5,
      }),
    );
    const y1 = res.years[0];
    const y2 = res.years[1];
    expect(y1.withdrawals.cash).toBeCloseTo(12_000, 6);
    expect(y1.withdrawals.depot ?? 0).toBe(0);
    // Year 2: 12 000 net needed, 12.5 % tax on the sale → 13 714.29 gross.
    expect(y2.withdrawals.depot).toBeCloseTo(12_000 / 0.875, 3);
    expect(y2.taxes).toBeCloseTo(12_000 / 0.875 - 12_000, 3);
    expect(res.potDryYear.cash).toBe(2026);
  });

  it("leaves real estate untouched and does not count it as liquid", () => {
    const house: ForecastItem = {
      id: 32,
      type: "asset",
      label: "Haus",
      personId: null,
      pot: "real_estate",
      currentValue: 400_000,
      returnRate: 0,
      monthlyContribution: 0,
    };
    const res = simulate(input([living(1000), cash(6_000), house], [], { endAge: 57 }));
    expect(res.ok).toBe(false);
    expect(res.years[0].pots.real_estate).toBe(400_000);
    expect(res.years[0].liquidEnd).toBeLessThan(0);
  });

  it("compounds returns monthly and taxes them", () => {
    const depot: ForecastItem = {
      id: 31,
      type: "asset",
      label: "Depot",
      personId: null,
      pot: "depot",
      currentValue: 100_000,
      returnRate: 0.05,
      monthlyContribution: 0,
    };
    const res = simulate(input([depot], [], { endAge: 57, capitalGainsTaxRate: 0 }));
    expect(res.years[0].pots.depot).toBeCloseTo(105_000, 0);
    const taxed = simulate(input([depot], [], { endAge: 57, capitalGainsTaxRate: 0.5 }));
    expect(taxed.years[0].pots.depot).toBeLessThan(105_000);
    expect(taxed.years[0].taxes).toBeGreaterThan(0);
  });

  it("moves a savings plan from cash into the depot", () => {
    const depot: ForecastItem = {
      id: 31,
      type: "asset",
      label: "Depot",
      personId: null,
      pot: "depot",
      currentValue: 0,
      returnRate: 0,
      monthlyContribution: 500,
    };
    const res = simulate(input([salary(1, 2000), living(1000), depot], [], { endAge: 57 }));
    expect(res.years[0].pots.depot).toBeCloseTo(6_000, 6);
    expect(res.years[0].pots.cash).toBeCloseTo(6_000, 6);
    expect(res.years[0].contributions).toBeCloseTo(6_000, 6);
  });
});

describe("simulate — life insurance", () => {
  const lv = (over: Partial<Extract<ForecastItem, { type: "life_insurance" }>> = {}): ForecastItem => ({
    id: 50,
    type: "life_insurance",
    label: "LV",
    personId: 1,
    surrenderValue: 20_000,
    monthlyPremium: 100,
    guaranteedPayout: 40_000,
    projectedPayout: 50_000,
    maturity: { kind: "milestone", milestoneId: 3 },
    payoutMode: "lump_sum",
    annuityAmount: 0,
    taxRate: 0,
    ...over,
  });
  const milestones = [ms(3, 1, "life_insurance_maturity", 58)];

  it("collects premiums, then pays out the projected sum at maturity", () => {
    const res = simulate(input([cash(10_000), lv()], milestones, { endAge: 59 }));
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2026].expenses["contrib:50"]).toBe(1_200);
    expect(by[2026].contributions).toBe(1_200);
    expect(by[2026].pots.insurance).toBeGreaterThan(20_000);
    expect(by[2028].income["item:50"]).toBe(50_000);
    expect(by[2028].expenses["contrib:50"]).toBeUndefined();
    expect(by[2028].pots.insurance).toBe(0);
    expect(by[2029].pots.cash).toBeCloseTo(10_000 - 2_400 + 50_000, 6);
  });

  it("pays an annuity instead when configured", () => {
    const res = simulate(
      input([cash(10_000), lv({ payoutMode: "annuity", annuityAmount: 300 })], milestones, { endAge: 59 }),
    );
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2028].income["item:50"]).toBe(3_600);
    expect(by[2029].income["item:50"]).toBe(3_600);
  });

  it("surrenders early only when allowed, and at the surrender value", () => {
    const items = [living(1000), cash(6_000), lv({ monthlyPremium: 0 })];
    const strict = simulate(input(items, milestones, { endAge: 57 }));
    expect(strict.ok).toBe(false);
    const lenient = simulate(input(items, milestones, { endAge: 57, allowSurrender: true }));
    expect(lenient.ok).toBe(true);
    expect(lenient.years[0].withdrawals.insurance).toBeGreaterThan(20_000);
    expect(lenient.years[0].withdrawals.insurance).toBeLessThan(50_000);
    expect(lenient.years[1].income["item:50"]).toBeUndefined(); // nothing left to mature
  });
});

describe("simulate — pensions", () => {
  it("applies the early-retirement deduction unless it is bought back", () => {
    const milestones = [ms(2, 1, "statutory_pension", 63)];
    const item = pension(1, 2000, 2, { regularAge: 67, deductionPerMonth: 0.003, deductionOffsetCost: 60_000 });
    const withDeduction = simulate(input([cash(100_000), item], milestones, { endAge: 64 }));
    const y63 = withDeduction.years.find((y) => y.year === 2033)!;
    // 48 months early × 0.3 % = 14.4 % less.
    expect(y63.income["item:41"]).toBeCloseTo(2000 * 0.856 * 12, 3);

    const boughtBack = simulate(input([cash(100_000), item], milestones, { endAge: 64, offsetDeductions: [1] }));
    expect(boughtBack.years.find((y) => y.year === 2033)!.income["item:41"]).toBeCloseTo(24_000, 3);
    expect(boughtBack.years[0].expenses["buyback:41"]).toBe(60_000);
  });

  it("pays the lump sum once when chosen", () => {
    const milestones = [ms(4, 1, "company_pension", 58)];
    const item = pension(1, 500, 4, { kind: "company", lumpSumOption: 80_000, payoutMode: "lump_sum", taxRate: 0.25 });
    const res = simulate(input([item], milestones, { endAge: 59 }));
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2028].income["item:41"]).toBe(60_000);
    expect(by[2028].taxes).toBe(20_000);
    expect(by[2029].income["item:41"]).toBeUndefined();
  });

  it("books own contributions until the start", () => {
    const milestones = [ms(5, 1, "private_pension", 58)];
    const item = pension(1, 400, 5, { kind: "private", monthlyContribution: 200 });
    const res = simulate(input([cash(50_000), item], milestones, { endAge: 58 }));
    expect(res.years[0].expenses["contrib:41"]).toBe(2_400);
    expect(res.years[2].expenses["contrib:41"]).toBeUndefined();
    expect(res.years[2].income["item:41"]).toBe(4_800);
  });

  it("raises a pension yearly", () => {
    const milestones = [ms(2, 1, "statutory_pension", 56)];
    const item = pension(1, 1000, 2, { growthRate: 0.1 });
    const res = simulate(input([item], milestones, { endAge: 57 }));
    expect(res.years[0].income["item:41"]).toBe(12_000);
    expect(res.years[1].income["item:41"]).toBeCloseTo(13_200, 6);
  });
});

describe("simulate — health insurance", () => {
  const hi = (over: Partial<Extract<ForecastItem, { type: "health_insurance" }>> = {}): ForecastItem => ({
    id: 60,
    type: "health_insurance",
    label: "KV",
    personId: 1,
    employedAmount: 400,
    bridgeMode: "statutory_voluntary",
    bridgeAmount: 0,
    retiredMode: "kvdr",
    retiredAmount: 0,
    privateGrowthRate: 0,
    ...over,
  });
  const milestones = [ms(1, 1, "leave_work", 57), ms(2, 1, "statutory_pension", 58)];

  it("switches from the employee share to the minimum contribution to the pensioners' rate", () => {
    const rent: ForecastItem = {
      id: 11,
      type: "income",
      label: "Miete",
      personId: 1,
      amount: 1_000,
      frequency: "monthly",
      growthRate: 0,
      taxRate: 0,
    };
    const res = simulate(
      input([cash(200_000), rent, pension(1, 2_000, 2), hi()], milestones, {
        endAge: 58,
        healthInsurance: { rate: 0.2, minMonthly: 250 },
      }),
    );
    const [working, bridge, retired] = res.years;
    expect(working.expenses["item:60"]).toBe(4_800);
    // Bridge: 20 % of 1 000 rent = 200 < minimum 250.
    expect(bridge.expenses["item:60"]).toBe(3_000);
    // Retired: KVdR is charged on the pension only, not on the rent.
    expect(retired.expenses["item:60"]).toBeCloseTo(0.2 * 2_000 * 12, 6);
  });

  it("family insurance costs nothing, a private premium keeps its own increase", () => {
    const fam = simulate(input([cash(100_000), hi({ bridgeMode: "family" })], milestones, { endAge: 57 }));
    expect(fam.years[1].expenses["item:60"]).toBeUndefined();
    const priv = simulate(
      input([cash(100_000), hi({ bridgeMode: "private", bridgeAmount: 600, privateGrowthRate: 0.1 })], milestones, {
        endAge: 57,
      }),
    );
    expect(priv.years[1].expenses["item:60"]).toBeCloseTo(600 * 1.1 * 12, 6);
  });
});

describe("simulate — expenses over time", () => {
  it("indexes living expenses with inflation and the spending curve, and adds care", () => {
    const res = simulate(
      input([cash(1_000_000), living(1_000)], [], {
        endAge: 62,
        inflationRate: 0.1,
        spendingCurve: {
          referencePersonId: 1,
          phases: [
            { fromAge: 0, factor: 1 },
            { fromAge: 58, factor: 0.5 },
          ],
          careFromAge: 60,
          careMonthly: 2_000,
        },
      }),
    );
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2026].expenses["item:20"]).toBeGreaterThan(12_000); // inflation within the year
    expect(by[2026].expenses["item:20"]).toBeLessThan(12_000 * 1.1);
    expect(by[2028].expenses["item:20"]).toBeLessThan(by[2027].expenses["item:20"]); // factor 0.5 at 58
    expect(by[2029].expenses["care:1"]).toBeUndefined();
    expect(by[2030].expenses["care:1"]).toBeGreaterThan(24_000);
  });

  it("handles yearly and one-off items and an item ending mid-year", () => {
    const yearly: ForecastItem = {
      id: 21,
      type: "expense",
      label: "Versicherung",
      personId: null,
      amount: 1_200,
      frequency: "yearly",
      growthRate: 0,
    };
    const once: ForecastItem = {
      id: 22,
      type: "expense",
      label: "Auto",
      personId: null,
      amount: 30_000,
      frequency: "once",
      growthRate: 0,
      start: { kind: "date", date: "2027-06-01" },
    };
    const loan: ForecastItem = {
      id: 23,
      type: "expense",
      label: "Kredit",
      personId: null,
      amount: 500,
      frequency: "monthly",
      growthRate: 0,
      end: { kind: "date", date: "2027-04-01" },
    };
    const res = simulate(input([cash(100_000), yearly, once, loan], [], { endAge: 57 }));
    const [y1, y2] = res.years;
    expect(y1.expenses["item:21"]).toBe(1_200);
    expect(y2.expenses["item:21"]).toBe(1_200);
    expect(y1.expenses["item:22"]).toBeUndefined();
    expect(y2.expenses["item:22"]).toBe(30_000);
    expect(y1.expenses["item:23"]).toBe(6_000);
    expect(y2.expenses["item:23"]).toBe(1_500); // Jan–Mar
  });

  it("raises a salary once a year", () => {
    const res = simulate(input([{ ...salary(1, 1000), growthRate: 0.05 } as ForecastItem], [], { endAge: 57 }));
    expect(res.years[0].income["item:10"]).toBe(12_000);
    expect(res.years[1].income["item:10"]).toBeCloseTo(12_600, 6);
  });
});

describe("two persons", () => {
  const milestones = [
    ms(1, 1, "leave_work", 58),
    ms(2, 1, "statutory_pension", 63),
    ms(3, 2, "leave_work", 60),
    ms(4, 2, "statutory_pension", 65),
  ];

  it("keeps each person's milestones apart and reports overlapping bridges", () => {
    const items = [
      salary(1, 2_000, 10),
      salary(2, 4_000, 11),
      living(3_000),
      cash(500_000),
      pension(1, 1_500, 2),
      pension(2, 1_500, 4),
    ];
    const res = simulate(input(items, milestones, { endAge: 70 }, [anna, ben]));
    const by = Object.fromEntries(res.years.map((y) => [y.year, y]));
    expect(by[2028].income["item:10"]).toBeUndefined(); // A left at 58
    expect(by[2028].income["item:11"]).toBe(48_000); // B still works
    expect(by[2033].income["item:11"]).toBeUndefined(); // B left at 60 (2033)
    const a = res.bridges.find((b) => b.personId === 1)!;
    const b = res.bridges.find((b) => b.personId === 2)!;
    expect([a.fromYear, a.toYear]).toEqual([2028, 2032]);
    expect([b.fromYear, b.toYear]).toEqual([2033, 2037]);
    // Household deficit starts only once both have left.
    const hh = res.bridges.find((x) => x.personId === null)!;
    expect(hh.fromYear).toBe(2033);
  });

  it("finds the earliest leave age for one person and fills the matrix", () => {
    const items = [
      salary(1, 3_000, 10),
      salary(2, 3_000, 11),
      living(3_500),
      cash(50_000),
      pension(1, 1_800, 2),
      pension(2, 1_800, 4),
    ];
    const base = input(items, milestones, { endAge: 75 }, [anna, ben]);
    const earliest = earliestLeaveAge(base, 1, 66);
    // Worked out by hand: 58 leaves 80 000 for a 102 000 bridge of B, 59 leaves 116 000.
    expect(earliest.age).toBe(59);
    expect(earliest.tried[earliest.tried.length - 1].ok).toBe(true);
    // Leaving one year earlier than the found age must fail.
    const earlier = earliest.tried.find((t) => t.age === earliest.age! - 1);
    if (earlier) expect(earlier.ok).toBe(false);

    const cells = leaveAgeMatrix(base, 1, 2, [58, 62, 66], [60, 65]);
    expect(cells).toHaveLength(6);
    const best = cells.find((c) => c.ageA === 66 && c.ageB === 65)!;
    const worst = cells.find((c) => c.ageA === 58 && c.ageB === 60)!;
    expect(best.finalWealth).toBeGreaterThan(worst.finalWealth);
  });

  it("returns null when no leave age works", () => {
    const base = input([salary(1, 100), living(5_000)], milestones, { endAge: 70 }, [anna, ben]);
    expect(earliestLeaveAge(base, 1, 65).age).toBeNull();
  });
});

describe("deflate", () => {
  it("converts nominal to today's purchasing power", () => {
    expect(deflate(121, 2028, 2026, 0.1)).toBeCloseTo(100, 9);
    expect(deflate(100, 2026, 2026, 0.1)).toBe(100);
  });
});
