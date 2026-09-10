/**
 * The scoring rule for the curation comparison (§11.3).
 *
 * Curation has no single right answer, so the rule counts only faults
 * that hold under any taste. These cases pin down what it does and does
 * not condemn — above all that a fault is never cancelled out by
 * finding one more landmark.
 */

import { describe, expect, it } from "vitest";
import { CLUSTER_BUDGET, CURATION_POOL } from "./curation-cases";
import { faultsOf, scoreCuration } from "./curation-score";

const byName = (name: string) =>
  CURATION_POOL.find((entry) => entry.spot.name === name)!.spot.osmRef;

const landmarks = CURATION_POOL
  .filter((entry) => entry.label.landmark)
  .map((entry) => ({ osmRef: entry.spot.osmRef }));

describe("scoreCuration", () => {
  it("counts a ref that was not in the pool as invented", () => {
    const score = scoreCuration(CURATION_POOL, [{ osmRef: "way:999999" }]);
    expect(score.invented).toEqual(["way:999999"]);
    expect(faultsOf(score)).toBe(1);
  });

  it("names the everyday entries that were picked", () => {
    const score = scoreCuration(CURATION_POOL, [
      { osmRef: byName("Sparkasse am Marktplatz") },
      { osmRef: byName("Stadtmuseum im Kornhaus") },
    ]);
    expect(score.everyday).toEqual(["Sparkasse am Marktplatz"]);
    expect(faultsOf(score)).toBe(1);
  });

  it("allows the cluster budget and counts only what goes beyond it", () => {
    const churches = CURATION_POOL
      .filter((entry) => entry.label.cluster === "dorfkirchen")
      .map((entry) => ({ osmRef: entry.spot.osmRef }));

    const within = scoreCuration(CURATION_POOL, churches.slice(0, CLUSTER_BUDGET));
    expect(within.monotony).toEqual([]);
    expect(faultsOf(within)).toBe(0);

    const all = scoreCuration(CURATION_POOL, churches);
    expect(all.monotony).toEqual([
      { cluster: "dorfkirchen", taken: 6, budget: CLUSTER_BUDGET },
    ]);
    expect(faultsOf(all)).toBe(6 - CLUSTER_BUDGET);
  });

  it("does not let a landmark buy off a fault", () => {
    // The point of keeping coverage out of the fault count: a selection
    // that finds every landmark and also picks a bank has still picked
    // a bank.
    const score = scoreCuration(CURATION_POOL, [
      ...landmarks,
      { osmRef: byName("Supermarkt Talstraße") },
    ]);
    expect(score.landmarksFound).toBe(score.landmarksTotal);
    expect(faultsOf(score)).toBe(1);
  });

  it("counts a ref named twice once", () => {
    const ref = byName("Burgruine Hohenwald");
    const score = scoreCuration(CURATION_POOL, [{ osmRef: ref }, { osmRef: ref }]);
    expect(score.picked).toBe(1);
  });

  it("reports the spread and who gave reasons", () => {
    const score = scoreCuration(CURATION_POOL, [
      { osmRef: byName("Stadtmuseum im Kornhaus"), why: "Regenrückfall" },
      { osmRef: byName("Botanischer Garten am Mühlbach") },
    ]);
    expect(score.categories).toEqual(["museum", "outdoors"]);
    expect(score.withReason).toBe(1);
  });

  it("flags what the request said is wrong for the group", () => {
    const score = scoreCuration(CURATION_POOL, [
      { osmRef: byName("Weinberg Sankt Ulrich") },
    ]);
    expect(score.poorForChildren).toEqual(["Weinberg Sankt Ulrich"]);
  });
});

describe("the curation pool", () => {
  it("has enough of everything to make the measurement possible", () => {
    expect(CURATION_POOL.length).toBeGreaterThanOrEqual(30);
    expect(CURATION_POOL.filter((e) => e.label.landmark).length).toBeGreaterThanOrEqual(6);
    expect(CURATION_POOL.filter((e) => e.label.everyday).length).toBeGreaterThanOrEqual(4);
    expect(CURATION_POOL.filter((e) => e.label.cluster).length).toBeGreaterThan(CLUSTER_BUDGET);
  });

  it("has unique references", () => {
    const refs = CURATION_POOL.map((entry) => entry.spot.osmRef);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("puts an article on two everyday entries, which is the whole trap", () => {
    // If none of them carried one, `requireProminence` would remove
    // every everyday entry before the ranking and the comparison would
    // be measuring a filter rather than a judgement.
    const withArticle = CURATION_POOL
      .filter((entry) => entry.label.everyday && entry.spot.wikipedia !== null);
    expect(withArticle.length).toBeGreaterThanOrEqual(2);
  });
});
