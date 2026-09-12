import { describe, expect, it } from "vitest";
import { MAX_SEARCH_RADIUS_M, mergeByOsmRef, searchRadiusFor } from "./search-reach";

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
