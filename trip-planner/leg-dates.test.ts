import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isCalendarDate, redateLegs } from "./leg-dates";

describe("isCalendarDate", () => {
  it("accepts a real day", () => {
    expect(isCalendarDate("2026-09-05")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
  });

  it("rejects a day that does not exist", () => {
    // The regex is happy with this one; `Date` turns it into March.
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
  });

  it("rejects anything that is not a bare date", () => {
    for (const value of ["05.09.2026", "2026-9-5", "2026-09-05T10:00:00Z", ""]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });
});

describe("addDays and daysBetween", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-09-29", 3)).toBe("2026-10-02");
  });

  it("crosses a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("goes backwards", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-01-05", "2026-01-01")).toBe(-4);
  });

  it("survives a daylight-saving change", () => {
    // The clocks go back in Europe on the last Sunday in October. A
    // date built from a local `Date` would land 23 or 25 hours out and
    // round to the wrong day; these are UTC midnights.
    expect(addDays("2026-10-24", 3)).toBe("2026-10-27");
    expect(daysBetween("2026-10-24", "2026-10-27")).toBe(3);
  });
});

describe("redateLegs", () => {
  it("dates an undated trip leg after leg", () => {
    const legs = [
      { legId: 1, startDate: null, days: 3 },
      { legId: 2, startDate: null, days: 2 },
      { legId: 3, startDate: null, days: 4 },
    ];
    expect(redateLegs(legs, "2026-09-10")).toEqual([
      { legId: 1, startDate: "2026-09-10" },
      { legId: 2, startDate: "2026-09-13" },
      { legId: 3, startDate: "2026-09-15" },
    ]);
  });

  it("shifts a dated trip and keeps the gaps in it", () => {
    // Two days between the two cities — a slow train, or a night
    // somewhere not planned here. Recomputing from the lengths would
    // eat them.
    const legs = [
      { legId: 1, startDate: "2026-09-10", days: 3 },
      { legId: 2, startDate: "2026-09-15", days: 2 },
    ];
    expect(redateLegs(legs, "2026-09-17")).toEqual([
      { legId: 1, startDate: "2026-09-17" },
      { legId: 2, startDate: "2026-09-22" },
    ]);
  });

  it("shifts backwards as readily as forwards", () => {
    const legs = [{ legId: 1, startDate: "2026-09-10", days: 3 }];
    expect(redateLegs(legs, "2026-09-03")).toEqual([
      { legId: 1, startDate: "2026-09-03" },
    ]);
  });

  it("dates a leg the first one left behind", () => {
    // A half-dated trip should not stay half-dated.
    const legs = [
      { legId: 1, startDate: "2026-09-10", days: 3 },
      { legId: 2, startDate: null, days: 2 },
    ];
    expect(redateLegs(legs, "2026-09-11")).toEqual([
      { legId: 1, startDate: "2026-09-11" },
      { legId: 2, startDate: "2026-09-11" },
    ]);
  });

  it("has nothing to say about a trip with no legs", () => {
    expect(redateLegs([], "2026-09-10")).toEqual([]);
  });
});
