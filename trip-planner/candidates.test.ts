import { describe, expect, it } from "vitest";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { DEFAULT_DWELL_MINUTES, toCandidates } from "./candidates";

function spot(overrides: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: "node:1",
    type: "node",
    id: 1,
    lat: 48.37,
    lon: 10.9,
    distanceM: 100,
    detourM: null,
    name: "Beispielmuseum",
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
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
    ...overrides,
  };
}

describe("toCandidates", () => {
  it("rewards prominence and explains why", () => {
    const [plain] = toCandidates([spot()]);
    const [known] = toCandidates([spot({ wikidataQid: "Q1", wikipedia: "de:X" })]);

    expect(known.score).toBeGreaterThan(plain.score);
    expect(known.reasons).toContain("in Wikidata verzeichnet");
    expect(known.reasons).toContain("hat einen Wikipedia-Artikel");
  });

  it("raises the score for a stated interest", () => {
    const [without] = toCandidates([spot()]);
    const [with_] = toCandidates([spot()], { interests: ["museum"] });
    expect(with_.score).toBeGreaterThan(without.score);
    expect(with_.reasons).toContain("passt zu euren Interessen");
  });

  it("uses the category's dwell default", () => {
    const [museum] = toCandidates([spot()]);
    const [view] = toCandidates([
      spot({ osmRef: "node:2", categories: ["viewpoint"], kind: "tourism=viewpoint" }),
    ]);
    expect(museum.dwellMinutes).toBe(DEFAULT_DWELL_MINUTES.museum);
    expect(view.dwellMinutes).toBe(DEFAULT_DWELL_MINUTES.viewpoint);
  });

  it("honours a dwell override", () => {
    const [c] = toCandidates([spot()], { dwellMinutes: { museum: 40 } });
    expect(c.dwellMinutes).toBe(40);
  });

  it("ignores a nonsensical dwell override rather than planning a zero-minute visit", () => {
    const [c] = toCandidates([spot()], { dwellMinutes: { museum: 0 } });
    expect(c.dwellMinutes).toBe(DEFAULT_DWELL_MINUTES.museum);
  });

  it("falls back to a dwell time for an unknown category", () => {
    const [c] = toCandidates([spot({ categories: ["something_new"] })]);
    expect(c.dwellMinutes).toBeGreaterThan(0);
  });

  it("skips a spot with no category instead of inventing one", () => {
    expect(toCandidates([spot({ categories: [] })])).toEqual([]);
  });

  it("notes an unnamed spot and falls back through the name variants", () => {
    const [unnamed] = toCandidates([spot({ name: null })]);
    expect(unnamed.reasons).toContain("unbenannt in OpenStreetMap");
    expect(unnamed.name).toBeNull();

    const [english] = toCandidates([spot({ name: null, nameEn: "Example Museum" })]);
    expect(english.name).toBe("Example Museum");
  });
});

describe("what may fill a day (§10.5)", () => {
  /**
   * The complaint that produced these: pharmacies, discounters, savings
   * banks and unremarkable churches turning up in a suggested plan. All
   * of them scored exactly what an ordinary parish church scored,
   * because having a name counted as a mark of significance — and every
   * savings bank has a name.
   */
  function plain(over: Partial<GeoPoiSearchSpot> & { osmRef: string }): GeoPoiSearchSpot {
    return {
      type: "node",
      id: 1,
      lat: 48.37,
      lon: 10.9,
      distanceM: 100,
      detourM: null,
      name: "Irgendwas",
      nameDe: null,
      nameEn: null,
      kind: "amenity=place_of_worship",
      categories: ["worship"],
      wikidataQid: null,
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

  it("keeps out of a plan what nothing says is worth seeing", () => {
    const spots = [
      plain({ osmRef: "node:1", name: "Sparkasse Beispielstadt",
              kind: "amenity=bank", categories: ["essentials"] }),
      plain({ osmRef: "node:2", name: "Dorfkirche Musterhausen" }),
      plain({ osmRef: "node:3", name: "Stadtmuseum Beispielstadt",
              kind: "tourism=museum", categories: ["museum"], wikidataQid: "Q1" }),
    ];
    const planning = toCandidates(spots, { requireProminence: true });
    expect(planning.map((c) => c.osmRef)).toEqual(["node:3"]);
  });

  it("still answers with the ordinary when nobody is planning a day", () => {
    // "Was ist hier in der Nähe" legitimately wants the pharmacy — §10.5
    // calls this the case open data is *best* at.
    const spots = [plain({ osmRef: "node:1", name: "Apotheke am Platz",
                           kind: "amenity=pharmacy", categories: ["essentials"] })];
    expect(toCandidates(spots)).toHaveLength(1);
  });

  it("a name is not a mark of significance", () => {
    const named = plain({ osmRef: "node:1", name: "Sparkasse Beispielstadt" });
    const unnamed = plain({ osmRef: "node:2", name: null });
    const [a, b] = toCandidates([named, unnamed]);
    expect(a.score).toBe(b.score);
  });

  it("takes a mapper's own judgement as a signal", () => {
    // Someone standing there tagged it as a thing to see. That is worth
    // more than a name and less than a Wikipedia article.
    const attraction = plain({ osmRef: "node:1", kind: "tourism=attraction",
                               categories: ["sight"] });
    const [candidate] = toCandidates([attraction], { requireProminence: true });
    expect(candidate).toBeDefined();
    expect(candidate.reasons).toContain("als Sehenswürdigkeit erfasst");
  });
});
