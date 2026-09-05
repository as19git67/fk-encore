/**
 * Deciding that a spot was visited (§6.4).
 *
 * The rule these tests protect is an asymmetry: a wrong tick costs one
 * swipe to undo, a false alarm interrupts a holiday. So one signal only
 * ever asks, and two may act. Most of what follows is about the cases
 * where the module must *not* be confident.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_DWELL_MINUTES,
  assessVisit,
  dwellThresholdMinutes,
  isOnTheWay,
} from "./visits";

describe("how long counts as a visit", () => {
  it("never falls below ten minutes, however short the plan", () => {
    // A quarter of a twenty-minute viewpoint is five, and five minutes
    // is a photo stop rather than a visit.
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 20 })).toBe(MIN_DWELL_MINUTES);
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 0 })).toBe(MIN_DWELL_MINUTES);
  });

  it("rises with the planned stay, so walking past a museum is not a visit", () => {
    // A quarter of ninety minutes is 22.5, rounded to 23.
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 90 })).toBe(23);
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 240 })).toBe(60);
  });

  it("takes the larger of the two yardsticks, not the smaller", () => {
    // The mistake to avoid: `min` would let ten minutes count at a
    // four-hour site, and five minutes count at a viewpoint.
    for (const planned of [0, 20, 40, 90, 240]) {
      const quarter = planned * 0.25;
      expect(dwellThresholdMinutes({ plannedDwellMinutes: planned }))
        .toBeGreaterThanOrEqual(Math.min(MIN_DWELL_MINUTES, quarter));
      expect(dwellThresholdMinutes({ plannedDwellMinutes: planned }))
        .toBe(Math.round(Math.max(MIN_DWELL_MINUTES, quarter)));
    }
  });

  it("asks for longer at a spot the route passes anyway", () => {
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 20, onTheWay: true })).toBe(15);
    expect(dwellThresholdMinutes({ plannedDwellMinutes: 90, onTheWay: true })).toBe(34);
  });

  it("survives a nonsensical planned duration", () => {
    expect(dwellThresholdMinutes({ plannedDwellMinutes: -30 })).toBe(MIN_DWELL_MINUTES);
    expect(dwellThresholdMinutes({ plannedDwellMinutes: NaN })).toBe(MIN_DWELL_MINUTES);
  });
});

describe("weighing the evidence", () => {
  const museum = { plannedDwellMinutes: 90 };

  it("says nothing at all when nothing fired", () => {
    const { verdict, signals } = assessVisit({ dwellMinutes: 4 }, museum);
    expect(verdict).toBe("none");
    expect(signals).toEqual([]);
  });

  it("asks when one signal fired", () => {
    expect(assessVisit({ dwellMinutes: 40 }, museum).verdict).toBe("suggested");
    expect(assessVisit({ hasMatchingPhoto: true }, museum).verdict).toBe("suggested");
    expect(assessVisit({ hasPayment: true }, museum).verdict).toBe("suggested");
  });

  it("acts when two agree", () => {
    const { verdict, signals } = assessVisit(
      { dwellMinutes: 40, hasMatchingPhoto: true },
      museum,
    );
    expect(verdict).toBe("confirmed");
    expect(signals).toEqual(["dwell", "photo"]);
  });

  it("treats a short stay as no signal rather than half a one", () => {
    // Half the threshold is what walking past looks like. Counting it
    // as partial evidence would let a photo from the pavement confirm
    // a visit that never happened.
    const { verdict, signals } = assessVisit(
      { dwellMinutes: 11, hasMatchingPhoto: true },
      museum,
    );
    expect(signals).toEqual(["photo"]);
    expect(verdict).toBe("suggested");
  });

  it("lets the traveller overrule any amount of inference", () => {
    const { verdict } = assessVisit({ manual: true }, museum);
    expect(verdict).toBe("confirmed");
  });

  it("reports the threshold it measured against", () => {
    // The number belongs in the explanation: "40 von 23 Minuten" is
    // reviewable, "wir glauben ihr wart da" is not.
    expect(assessVisit({ dwellMinutes: 40 }, museum).thresholdMinutes).toBe(23);
  });

  it("meets the threshold exactly rather than needing to beat it", () => {
    expect(assessVisit({ dwellMinutes: 23 }, museum).signals).toEqual(["dwell"]);
    expect(assessVisit({ dwellMinutes: 22 }, museum).signals).toEqual([]);
  });
});

describe("which spots the route passes anyway", () => {
  const route = ["node:a", "node:b", "node:c"];

  it("counts the middle of the sequence, not the ends", () => {
    expect(isOnTheWay(route, "node:b")).toBe(true);
    expect(isOnTheWay(route, "node:a")).toBe(false);
    expect(isOnTheWay(route, "node:c")).toBe(false);
  });

  it("says no for a spot that is not on the route", () => {
    expect(isOnTheWay(route, "node:zzz")).toBe(false);
  });

  it("says no when there is nothing to be between", () => {
    expect(isOnTheWay(["node:a"], "node:a")).toBe(false);
    expect(isOnTheWay([], "node:a")).toBe(false);
  });
});
