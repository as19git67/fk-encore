import { describe, expect, it } from "vitest";
import { depreciationOfYear, depreciationSchedule, monthsHeld } from "./depreciation";

const BARN = { acquisition_date: "2020-04-15", acquisition_cost: "120000.00", afa_rate_pct: "2" };

describe("linear AfA", () => {
  it("counts the month of acquisition and writes a building off at 2 % a year", () => {
    const rows = depreciationSchedule(BARN, 2022);
    expect(rows.map((r) => [r.year, r.months, r.afa, r.book_value])).toEqual([
      [2020, 9, "1800.00", "118200.00"],
      [2021, 12, "2400.00", "115800.00"],
      [2022, 12, "2400.00", "113400.00"],
    ]);
    expect(rows[2]!.accumulated).toBe("6600.00");
  });

  it("stops at the residual value of 1 EUR while the asset is held", () => {
    const rows = depreciationSchedule({ acquisition_date: "2020-01-01", acquisition_cost: "1000.00", afa_rate_pct: "50" }, 2023);
    expect(rows.map((r) => [r.year, r.afa, r.book_value])).toEqual([
      [2020, "500.00", "500.00"],
      [2021, "499.00", "1.00"],
      [2022, "0.00", "1.00"],
      [2023, "0.00", "1.00"],
    ]);
  });

  it("depreciates pro rata up to the month of disposal and settles the book value against the proceeds", () => {
    const rows = depreciationSchedule({ ...BARN, disposal_date: "2022-03-20", disposal_proceeds: "100000.00" }, 2025);
    expect(rows.at(-1)).toEqual({ year: 2022, months: 3, afa: "600.00", accumulated: "4800.00", book_value: "0.00", disposal_result: "-15200.00" });
  });

  it("never writes off land, and knows the years before the start", () => {
    const land = { acquisition_date: "2015-06-01", acquisition_cost: "80000.00", afa_rate_pct: "0" };
    expect(depreciationOfYear(land, 2025)).toMatchObject({ months: 12, afa: "0.00", book_value: "80000.00" });
    expect(depreciationOfYear(BARN, 2019)).toMatchObject({ months: 0, afa: "0.00", book_value: "0.00" });
  });

  it("starts the AfA at a later date when told so", () => {
    expect(depreciationOfYear({ ...BARN, afa_start_date: "2021-10-01" }, 2021)).toMatchObject({ months: 3, afa: "600.00" });
    expect(monthsHeld(2021, "2021-10-01", null)).toBe(3);
    expect(monthsHeld(2021, "2021-10-01", "2021-11-30")).toBe(2);
  });
});
