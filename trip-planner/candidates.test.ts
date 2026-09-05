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
