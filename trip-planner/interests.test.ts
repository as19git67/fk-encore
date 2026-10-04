/**
 * What the travellers are here for (§4).
 *
 * The setting existed for months and matched nothing: the scoring
 * compared a *theme* against one of nine category ids. These cases are
 * about the vocabulary that replaces that comparison — and about the
 * two kinds of stored value that must keep working.
 */

import { describe, expect, it } from "vitest";
import { INTERESTS, interestLabel, matchedInterests, matchesInterest, OTHER_INTEREST_ID, selectionOf, interestsForCategories } from "./interests";
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

  it("tells sculpture apart from war memorials", () => {
    // The split: whoever ticks "Kunst im Freien" rarely means a
    // memorial, and OSM distinguishes the two cleanly.
    const sculpture = { kind: "tourism=artwork", category: "sight" };
    const memorial = { kind: "historic=memorial", category: "sight" };

    expect(matchesInterest(sculpture, ["art"])).toBe(true);
    expect(matchesInterest(sculpture, ["monuments"])).toBe(false);
    expect(matchesInterest(memorial, ["monuments"])).toBe(true);
    expect(matchesInterest(memorial, ["art"])).toBe(false);
  });

  it("lets somebody ask for towers without asking for castles", () => {
    expect(matchesInterest({ kind: "man_made=tower", category: "sight" }, ["towers"]))
      .toBe(true);
    expect(matchesInterest({ kind: "man_made=lighthouse", category: "sight" }, ["towers"]))
      .toBe(true);
    expect(matchesInterest({ kind: "historic=castle", category: "sight" }, ["towers"]))
      .toBe(false);
  });

  it("covers what the widened import brought in", () => {
    const cases: [string, string, string][] = [
      ["natural=peak", "outdoors", "landscape"],
      ["natural=beach", "outdoors", "landscape"],
      ["leisure=nature_reserve", "outdoors", "landscape"],
      ["leisure=garden", "outdoors", "nature"],
      ["tourism=zoo", "zoo", "zoo"],
      ["amenity=marketplace", "market", "market"],
      ["leisure=water_park", "bath", "bath"],
      ["craft=winery", "producers", "producers"],
    ];
    for (const [kind, category, interest] of cases) {
      expect(matchesInterest({ kind, category }, [interest]), `${kind} → ${interest}`)
        .toBe(true);
    }
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

describe("the selection as a filter (2026-10-04)", () => {
  const castle = spot({ osmRef: "way:2", kind: "historic=castle", categories: ["sight"] });
  const park = spot({ osmRef: "way:3", kind: "leisure=park", categories: ["outdoors"] });
  const square = spot({ osmRef: "way:4", kind: "place=square", categories: ["sight"] });

  it("keeps a spot that answers a ticked line and names the line", () => {
    const [plain] = toCandidates([castle]);
    const [wanted] = toCandidates([castle], { interests: ["castles"] });
    expect(wanted.score).toBe(plain.score);
    expect(wanted.reasons.some((r) => r.includes("Burgen und Schlösser"))).toBe(true);
  });

  it("drops what nobody ticked", () => {
    expect(toCandidates([castle, park], { interests: ["castles"] }).map((c) => c.osmRef)).toEqual(["way:2"]);
  });

  it("searches everything with nothing ticked, and with every line ticked", () => {
    const all = [...INTERESTS.map((i) => i.id), OTHER_INTEREST_ID];
    expect(toCandidates([castle, park, square])).toHaveLength(3);
    expect(toCandidates([castle, park, square], { interests: all })).toHaveLength(3);
    expect(toCandidates([castle], { interests: all })[0].reasons.some((r) => r.startsWith("ihr wolltet")))
      .toBe(false);
    expect(selectionOf(all)).toBeNull();
    expect(selectionOf([])).toBeNull();
  });

  it("'Alles andere' stands for what no line names", () => {
    const kept = toCandidates([castle, park, square], { interests: [OTHER_INTEREST_ID] });
    expect(kept.map((c) => c.osmRef)).toEqual(["way:4"]);
    expect(kept[0].reasons).toContain("ihr wolltet: Alles andere");
    expect(toCandidates([castle, square], { interests: ["castles", OTHER_INTEREST_ID] })).toHaveLength(2);
  });

  it("ignores words the vocabulary does not know instead of matching nothing", () => {
    expect(toCandidates([castle, park], { interests: ["barock"] })).toHaveLength(2);
    expect(selectionOf(["barock", "castles"])).toEqual(new Set(["castles"]));
  });

  it("turns the interpreter's categories into lines on the screen", () => {
    expect(interestsForCategories(["worship", "museum"])).toEqual(["museum", "churches"]);
    expect(interestsForCategories(["food"])).toEqual([]);
  });
});
