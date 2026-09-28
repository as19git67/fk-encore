/**
 * Suggesting a journey (§22.7): one pair of places far enough apart,
 * framed the way the journey screen opens, and nothing written.
 * Every place is invented.
 */
import { describe, expect, it } from "vitest";
import { MIN_DRIVE_MINUTES, suggestTransit, type SuggestableLeg } from "./transit-suggestion";

function leg(position: number, lat: number, lon: number, over: Partial<SuggestableLeg> = {}): SuggestableLeg {
  return {
    position, kind: "stay", title: `Ort ${position}`, anchor: { lat, lon }, mode: "car",
    startDate: "2026-09-05", arriveMinutes: null, days: [{}, {}], ...over,
  };
}

const near = leg(1, 48.4, 10.95, { startDate: "2026-09-07" });
const far = leg(1, 49.9, 13.9, { startDate: "2026-09-07" });

describe("suggesting a journey", () => {
  it("suggests the drive between two places far apart, leaving on the last day at ten", () => {
    const s = suggestTransit([leg(0, 48.37, 10.9), far]);
    expect(s).not.toBeNull();
    expect(s!.driveMinutes).toBeGreaterThanOrEqual(MIN_DRIVE_MINUTES);
    expect(s).toMatchObject({
      afterLegIndex: 0, departDate: "2026-09-06", departAt: "10:00", arriveDate: "2026-09-06",
      mode: "car", fromTitle: "Ort 0", toTitle: "Ort 1",
    });
    expect(s!.sentence).toMatch(/^Von Ort 0 nach Ort 1 sind es rund \d+ h/);
  });

  it("arrives when the next place expects the group, if it says", () => {
    const s = suggestTransit([leg(0, 48.37, 10.9), { ...far, arriveMinutes: 18 * 60 }]);
    expect(s?.arriveAt).toBe("18:00");
  });

  it("says nothing about a short hop, a trip on foot, or a pair that has its journey", () => {
    expect(suggestTransit([leg(0, 48.37, 10.9), near])).toBeNull();
    expect(suggestTransit([leg(0, 48.37, 10.9, { mode: "foot" }), { ...far, mode: "transit" }])).toBeNull();
    expect(suggestTransit([
      leg(0, 48.37, 10.9),
      leg(1, 49.9, 13.9, { kind: "transit", startDate: "2026-09-06" }),
      leg(2, 49.9, 13.9, { startDate: "2026-09-06" }),
    ])).toBeNull();
  });

  it("needs dates", () => {
    expect(suggestTransit([leg(0, 48.37, 10.9, { startDate: null }), far])).toBeNull();
  });
});

describe("suggesting the way there and home", () => {
  const home = { lat: 50.1, lon: 8.7, label: "Zuhause in Musterstadt" };

  it("suggests the journey from home first, arriving when the first place expects the group", () => {
    const s = suggestTransit([leg(0, 48.37, 10.9, { arriveMinutes: 18 * 60 }), far], home);
    expect(s).toMatchObject({
      afterLegIndex: -1, fromTitle: "Zuhause in Musterstadt", toTitle: "Ort 0",
      departDate: "2026-09-05", arriveDate: "2026-09-05", arriveAt: "18:00", mode: "car",
    });
    expect(s!.sentence).toMatch(/Als Anreise geplant/);
  });

  it("suggests the journey home once the way there and the ways between exist", () => {
    const s = suggestTransit([
      leg(0, 48.37, 10.9, { kind: "transit", startDate: "2026-09-05" }),
      leg(1, 48.37, 10.9),
      leg(2, 48.37, 10.9, { kind: "transit", startDate: "2026-09-06" }),
      { ...far, position: 3, startDate: "2026-09-06", days: [{}, {}, {}] },
    ], home);
    expect(s).toMatchObject({ afterLegIndex: 3, fromTitle: "Ort 1", toTitle: "Zuhause in Musterstadt",
                              departDate: "2026-09-08" });
    expect(s!.sentence).toMatch(/Als Heimreise geplant/);
  });

  it("says nothing about home when the trip has none", () => {
    expect(suggestTransit([leg(0, 48.37, 10.9)], null)).toBeNull();
  });
});
