import { describe, expect, it } from "vitest";
import { DEFAULT_DAY, groupFactor, groupPaceFactor, shapeDay } from "./blocks";

describe("shapeDay", () => {
  it("keeps the four-part default at a normal pace", () => {
    const day = shapeDay();
    expect(day.map((b) => b.id)).toEqual(["morning", "midday", "afternoon", "evening"]);
    expect(day.map((b) => b.budgetMinutes)).toEqual([210, 90, 210, 120]);
  });

  it("shrinks budgets for a relaxed pace and grows them for a packed one", () => {
    const relaxed = shapeDay(DEFAULT_DAY, "relaxed");
    const packed = shapeDay(DEFAULT_DAY, "packed");
    expect(relaxed[0].budgetMinutes).toBeLessThan(210);
    expect(packed[0].budgetMinutes).toBeGreaterThan(210);
  });

  it("treats the group as a hard constraint on the budget", () => {
    const plain = shapeDay(DEFAULT_DAY, "normal")[0].budgetMinutes;
    const children = shapeDay(DEFAULT_DAY, "normal", { withChildren: true })[0].budgetMinutes;
    const both = shapeDay(DEFAULT_DAY, "normal", {
      withChildren: true,
      limitedMobility: true,
    })[0].budgetMinutes;

    expect(children).toBeLessThan(plain);
    expect(both).toBeLessThan(children);
  });

  it("compounds group factors rather than taking the worst one", () => {
    expect(groupFactor({ withChildren: true, limitedMobility: true })).toBeCloseTo(0.56, 5);
  });

  it("accepts a custom day — an arrival with no morning", () => {
    const day = shapeDay(
      [
        { id: "arrival", label: "Anreise", kind: "spots", baseBudgetMinutes: 60 },
        { id: "evening", label: "Abend", kind: "spots", baseBudgetMinutes: 120 },
      ],
      "normal",
    );
    expect(day.map((b) => b.id)).toEqual(["arrival", "evening"]);
    expect(day[0].budgetMinutes).toBe(60);
  });

  it("never produces a negative budget", () => {
    const day = shapeDay(
      [{ id: "x", label: "X", kind: "spots", baseBudgetMinutes: 0 }],
      "relaxed",
      { withChildren: true, limitedMobility: true },
    );
    expect(day[0].budgetMinutes).toBe(0);
  });
});

describe("groupPaceFactor", () => {
  it("is one for a group with nothing to slow it down", () => {
    expect(groupPaceFactor(undefined)).toBe(1);
    expect(groupPaceFactor({})).toBe(1);
  });

  it("slows a walk down for a small child, and for somebody who needs the time", () => {
    // Three kilometres an hour rather than four, which is what a group
    // walking with a five-year-old covers (§4.7).
    expect(groupPaceFactor({ withChildren: true })).toBeCloseTo(1.4, 5);
    expect(groupPaceFactor({ limitedMobility: true })).toBeCloseTo(1.4, 5);
  });

  it("does not compound two reasons, unlike the budget factor", () => {
    // The pace is the slowest walker's, and they are one person. The
    // budget shrinks twice because that is about how much programme a
    // day carries; walking speed is not.
    expect(groupPaceFactor({ withChildren: true, limitedMobility: true }))
      .toBe(groupPaceFactor({ withChildren: true }));
    expect(groupFactor({ withChildren: true, limitedMobility: true }))
      .toBeLessThan(groupFactor({ withChildren: true }));
  });

  it("is not changed by wheels, which rule a route out rather than slow it", () => {
    expect(groupPaceFactor({ onWheels: true })).toBe(1);
    expect(groupFactor({ onWheels: true })).toBe(1);
  });
});
