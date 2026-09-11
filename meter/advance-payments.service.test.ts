import { describe, expect, it } from "vitest";
import { buildAdvancePaymentsReport } from "./advance-payments.service";

const NOW = new Date("2026-09-01T00:00:00.000Z");

describe("buildAdvancePaymentsReport", () => {
  it("sets the payments of a year against the calculated cost", () => {
    const report = buildAdvancePaymentsReport(
      [
        { id: 1, name: "Strom", type: "electricity" },
        { id: 2, name: "Wasser", type: "water" },
      ],
      [
        { meterId: 1, bookingDate: "2025-01-15", amount: -85 },
        { meterId: 1, bookingDate: "2025-02-15", amount: -85 },
        // A refund booked as a positive amount reduces what was paid.
        { meterId: 1, bookingDate: "2025-03-01", amount: 20 },
        { meterId: 1, bookingDate: "2026-01-15", amount: -90 },
      ],
      new Map([[1, new Map([[2025, 120.5]])]]),
      NOW,
    );

    expect(report.meters).toHaveLength(1);
    const strom = report.meters[0];
    expect(strom.meterId).toBe(1);
    expect(strom.years).toEqual([
      {
        year: 2025,
        paidEur: 150,
        transactions: 3,
        actualCostEur: 120.5,
        expectedSettlementEur: 29.5,
        partial: false,
      },
      {
        year: 2026,
        paidEur: 90,
        transactions: 1,
        actualCostEur: null,
        expectedSettlementEur: null,
        partial: true,
      },
    ]);
  });

  it("leaves the settlement open where no cost model exists", () => {
    const report = buildAdvancePaymentsReport(
      [{ id: 3, name: "Gas", type: "gas" }],
      [{ meterId: 3, bookingDate: "2025-06-01", amount: -50 }],
      new Map(),
      NOW,
    );
    expect(report.meters[0].years[0]).toMatchObject({
      paidEur: 50,
      actualCostEur: null,
      expectedSettlementEur: null,
    });
  });
});
