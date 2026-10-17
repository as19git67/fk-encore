import { describe, expect, it } from "vitest";
import { pvTaxStatus } from "./pv";

describe("pvTaxStatus", () => {
  it("exempts a small system from 2022, not before", () => {
    expect(pvTaxStatus({ capacityKwp: 9.9, year: 2025, override: null })).toMatchObject({ exempt: true, source: "rule" });
    expect(pvTaxStatus({ capacityKwp: 30, year: 2022, override: null }).exempt).toBe(true);
    expect(pvTaxStatus({ capacityKwp: 9.9, year: 2021, override: null })).toMatchObject({ exempt: false, source: "rule" });
  });

  it("keeps a large system taxable and says why", () => {
    const s = pvTaxStatus({ capacityKwp: 30.5, year: 2025, override: null });
    expect(s.exempt).toBe(false);
    expect(s.reason).toContain("über 30 kWp");
  });

  it("cannot decide without a capacity, and the override wins", () => {
    expect(pvTaxStatus({ capacityKwp: null, year: 2025, override: null })).toMatchObject({ exempt: null, source: "unknown" });
    expect(pvTaxStatus({ capacityKwp: null, year: 2025, override: "exempt" })).toMatchObject({ exempt: true, source: "override" });
    expect(pvTaxStatus({ capacityKwp: 9.9, year: 2025, override: "taxable" })).toMatchObject({ exempt: false, source: "override" });
  });
});
