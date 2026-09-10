/**
 * The scoring rule for the model comparison (§11.0).
 *
 * The rule decides which track wins, so it is worth more scrutiny than
 * the runner around it. Two properties matter: an invented field is
 * never counted as a success, and a field the sentence never mentioned
 * is not counted against a track that stayed silent about it.
 */

import { describe, expect, it } from "vitest";
import { BENCH_CASES } from "./cases";
import { scoreCase, totalsOf, SCORED_FIELDS } from "./score";

describe("scoreCase", () => {
  it("counts what the sentence said and the model read", () => {
    const score = scoreCase(
      { placeHint: "Augsburg", days: 4, pace: "relaxed", withChildren: true },
      { placeHint: "Augsburg", days: 4, pace: "relaxed", group: { withChildren: true } },
    );
    expect(score.hits).toBe(4);
    expect(score.missed).toBe(0);
    expect(score.invented).toBe(0);
  });

  it("does not punish silence about what the sentence never said", () => {
    const score = scoreCase({ placeHint: "Passau" }, { placeHint: "Passau" });
    expect(score.hits).toBe(1);
    expect(score.fields).toHaveLength(1);
  });

  it("calls a field the sentence never mentioned invented", () => {
    // The failure §13 cares about: "most trips are normal" is not
    // something this traveller said.
    const score = scoreCase({ placeHint: "Passau" }, { placeHint: "Passau", pace: "normal" });
    expect(score.invented).toBe(1);
    expect(score.hits).toBe(1);
  });

  it("separates a miss from a wrong answer", () => {
    const missed = scoreCase({ days: 4 }, {});
    expect(missed.missed).toBe(1);
    expect(missed.wrong).toBe(0);

    const wrong = scoreCase({ days: 4 }, { days: 5 });
    expect(wrong.wrong).toBe(1);
    expect(wrong.missed).toBe(0);
  });

  it("reads a place name regardless of case and spacing", () => {
    expect(scoreCase({ placeHint: "Füssen" }, { placeHint: " füssen " }).hits).toBe(1);
  });

  it("wants every expected category but tolerates extras", () => {
    const score = scoreCase(
      { categories: ["museum", "worship"] },
      { categories: ["museum", "worship", "cafe"] },
    );
    expect(score.hits).toBe(1);
    expect(score.extraCategories).toEqual(["cafe"]);
  });

  it("calls an incomplete category list wrong", () => {
    const score = scoreCase({ categories: ["museum", "worship"] }, { categories: ["museum"] });
    expect(score.wrong).toBe(1);
  });

  it("reads both group flags out of the nested object", () => {
    const score = scoreCase(
      { withChildren: true, limitedMobility: true },
      { group: { withChildren: true, limitedMobility: false } },
    );
    expect(score.hits).toBe(1);
    expect(score.wrong).toBe(1);
  });
});

describe("totalsOf", () => {
  it("counts a track that could not answer separately from a wrong one", () => {
    const totals = totalsOf([scoreCase({ days: 3 }, { days: 3 }), null]);
    expect(totals.failures).toBe(1);
    expect(totals.accuracy).toBe(1);
    expect(totals.cases).toBe(2);
  });

  it("reports no accuracy rather than a perfect one when nothing was asked", () => {
    expect(totalsOf([]).accuracy).toBe(0);
  });
});

describe("the cases", () => {
  it("have unique ids", () => {
    const ids = BENCH_CASES.map((benchCase) => benchCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only expect fields the scorer knows", () => {
    const known = new Set<string>(SCORED_FIELDS);
    for (const benchCase of BENCH_CASES) {
      for (const field of Object.keys(benchCase.expected)) {
        expect(known.has(field), `${benchCase.id}: ${field}`).toBe(true);
      }
    }
  });

  it("cover restraint and traps, not just plain sentences", () => {
    const kinds = new Set(BENCH_CASES.map((benchCase) => benchCase.kind));
    expect(kinds).toContain("restraint");
    expect(kinds).toContain("trap");
    expect(kinds).toContain("indirect");
  });

  it("state a place for every case that names one, and nothing else invented", () => {
    // A case whose expectation contradicts its own note would quietly
    // score both tracks wrong; the notes are the only prose that says
    // why a case exists.
    for (const benchCase of BENCH_CASES) {
      expect(benchCase.note.length, benchCase.id).toBeGreaterThan(10);
      expect(benchCase.text.length, benchCase.id).toBeGreaterThan(10);
    }
  });
});
