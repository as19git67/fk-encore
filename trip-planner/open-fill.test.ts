import { describe, expect, it } from "vitest";
import { fitPicks, pickForDay, type FillDay, type FillSpot } from "./open-fill";

const HOME = { lat: 48.37, lon: 10.9 };
const east = (m: number) => ({ lat: HOME.lat, lon: HOME.lon + m / 74_000 });
const north = (m: number) => ({ lat: HOME.lat + m / 111_000, lon: HOME.lon });

function day(over: Partial<FillDay> = {}): FillDay {
  return {
    dayIndex: 0,
    date: "2026-09-03", // a Thursday
    start: HOME,
    end: HOME,
    anchors: [],
    freeMinutes: 600,
    wetness: null,
    drierDayAhead: false,
    otherDates: ["2026-09-04"],
    ...over,
  };
}

function spot(osmRef: string, over: Partial<FillSpot> = {}): FillSpot {
  return { osmRef, name: osmRef, ...east(500), dwellMinutes: 60, category: "museum", ...over };
}

const refs = (picks: Array<{ osmRef: string }>) => picks.map((p) => p.osmRef);

describe("pickForDay", () => {
  it("takes Muss first, then Will, then Wenn Zeit, while the free time lasts", () => {
    // 200 free, less a fifth for the ways: 160 minutes of spots.
    const picks = pickForDay(day({ freeMinutes: 200 }), [
      spot("maybe", { priority: "maybe", dwellMinutes: 60 }),
      spot("want", { priority: "want", dwellMinutes: 60 }),
      spot("must", { priority: "must", dwellMinutes: 90 }),
    ]);
    expect(refs(picks)).toEqual(["must", "want"]);
    expect(picks[0].reasons).toContain("Muss");
  });

  it("skips what does not fit and still takes a smaller one", () => {
    const picks = pickForDay(day({ freeMinutes: 100 }), [
      spot("big", { dwellMinutes: 120 }),
      spot("small", { dwellMinutes: 30 }),
    ]);
    expect(refs(picks)).toEqual(["small"]);
  });

  it("leaves out food and what is closed that day", () => {
    const picks = pickForDay(day(), [
      spot("cafe", { category: "food" }),
      spot("closed", { openingHours: "Fr-Su 10:00-18:00" }),
      spot("open"),
    ]);
    expect(refs(picks)).toEqual(["open"]);
  });

  it("says when a spot is open today and closed on another day of the stay", () => {
    const [pick] = pickForDay(day(), [spot("thu", { openingHours: "Mo-Th 10:00-18:00" })]);
    expect(pick.reasons).toContain("heute geöffnet, Fr zu");
  });

  it("keeps outdoor spots off a rainy day when a drier one is coming", () => {
    const open = [spot("park", { category: "outdoors" }), spot("museum")];
    expect(refs(pickForDay(day({ wetness: 2, drierDayAhead: true }), open))).toEqual(["museum"]);
    expect(refs(pickForDay(day({ wetness: 2, drierDayAhead: false }), open)).sort()).toEqual(["museum", "park"]);
    const [museum] = pickForDay(day({ wetness: 2, drierDayAhead: true }), open);
    expect(museum.reasons).toContain("drinnen, falls es regnet");
  });

  it("prefers the spot on the way to a fixed time and says so", () => {
    const ticket = { ...east(3_000), label: "Turm", fixedMinutes: 15 * 60 + 30 };
    const picks = pickForDay(day({ anchors: [ticket] }), [
      spot("aside", { ...north(2_000) }),
      spot("onTheWay", { ...east(1_500) }),
    ]);
    expect(refs(picks)).toEqual(["onTheWay", "aside"]);
    expect(picks[0].reasons).toContain("auf dem Weg zu Turm 15:30");
    expect(picks[1].reasons.some((r) => r.startsWith("auf dem Weg"))).toBe(false);
  });

  it("is open every day for a stay without dates", () => {
    const picks = pickForDay(day({ date: null, otherDates: [] }), [spot("closedFri", { openingHours: "Fr 10:00-12:00" })]);
    expect(refs(picks)).toEqual(["closedFri"]);
    expect(picks[0].reasons).toEqual([]);
  });
});

describe("fitPicks", () => {
  it("takes picks off the end until the day fits", () => {
    const picks = ["a", "b", "c"].map((osmRef) => ({ osmRef, name: osmRef, reasons: [] }));
    const kept = fitPicks(picks, (r) => Math.max(0, r.length * 50 - 100));
    expect(refs(kept)).toEqual(["a", "b"]);
    expect(fitPicks(picks, () => 10)).toEqual([]);
  });
});
