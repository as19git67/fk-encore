/**
 * Aggregating what a family said (§6.1).
 *
 * The chapter's central claim is that the mean is the wrong
 * aggregation: it picks what everybody finds mediocre and deletes what
 * one person cares a great deal about. These cases are the two
 * correctives that follow from it — a heart wish that survives the
 * majority, and a tie-break that remembers who gave way — plus the one
 * thing a strong "no" must not become: a veto.
 */

import { describe, expect, it } from "vitest";
import {
  applyVotes,
  behindness,
  fairnessFrom,
  fairnessSentence,
  heartQuota,
  tally,
  FAIRNESS_NUDGE,
  HEART_WEIGHT,
} from "./votes";

const anna = { voter: "user:1", voterName: "Anna" };
const papa = { voter: "user:2", voterName: "Papa" };
const kind = { voter: "traveller:9", voterName: "Kind A" };

function candidate(osmRef: string, score: number) {
  return { osmRef, score, reasons: ["Sehenswürdigkeit"] };
}

describe("how many settings a leg gives each person", () => {
  it("is about two per three days", () => {
    expect(heartQuota(3)).toBe(2);
    expect(heartQuota(6)).toBe(4);
  });

  it("never leaves a short trip without one", () => {
    expect(heartQuota(1)).toBe(1);
    expect(heartQuota(2)).toBe(1);
  });

  it("gives none to a leg with no days", () => {
    expect(heartQuota(0)).toBe(0);
  });
});

describe("the tally is a sum, not an average", () => {
  it("lets two 'will ich' beat one", () => {
    const both = tally([
      { ...anna, osmRef: "node:1", value: "want" },
      { ...papa, osmRef: "node:1", value: "want" },
    ]);
    const one = tally([{ ...anna, osmRef: "node:2", value: "want" }]);

    expect(both.byRef.get("node:1")!.delta)
      .toBeGreaterThan(one.byRef.get("node:2")!.delta);
  });

  it("does not let 'egal' dilute a 'will ich'", () => {
    // The mean's failure in one case: with an average, three shrugs
    // would grind an enthusiasm down to nearly nothing.
    const alone = tally([{ ...anna, osmRef: "node:1", value: "want" }]);
    const diluted = tally([
      { ...anna, osmRef: "node:1", value: "want" },
      { ...papa, osmRef: "node:1", value: "meh" },
      { ...kind, osmRef: "node:1", value: "meh" },
    ]);

    expect(diluted.byRef.get("node:1")!.delta).toBe(alone.byRef.get("node:1")!.delta);
  });

  it("takes a 'lieber nicht' seriously", () => {
    const tallied = tally([{ ...anna, osmRef: "node:1", value: "rather-not" }]);

    expect(tallied.byRef.get("node:1")!.delta).toBeLessThan(0);
    expect(tallied.byRef.get("node:1")!.reasons).toContain("Anna: lieber nicht");
  });

  it("does not let it become a veto", () => {
    // §6.1: a strong minus, not an exclusion. Three who want it carry
    // it past one who does not.
    const tallied = tally([
      { ...anna, osmRef: "node:1", value: "rather-not" },
      { ...papa, osmRef: "node:1", value: "want" },
      { ...kind, osmRef: "node:1", value: "want" },
      { voter: "user:3", voterName: "Oma", osmRef: "node:1", value: "want" },
    ]);

    expect(tallied.byRef.get("node:1")!.delta).toBeGreaterThan(0);
  });
});

describe("a heart wish survives the majority", () => {
  it("outweighs any plausible sum of ordinary votes", () => {
    const hearted = tally([{ ...kind, osmRef: "node:1", value: "want", heart: true }]);
    const opposed = tally(Array.from({ length: 4 }, (_, i) => ({
      voter: `user:${i}`, voterName: `Person ${i}`, osmRef: "node:2", value: "rather-not" as const,
    })));

    expect(hearted.byRef.get("node:1")!.delta).toBe(HEART_WEIGHT);
    expect(hearted.byRef.get("node:1")!.hearted).toBe(true);
    expect(hearted.byRef.get("node:1")!.delta + opposed.byRef.get("node:2")!.delta)
      .toBeGreaterThan(0);
  });

  it("says whose it is", () => {
    const tallied = tally([{ ...kind, osmRef: "node:1", value: "want", heart: true }]);

    expect(tallied.byRef.get("node:1")!.reasons).toContain("Herzenswunsch von Kind A");
  });
});

describe("the fairness account", () => {
  it("counts wishes granted and wishes deferred", () => {
    const rows = fairnessFrom(
      [
        { ...anna, osmRef: "node:1", value: "want" },
        { ...anna, osmRef: "node:2", value: "want" },
        { ...papa, osmRef: "node:3", value: "want" },
      ],
      new Set(["node:1", "node:3"]),
      new Set(["node:2"]),
    );

    expect(rows.find((r) => r.voter === anna.voter)).toMatchObject({ granted: 1, deferred: 1 });
    expect(rows.find((r) => r.voter === papa.voter)).toMatchObject({ granted: 1, deferred: 0 });
  });

  it("ignores a wish that left the trip altogether", () => {
    // Hidden or dropped: nobody gave way in anybody's favour there.
    const rows = fairnessFrom(
      [{ ...anna, osmRef: "node:9", value: "want" }],
      new Set(),
      new Set(),
    );

    expect(rows[0]).toMatchObject({ granted: 0, deferred: 0 });
  });

  it("does not count a shrug as a wish", () => {
    expect(fairnessFrom([{ ...anna, osmRef: "node:1", value: "meh" }], new Set(), new Set()))
      .toEqual([]);
  });

  it("breaks a tie for whoever is furthest behind, and only for them", () => {
    const behind = [
      { voter: anna.voter, voterName: "Anna", granted: 0, deferred: 2 },
      { voter: papa.voter, voterName: "Papa", granted: 2, deferred: 0 },
    ];
    const tallied = tally([
      { ...anna, osmRef: "node:1", value: "want" },
      { ...papa, osmRef: "node:2", value: "want" },
    ], behind);

    expect(tallied.byRef.get("node:1")!.delta)
      .toBe(tallied.byRef.get("node:2")!.delta + FAIRNESS_NUDGE);
    expect(tallied.byRef.get("node:1")!.reasons).toContain("heute ist mal wieder Anna dran");
  });

  it("nudges nobody when nobody is behind", () => {
    const level = [
      { voter: anna.voter, voterName: "Anna", granted: 1, deferred: 1 },
      { voter: papa.voter, voterName: "Papa", granted: 1, deferred: 1 },
    ];
    const tallied = tally([{ ...anna, osmRef: "node:1", value: "want" }], level);

    expect(tallied.byRef.get("node:1")!.reasons).not.toContain("heute ist mal wieder Anna dran");
    expect(behindness(level[0])).toBe(0);
  });

  it("says the account out loud rather than as counters", () => {
    expect(fairnessSentence([
      { voter: anna.voter, voterName: "Anna", granted: 0, deferred: 2 },
    ])).toContain("Anna musste bisher am ehesten zurückstecken");
    expect(fairnessSentence([
      { voter: anna.voter, voterName: "Anna", granted: 1, deferred: 0 },
    ])).toBe("Bisher ist niemand zu kurz gekommen.");
    expect(fairnessSentence([])).toBeNull();
  });
});

describe("applying the tally to candidates", () => {
  it("adds to what the search found rather than replacing it", () => {
    const [rated] = applyVotes(
      [candidate("node:1", 3)],
      tally([{ ...anna, osmRef: "node:1", value: "want" }]),
    );

    expect(rated.score).toBe(5);
    expect(rated.reasons).toEqual(["Sehenswürdigkeit", "Anna: will ich"]);
  });

  it("leaves a spot nobody discussed exactly as it was", () => {
    // Silence is not rejection: otherwise the pool shrinks to whatever
    // came up on the sofa.
    const before = candidate("node:2", 3);
    const [after] = applyVotes([before], tally([{ ...anna, osmRef: "node:1", value: "want" }]));

    expect(after).toBe(before);
  });
});
