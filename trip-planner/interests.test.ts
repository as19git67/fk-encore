/**
 * What the travellers are here for (§4).
 *
 * The setting existed for months and matched nothing: the scoring
 * compared a *theme* against one of nine category ids. These cases are
 * about the vocabulary that replaces that comparison — and about the
 * two kinds of stored value that must keep working.
 */

import { describe, expect, it } from "vitest";
import { INTERESTS, interestLabel, matchedInterests, matchesInterest } from "./interests";
import { toCandidates } from "./candidates";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";

function spot(over: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: "way:1",
    type: "way",
    id: 1,
    lat: 48.14,
    lon: 11.58,
    distanceM: 100,
    detourM: null,
    name: "Ort",
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: "Q1",
    wikipedia: null,
    openingHours: null,
    cuisine: null,
    wheelchair: null,
    outdoorSeating: null,
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    facadeAzimuth: null,
    ...over,
  };
}

describe("the interest vocabulary", () => {
  it("matches on the OSM tag, which is what a theme actually is", () => {
    // A castle is `historic=castle` and its category is "sight", the
    // same category a market square has. Matching on the category is
    // what made "Burgen" mean nothing.
    const castle = { kind: "historic=castle", category: "sight" };
    expect(matchesInterest(castle, ["castles"])).toBe(true);
    expect(matchesInterest(castle, ["churches"])).toBe(false);
  });

  it("still accepts a category id, because that is what old trips stored", () => {
    expect(matchesInterest({ kind: "tourism=museum", category: "museum" }, ["museum"]))
      .toBe(true);
    // And a category id that is not an interest of its own.
    expect(matchesInterest({ kind: "amenity=cafe", category: "cafe" }, ["cafe"])).toBe(true);
  });

  it("answers no to free text rather than throwing", () => {
    // "barock" is what the interpreter extracts today. OSM cannot tell
    // a baroque church from any other, so this has to be a plain no —
    // and a planning run is the wrong place to discover a typo from
    // months ago.
    expect(matchesInterest({ kind: "building=church", category: "worship" }, ["barock"]))
      .toBe(false);
  });

  it("names which interest a spot answers", () => {
    expect(matchedInterests({ kind: "tourism=viewpoint", category: "viewpoint" },
                            ["views", "museum"]))
      .toEqual(["Aussicht"]);
  });

  it("has an id and a label for every entry, and no duplicates", () => {
    const ids = INTERESTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const interest of INTERESTS) {
      expect(interest.label.length).toBeGreaterThan(0);
      expect(interest.kinds.length + interest.categories.length).toBeGreaterThan(0);
      expect(interestLabel(interest.id)).toBe(interest.label);
    }
  });
});

describe("scoring with interests", () => {
  it("rewards a spot that answers one, and says which", () => {
    const [plain] = toCandidates([spot({ osmRef: "way:2", kind: "historic=castle",
                                         categories: ["sight"] })]);
    const [wanted] = toCandidates(
      [spot({ osmRef: "way:2", kind: "historic=castle", categories: ["sight"] })],
      { interests: ["castles"] });

    expect(wanted.score).toBeGreaterThan(plain.score);
    expect(wanted.reasons.some((r) => r.includes("Burgen und Schlösser"))).toBe(true);
  });

  it("leaves a spot nobody asked for exactly where it was", () => {
    const [plain] = toCandidates([spot({ kind: "leisure=park", categories: ["outdoors"] })]);
    const [scored] = toCandidates([spot({ kind: "leisure=park", categories: ["outdoors"] })],
                                  { interests: ["castles"] });
    expect(scored.score).toBe(plain.score);
  });
});
