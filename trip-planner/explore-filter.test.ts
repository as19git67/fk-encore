/**
 * Browsing decisions, away from the database (§9.2, case 4 widened).
 *
 * The two that would go quietly wrong: an interest that matches by tag
 * rather than by category, and an empty list that does not say which
 * kind of empty it is.
 */

import { describe, expect, it } from "vitest";
import { emptinessNote, keepsInterest, orderForBrowsing } from "./explore-filter";

function spot(over: Partial<{
  osmRef: string; name: string | null; kind: string | null;
  category: string; score: number; distanceM: number;
}> = {}) {
  return {
    osmRef: "node:1",
    name: "Etwas",
    kind: null as string | null,
    category: "sight",
    score: 1,
    distanceM: 100,
    ...over,
  };
}

describe("what the chosen interests keep", () => {
  it("keeps everything when nothing was chosen", () => {
    expect(keepsInterest({ kind: "amenity=bank", category: "essentials" }, [])).toBe(true);
  });

  it("keeps a castle that carries no category of its own", () => {
    // The reason interests are matched here and not pushed into the
    // region query: "Burgen und Schlösser" is a set of tags, and
    // narrowing the search by its (empty) category list would ask for
    // nothing at all.
    expect(keepsInterest({ kind: "historic=castle", category: "sight" }, ["castles"])).toBe(true);
  });

  it("keeps a museum matched by its category", () => {
    expect(keepsInterest({ kind: null, category: "museum" }, ["museum"])).toBe(true);
  });

  it("drops what answers none of them", () => {
    expect(keepsInterest({ kind: "amenity=pharmacy", category: "essentials" }, ["museum"]))
      .toBe(false);
  });
});

describe("the order a browse comes back in", () => {
  it("puts the known thing ahead of the near thing", () => {
    // The whole difference from `nearby.ts`: standing anywhere in town,
    // the cathedral is the answer even when a chapel is closer.
    const ordered = orderForBrowsing([
      spot({ osmRef: "node:chapel", score: 1, distanceM: 50 }),
      spot({ osmRef: "node:cathedral", score: 4, distanceM: 900 }),
    ]);
    expect(ordered.map((s) => s.osmRef)).toEqual(["node:cathedral", "node:chapel"]);
  });

  it("breaks a tie by distance", () => {
    const ordered = orderForBrowsing([
      spot({ osmRef: "node:far", score: 2, distanceM: 800 }),
      spot({ osmRef: "node:near", score: 2, distanceM: 200 }),
    ]);
    expect(ordered.map((s) => s.osmRef)).toEqual(["node:near", "node:far"]);
  });

  it("gives the same list twice for the same input", () => {
    // A browse that reshuffles on refresh looks broken even when both
    // orders are defensible.
    const spots = [
      spot({ osmRef: "node:b", score: 2, distanceM: 300 }),
      spot({ osmRef: "node:a", score: 2, distanceM: 300 }),
    ];
    expect(orderForBrowsing(spots).map((s) => s.osmRef))
      .toEqual(orderForBrowsing([...spots].reverse()).map((s) => s.osmRef));
  });

  it("leaves the caller's array alone", () => {
    const spots = [spot({ osmRef: "node:b", score: 1 }), spot({ osmRef: "node:a", score: 5 })];
    orderForBrowsing(spots);
    expect(spots[0].osmRef).toBe("node:b");
  });
});

describe("which kind of empty", () => {
  it("blames the missing region before anything else", () => {
    const note = emptinessNote({ regionMissing: true, found: 0, kept: 0, filtered: true });
    expect(note).toContain("noch nicht importiert");
  });

  it("says the filter was too narrow when there was something to filter", () => {
    const note = emptinessNote({ regionMissing: false, found: 40, kept: 0, filtered: true });
    expect(note).toContain("passt zur Auswahl");
  });

  it("says the area is empty when nothing was filtered away", () => {
    const note = emptinessNote({ regionMissing: false, found: 0, kept: 0, filtered: false });
    expect(note).toContain("kennt OpenStreetMap nichts");
  });

  it("says nothing when there is something to look at", () => {
    expect(emptinessNote({ regionMissing: false, found: 40, kept: 12, filtered: true })).toBeNull();
  });
});
