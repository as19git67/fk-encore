/**
 * Separating for an afternoon (§6.5).
 *
 * Two pieces of arithmetic, and both have a wrong answer that looks
 * plausible: a branch's budget is not a *share* of the block (it is the
 * time to the meeting point, so two branches get different ones), and a
 * split is only worth proposing when nobody wants both spots — where
 * the wishes overlap, the ordinary ranking already has an answer.
 */

import { describe, expect, it } from "vitest";
import { branchBudget, isViableBranch, suggestSplit, MIN_BRANCH_MINUTES } from "./split";

const anna = { voter: "user:1", voterName: "Anna" };
const papa = { voter: "user:2", voterName: "Papa" };
const kind = { voter: "traveller:9", voterName: "Kind A" };

const candidates = [
  { osmRef: "node:museum", name: "Technikmuseum" },
  { osmRef: "node:markt", name: "Markt" },
  { osmRef: "node:turm", name: "Turm" },
];

describe("what a branch has to spend", () => {
  it("counts backwards from the meeting, keeping a margin", () => {
    // 09:00 to 13:00 is four hours; the margin is never zero, because
    // being late for the group costs more than a skipped spot (§4.4).
    const budget = branchBudget({ startMinutes: 9 * 60, meetingMinutes: 13 * 60 });

    expect(budget).toBeLessThan(4 * 60);
    expect(budget).toBeGreaterThan(3 * 60);
  });

  it("is not a share of the block: a longer way back leaves less", () => {
    const near = branchBudget({
      startMinutes: 9 * 60, meetingMinutes: 13 * 60, travelMinutes: 5,
    });
    const far = branchBudget({
      startMinutes: 9 * 60, meetingMinutes: 13 * 60, travelMinutes: 45,
    });

    expect(far).toBe(near - 40);
  });

  it("never goes below zero, however late the group separates", () => {
    expect(branchBudget({ startMinutes: 13 * 60, meetingMinutes: 13 * 60 + 5 })).toBe(0);
  });

  it("refuses to call a quarter of an hour a branch", () => {
    expect(isViableBranch(MIN_BRANCH_MINUTES)).toBe(true);
    expect(isViableBranch(15)).toBe(false);
  });
});

describe("do the votes pull the group apart", () => {
  it("finds the two spots nobody wants both of", () => {
    const suggestion = suggestSplit([
      { ...anna, osmRef: "node:museum", value: "want" },
      { ...papa, osmRef: "node:markt", value: "want" },
      { ...kind, osmRef: "node:markt", value: "want" },
    ], candidates, "Markt");

    expect(suggestion).not.toBeNull();
    const refs = [suggestion!.a.osmRef, suggestion!.b.osmRef].sort();
    expect(refs).toEqual(["node:markt", "node:museum"]);
    expect(suggestion!.sentence).toContain("Technikmuseum");
    expect(suggestion!.sentence).toContain("Anna");
  });

  it("says nothing when the group agrees", () => {
    // Most of the time. Saying nothing then is the difference between
    // a suggestion and a nag.
    expect(suggestSplit([
      { ...anna, osmRef: "node:museum", value: "want" },
      { ...papa, osmRef: "node:museum", value: "want" },
    ], candidates)).toBeNull();
  });

  it("says nothing when somebody wants both", () => {
    // Overlapping wishes are a ranking problem, not a split: whoever
    // wants both has to give one up either way.
    expect(suggestSplit([
      { ...anna, osmRef: "node:museum", value: "want" },
      { ...anna, osmRef: "node:markt", value: "want" },
      { ...papa, osmRef: "node:markt", value: "want" },
    ], candidates)).toBeNull();
  });

  it("takes the pair that divides the most people", () => {
    const suggestion = suggestSplit([
      { ...anna, osmRef: "node:museum", value: "want" },
      { ...papa, osmRef: "node:markt", value: "want" },
      { ...kind, osmRef: "node:markt", value: "want" },
      { voter: "user:4", voterName: "Oma", osmRef: "node:turm", value: "want" },
    ], candidates);

    const refs = [suggestion!.a.osmRef, suggestion!.b.osmRef].sort();
    expect(refs).toEqual(["node:markt", "node:museum"]);
  });

  it("counts a heart wish as wanting it", () => {
    const suggestion = suggestSplit([
      { ...anna, osmRef: "node:museum", value: "meh", heart: true },
      { ...papa, osmRef: "node:markt", value: "want" },
    ], candidates);

    expect(suggestion).not.toBeNull();
  });

  it("ignores a shrug", () => {
    expect(suggestSplit([
      { ...anna, osmRef: "node:museum", value: "meh" },
      { ...papa, osmRef: "node:markt", value: "meh" },
    ], candidates)).toBeNull();
  });

  it("names the meeting place when the trip has one", () => {
    const suggestion = suggestSplit([
      { ...anna, osmRef: "node:museum", value: "want" },
      { ...papa, osmRef: "node:markt", value: "want" },
    ], candidates, "Hotel Beispiel");

    expect(suggestion!.sentence).toContain("am Hotel Beispiel");
  });
});
