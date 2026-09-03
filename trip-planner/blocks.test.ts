import { describe, expect, it } from "vitest";
import { DEFAULT_DAY, groupFactor, shapeDay } from "./blocks";

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
