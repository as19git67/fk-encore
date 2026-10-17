import { describe, expect, it } from "vitest";
import { buildEuer, defaultEuerLines, OTHER_EXPENSES, OTHER_INCOME } from "./euer";

const LINES = [
  { name: "Pachteinnahmen", kind: "income" as const, tags: ["Pacht"], form_line: "Zeile 14" },
  { name: "Grundsteuer", kind: "expense" as const, tags: ["Grundsteuer"], form_line: null },
  { name: "Versicherungen", kind: "expense" as const, tags: ["Versicherung"], form_line: null },
];

const booking = (id: number, date: string, amount: string, tags: string[], flagged = true) =>
  ({ id, booking_date: date, counterparty: "Beispiel GbR", purpose: "x", amount, tags: ["Landwirtschaft", ...tags], is_tax_relevant: flagged });

describe("buildEuer", () => {
  it("sorts the bookings into the lines by tag, sums in the line's direction and adds the AfA", () => {
    const r = buildEuer({
      year: 2025, business: "Hof", tag: "Landwirtschaft", lines: LINES,
      bookings: [
        booking(1, "2025-03-01", "430.00", ["Pacht"]),
        booking(2, "2025-09-01", "430.00", ["pacht"]),
        booking(3, "2025-02-15", "-120.50", ["Grundsteuer"]),
        booking(4, "2025-05-10", "-310.00", ["Versicherung"]),
        booking(5, "2025-06-01", "25.00", ["Versicherung"]),
      ],
      afa: [{ asset_id: 7, name: "Stall", afa: 240000 }],
    });
    expect(r.income.map((l) => [l.name, l.count, l.sum])).toEqual([["Pachteinnahmen", 2, 86000]]);
    expect(r.expenses.map((l) => [l.name, l.count, l.sum])).toEqual([["Grundsteuer", 1, 12050], ["Versicherungen", 2, 28500]]);
    expect(r.afa.sum).toBe(240000);
    expect(r.total_income).toBe(86000);
    expect(r.total_expenses).toBe(12050 + 28500 + 240000);
    expect(r.result).toBe(86000 - 280550);
    expect(r.income[0]!.form_line).toBe("Zeile 14");
    expect(r.income[0]!.bookings.map((b) => b.id)).toEqual([1, 2]);
    expect(r.hints).toEqual([]);
  });

  it("puts what no line claims into Sonstige by sign and says so, and counts unflagged bookings", () => {
    const r = buildEuer({
      year: 2025, business: "Hof", tag: "Landwirtschaft", lines: LINES,
      bookings: [booking(1, "2025-01-01", "80.00", ["Jagd"]), booking(2, "2025-01-02", "-45.00", [], false)],
      afa: [],
    });
    expect(r.income.map((l) => [l.name, l.sum, l.other])).toEqual([["Pachteinnahmen", 0, false], [OTHER_INCOME, 8000, true]]);
    expect(r.expenses.map((l) => [l.name, l.sum, l.other])).toEqual([["Grundsteuer", 0, false], ["Versicherungen", 0, false], [OTHER_EXPENSES, 4500, true]]);
    expect(r.unflagged).toBe(1);
    expect(r.hints.join(" ")).toContain(`1 booking(s) went to "${OTHER_INCOME}"`);
    expect(r.hints.join(" ")).toContain("1 booking(s) of the business are not flagged tax-relevant");
  });

  it("the first line in order wins when a booking carries tags of two lines", () => {
    const r = buildEuer({
      year: 2025, business: "Hof", tag: "Landwirtschaft",
      lines: [LINES[1]!, LINES[2]!],
      bookings: [booking(1, "2025-01-01", "-10.00", ["Versicherung", "Grundsteuer"])],
      afa: [],
    });
    expect(r.expenses.map((l) => l.count)).toEqual([1, 0]);
  });

  it("hints when there is no tag or no booking, and when a line runs negative", () => {
    expect(buildEuer({ year: 2025, business: "Hof", tag: null, lines: [], bookings: [], afa: [] }).hints[0]).toContain("no booking tag");
    expect(buildEuer({ year: 2025, business: "Hof", tag: "LW", lines: [], bookings: [], afa: [] }).hints[0]).toContain('No booking of 2025 carries the tag "LW"');
    const r = buildEuer({ year: 2025, business: "Hof", tag: "LW", lines: [LINES[0]!], bookings: [booking(1, "2025-01-01", "-5.00", ["Pacht"])], afa: [] });
    expect(r.income[0]!.sum).toBe(-500);
    expect(r.hints.join(" ")).toContain('"Pachteinnahmen" sums to a negative amount');
  });

  it("every kind starts with lines of both directions", () => {
    for (const kind of ["landwirtschaft", "photovoltaik", "vermietung", "gewerbe"]) {
      const lines = defaultEuerLines(kind);
      expect(lines.some((l) => l.kind === "income")).toBe(true);
      expect(lines.some((l) => l.kind === "expense")).toBe(true);
    }
  });
});
