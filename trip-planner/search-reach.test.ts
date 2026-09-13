import { describe, expect, it } from "vitest";
import {
  DAY_TRIP_REACH_M,
  dayTripRadiusFor,
  MAX_SEARCH_RADIUS_M,
  mergeByOsmRef,
  searchRadiusFor,
} from "./search-reach";

describe("searchRadiusFor", () => {
  it("keeps the walking radius the planner always used", () => {
    // On foot the old default was never wrong; it was only ever wrong
    // for everybody else.
    expect(searchRadiusFor("foot")).toBe(3_000);
  });

  it("reaches across a city when the leg has a car", () => {
    // The bug this exists for: a trip to San Francisco found the blocks
    // around the hotel because everything else was outside 2.5 km.
    expect(searchRadiusFor("car")).toBeGreaterThanOrEqual(20_000);
    expect(searchRadiusFor("transit")).toBeGreaterThan(searchRadiusFor("bike"));
    expect(searchRadiusFor("bike")).toBeGreaterThan(searchRadiusFor("foot"));
  });

  it("never asks for more than the geo service will search", () => {
    for (const mode of ["foot", "bike", "transit", "car", "hovercraft", undefined]) {
      expect(searchRadiusFor(mode)).toBeLessThanOrEqual(MAX_SEARCH_RADIUS_M);
    }
  });

  it("treats a mode it has not learned about as walking", () => {
    // Under-reaching is the safe error: it plans a smaller day rather
    // than one nobody can travel.
    expect(searchRadiusFor("hovercraft")).toBe(searchRadiusFor("foot"));
  });
});

describe("mergeByOsmRef", () => {
  const near = [{ osmRef: "node:1" }, { osmRef: "node:2" }];
  const prominent = [{ osmRef: "node:2" }, { osmRef: "way:9" }];

  it("keeps a spot found by both searches exactly once", () => {
    expect(mergeByOsmRef(near, prominent).map((s) => s.osmRef))
      .toEqual(["node:1", "node:2", "way:9"]);
  });

  it("lets the near page lead", () => {
    // All else equal the plan should prefer what you can walk to; the
    // famous thing is already ahead on score.
    expect(mergeByOsmRef(near, prominent)[0]?.osmRef).toBe("node:1");
  });

  it("handles an empty side", () => {
    expect(mergeByOsmRef([], prominent)).toHaveLength(2);
    expect(mergeByOsmRef(near, [])).toHaveLength(2);
    expect(mergeByOsmRef([], [])).toEqual([]);
  });
});

describe("dayTripRadiusFor", () => {
  const carLeg = searchRadiusFor("car");

  it("plans an outing at the size of the place, not the car's range", () => {
    // The bug this exists for: quarters on a lake, a day trip to a city
    // an hour away, and every proposed spot 20 km outside that city —
    // the leg's driving reach, inherited by a day that had already
    // driven.
    expect(dayTripRadiusFor(null, carLeg)).toBe(DAY_TRIP_REACH_M);
    expect(dayTripRadiusFor(null, carLeg)).toBeLessThan(carLeg);
  });

  it("keeps a leg that already reaches less", () => {
    // Walking to the day trip and then being offered eight kilometres
    // of it is the same mistake mirrored.
    expect(dayTripRadiusFor(undefined, searchRadiusFor("foot"))).toBe(3_000);
    expect(dayTripRadiusFor(undefined, 1_500)).toBe(1_500);
  });

  it("lets the day say how far it wants to look", () => {
    // "We are staying in the old town" and "we want to drive the whole
    // valley" are both answers the table cannot give.
    expect(dayTripRadiusFor(1_200, carLeg)).toBe(1_200);
    expect(dayTripRadiusFor(30_000, carLeg)).toBe(30_000);
  });

  it("never asks for more than the geo service will search", () => {
    expect(dayTripRadiusFor(MAX_SEARCH_RADIUS_M * 3, carLeg)).toBe(MAX_SEARCH_RADIUS_M);
  });

  it("falls back to the place-sized default when the stored radius is nonsense", () => {
    // Under-reaching is the safe error here too: a smaller day beats a
    // day in the wrong county.
    expect(dayTripRadiusFor(0, carLeg)).toBe(DAY_TRIP_REACH_M);
    expect(dayTripRadiusFor(-500, carLeg)).toBe(DAY_TRIP_REACH_M);
    expect(dayTripRadiusFor(Number.NaN, carLeg)).toBe(DAY_TRIP_REACH_M);
  });
});
