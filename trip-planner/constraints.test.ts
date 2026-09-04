/**
 * What the model says is a proposal, not an instruction.
 *
 * These tests are the adversarial half of step 5: they feed
 * `normalizeConstraints` the things a language model actually does
 * wrong — inventing a category, returning a string where a number
 * belongs, planning three months, answering with prose — and check that
 * each one is either clamped to something usable or dropped and
 * reported, never passed on.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_DAYS,
  MAX_INTERESTS,
  MAX_RADIUS_M,
  MAX_WALK_MINUTES_LIMIT,
  normalizeConstraints,
} from "./constraints";

/** The real vocabulary, as geo/src/poi-categories.ts defines it. */
const CATEGORIES = [
  "sight",
  "museum",
  "viewpoint",
  "worship",
  "theatre",
  "food",
  "cafe",
  "essentials",
  "outdoors",
];

function norm(raw: unknown) {
  return normalizeConstraints(raw, CATEGORIES);
}

describe("normalizeConstraints", () => {
  it("keeps a well-formed answer intact", () => {
    const { constraints, rejected } = norm({
      title: "Vier Tage Augsburg",
      placeHint: "Augsburg",
      days: 4,
      radiusM: 2500,
      pace: "relaxed",
      maxWalkMinutes: 25,
      categories: ["sight", "food"],
      interests: ["barock", "wasserbau"],
      group: { withChildren: true },
    });

    expect(rejected).toEqual([]);
    expect(constraints).toEqual({
      title: "Vier Tage Augsburg",
      placeHint: "Augsburg",
      days: 4,
      radiusM: 2500,
      pace: "relaxed",
      maxWalkMinutes: 25,
      categories: ["sight", "food"],
      interests: ["barock", "wasserbau"],
      group: { withChildren: true },
    });
  });

  it("drops a category the vocabulary does not have, and says so", () => {
    const { constraints, rejected } = norm({ categories: ["food", "nightclub"] });
    expect(constraints.categories).toEqual(["food"]);
    expect(rejected).toEqual(["category: 'nightclub' does not exist"]);
  });

  it("leaves categories unset when the model invented all of them", () => {
    // An empty array would read as "search nothing"; absent means "all
    // the import carries", which is the honest fallback.
    const { constraints, rejected } = norm({ categories: ["nightclub", "spa"] });
    expect(constraints.categories).toBeUndefined();
    expect(rejected).toHaveLength(2);
  });

  it("clamps a day count beyond the limit instead of refusing the sentence", () => {
    const { constraints, rejected } = norm({ days: 90 });
    expect(constraints.days).toBe(MAX_DAYS);
    expect(rejected[0]).toContain("90");
  });

  it("clamps an oversized radius", () => {
    const { constraints, rejected } = norm({ radiusM: 400_000 });
    expect(constraints.radiusM).toBe(MAX_RADIUS_M);
    expect(rejected[0]).toContain("400000");
  });

  it("rejects a radius too small to hold a day", () => {
    const { constraints, rejected } = norm({ radiusM: 5 });
    expect(constraints.radiusM).toBeUndefined();
    expect(rejected[0]).toContain("too small");
  });

  it("clamps an absurd walking limit", () => {
    const { constraints } = norm({ maxWalkMinutes: 600 });
    expect(constraints.maxWalkMinutes).toBe(MAX_WALK_MINUTES_LIMIT);
  });

  it("rejects a pace that is not one of the three", () => {
    const { constraints, rejected } = norm({ pace: "hektisch" });
    expect(constraints.pace).toBeUndefined();
    expect(rejected[0]).toContain("hektisch");
  });

  it("accepts a pace the model capitalised", () => {
    expect(norm({ pace: "Relaxed" }).constraints.pace).toBe("relaxed");
  });

  it("ignores numbers that arrived as strings", () => {
    // The prompt asks for numbers; a string is the model not following
    // it, and guessing at parsing would hide that.
    const { constraints } = norm({ days: "vier", radiusM: "2km" });
    expect(constraints.days).toBeUndefined();
    expect(constraints.radiusM).toBeUndefined();
  });

  it("survives prose instead of an object", () => {
    const { constraints, rejected } = norm("Klar, gerne! Hier ist dein Plan:");
    expect(constraints).toEqual({});
    expect(rejected).toEqual(["the model did not return an object"]);
  });

  it("survives null and arrays", () => {
    expect(norm(null).rejected).toHaveLength(1);
    expect(norm([1, 2, 3]).rejected).toHaveLength(1);
  });

  it("keeps only group flags that are actually true", () => {
    // `withChildren: false` shapes the day exactly like an absent field
    // (blocks.ts), so storing it would be noise.
    expect(norm({ group: { withChildren: false } }).constraints.group).toBeUndefined();
    expect(norm({ group: { limitedMobility: true } }).constraints.group).toEqual({
      limitedMobility: true,
    });
  });

  it("caps a padded interest list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `thema${i}`);
    const { constraints, rejected } = norm({ interests: many });
    expect(constraints.interests).toHaveLength(MAX_INTERESTS);
    expect(rejected[0]).toContain(`${MAX_INTERESTS}`);
  });

  it("removes duplicates the model repeated", () => {
    const { constraints } = norm({
      categories: ["food", "food", "cafe"],
      interests: ["barock", "Barock"],
    });
    expect(constraints.categories).toEqual(["food", "cafe"]);
    expect(constraints.interests).toEqual(["barock"]);
  });

  it("ignores blank strings", () => {
    const { constraints } = norm({ title: "   ", placeHint: "", interests: ["", " "] });
    expect(constraints.title).toBeUndefined();
    expect(constraints.placeHint).toBeUndefined();
    expect(constraints.interests).toBeUndefined();
  });

  it("accepts 'place' as well as 'placeHint'", () => {
    // Models drift between the two no matter how the prompt is worded.
    expect(norm({ place: "Augsburg" }).constraints.placeHint).toBe("Augsburg");
  });

  it("never returns coordinates, whatever the model offers", () => {
    const { constraints } = norm({
      placeHint: "Augsburg",
      lat: 48.37,
      lon: 10.9,
      anchor: { lat: 48.37, lon: 10.9 },
    });
    expect(constraints).toEqual({ placeHint: "Augsburg" });
  });
});
