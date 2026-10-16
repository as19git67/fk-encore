/**
 * Grouped transaction reports (#1533): subtotals, totals and both yield
 * figures, computed in cents on synthetic bookings.
 */

import { describe, it, expect } from "vitest";
import { buildGroupedReport, reportDigest, type ReportBooking } from "./grouped-report";

/** Intl puts a no-break space before the currency sign. */
const plain = (s: string) => s.replace(/\u00a0/g, " ");

function b(id: number, date: string, amount: string, counterparty = "Beispiel GmbH"): ReportBooking {
  return { id, booking_date: date, counterparty, purpose: null, amount, currency_code: "EUR" };
}

const BOOKINGS = [
  b(1, "2024-04-01", "-400000.00", "Notariat Musterstadt"),
  b(2, "2024-04-15", "-50000.00", "Verkäufer Beispiel"),
  b(3, "2024-06-10", "-1200.50", "Handwerk Muster"),
  b(4, "2024-09-03", "-299.99", "Handwerk Muster"),
  b(5, "2024-05-01", "900.00", "Mieter A"),
  b(6, "2024-06-01", "900.00", "Mieter A"),
  b(7, "2024-07-01", "900.10", "Mieter A"),
  b(8, "2024-08-15", "-0.10", "Bank"),
];

const GROUPS = [
  { name: "Kauf", transaction_ids: [1, 2] },
  { name: "Reparatur", transaction_ids: [3, 4] },
  { name: "Mieteinnahmen", transaction_ids: [5, 6, 7] },
];

describe("buildGroupedReport", () => {
  it("sums each group and the whole in cents", () => {
    const r = buildGroupedReport({ title: "Wohnung", groups: GROUPS, bookings: BOOKINGS, all: [1, 2, 3, 4, 5, 6, 7, 8], today: "2025-04-01" });
    expect(r.groups.map((g) => [g.name, g.count, g.subtotal])).toEqual([
      ["Kauf", 2, -45000000],
      ["Reparatur", 2, -150049],
      ["Mieteinnahmen", 3, 270010],
      ["Sonstige", 1, -10],
    ]);
    expect(r.total).toBe(-45000000 - 150049 + 270010 - 10);
    expect(r.count).toBe(8);
    expect(r.currency).toBe("EUR");
    // Bookings in a group are in date order.
    expect(r.groups[2].bookings.map((x) => x.id)).toEqual([5, 6, 7]);
  });

  it("lists what no group took under 'Sonstige', and leaves it out when nothing is left", () => {
    const without = buildGroupedReport({ title: "x", groups: GROUPS, bookings: BOOKINGS, today: "2025-01-01" });
    expect(without.groups.map((g) => g.name)).toEqual(["Kauf", "Reparatur", "Mieteinnahmen"]);
    expect(without.count).toBe(7);
  });

  it("refuses a booking in two groups, a twice-named group and the reserved name", () => {
    expect(() => buildGroupedReport({
      title: "x", groups: [{ name: "A", transaction_ids: [1] }, { name: "B", transaction_ids: [1] }], bookings: BOOKINGS, today: "2025-01-01",
    })).toThrow('booking 1 is in "A" and "B"');
    expect(() => buildGroupedReport({
      title: "x", groups: [{ name: "A", transaction_ids: [1] }, { name: "A", transaction_ids: [2] }], bookings: BOOKINGS, today: "2025-01-01",
    })).toThrow('named twice');
    expect(() => buildGroupedReport({
      title: "x", groups: [{ name: "Sonstige", transaction_ids: [1] }], bookings: BOOKINGS, today: "2025-01-01",
    })).toThrow("filled by the report itself");
  });

  it("refuses mixed currencies and bookings it was not given", () => {
    expect(() => buildGroupedReport({
      title: "x", groups: [{ name: "A", transaction_ids: [1, 9] }], bookings: [...BOOKINGS, { ...b(9, "2024-01-01", "1.00"), currency_code: "USD" }], today: "2025-01-01",
    })).toThrow("more than one currency");
    expect(() => buildGroupedReport({ title: "x", groups: [{ name: "A", transaction_ids: [99] }], bookings: BOOKINGS, today: "2025-01-01" }))
      .toThrow("bookings not found: 99");
  });
});

describe("yield", () => {
  const spec = { investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: ["Reparatur"] };

  it("is net income over the investment, and per year over the span since the first investment booking", () => {
    // 2024-04-01 → 2026-04-01: 730 days, 1.9986 years.
    const r = buildGroupedReport({ title: "x", groups: GROUPS, bookings: BOOKINGS, yield: spec, today: "2026-04-01" });
    const y = r.yield!;
    expect(y.investment).toBe(45000000);
    expect(y.income).toBe(270010);
    expect(y.costs).toBe(-150049);
    expect(y.net).toBe(119961);
    expect(y.total).toBeCloseTo(119961 / 45000000, 12);
    expect(y.days).toBe(730);
    expect(y.per_year).toBeCloseTo((119961 / 45000000) / (730 / 365.25), 12);
    expect(y.from).toBe("2024-04-01");
    expect(plain(y.formula)).toContain("(2.700,10 € + -1.500,49 €) ÷ 450.000,00 € = 0,27 %");
    expect(plain(y.formula)).toContain("730 Tage vom 01.04.2024 bis 01.04.2026");
  });

  it("scales a span shorter than a year up to a year", () => {
    // 2024-04-01 → 2024-09-30: 182 days.
    const r = buildGroupedReport({ title: "x", groups: GROUPS, bookings: BOOKINGS, yield: spec, today: "2024-09-30" });
    const y = r.yield!;
    expect(y.days).toBe(182);
    expect(y.per_year).toBeGreaterThan(y.total);
    expect(y.per_year).toBeCloseTo(y.total * (365.25 / 182), 12);
  });

  it("needs an investment that went out and groups that exist", () => {
    expect(() => buildGroupedReport({
      title: "x", groups: GROUPS, bookings: BOOKINGS, today: "2025-01-01",
      yield: { investment_group: "Mieteinnahmen", income_groups: [], cost_groups: [] },
    })).toThrow("holds no money paid out");
    expect(() => buildGroupedReport({
      title: "x", groups: GROUPS, bookings: BOOKINGS, today: "2025-01-01",
      yield: { investment_group: "Kauf", income_groups: ["Miete"], cost_groups: [] },
    })).toThrow('does not have');
  });

  it("is spelled out in the digest the assistant may repeat", () => {
    const r = buildGroupedReport({ title: "x", groups: GROUPS, bookings: BOOKINGS, yield: spec, today: "2026-04-01" });
    const digest = plain(reportDigest(r));
    expect(digest).toContain("Kauf: 2 Buchungen, -450.000,00 €");
    expect(digest).toContain("Summe: 7 Buchungen");
    expect(digest).toContain("Rendite p. a.");
  });
});
