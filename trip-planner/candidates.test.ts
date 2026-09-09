import { describe, expect, it } from "vitest";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import {
  DEFAULT_DWELL_MINUTES,
  scoreForLight,
  toCandidates,
  type ScoredCandidate,
} from "./candidates";

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
  /** A candidate somebody marked as a photo stop (§7.3). */
  function photoStop(over: Partial<GeoPoiSearchSpot> = {}) {
    const [candidate] = toCandidates([spot(over)]);
    return { ...candidate, photoStop: true };
  }

  it("adds a transparent bonus at a photo stop with a golden-light window", () => {
    const candidate = photoStop({ facadeAzimuth: 180 });
    const [scored] = scoreForLight([candidate], { date: "2026-06-21", utcOffsetMinutes: 120 });
    expect(scored.score).toBeGreaterThan(candidate.score);
    // The reason names the mark and what it bought, because "gutes
    // Licht" for everything is the same as nothing (§8.3).
    expect(scored.reasons.some((r) => r.startsWith("Fotostopp:"))).toBe(true);
  });

  it("leaves an unmarked spot exactly where it was", () => {
    // The route is planned by distance; the light is the exception,
    // and an exception that applies to everything is not one.
    const [candidate] = toCandidates([spot({ facadeAzimuth: 180 })]);
    const [scored] = scoreForLight([candidate], { date: "2026-06-21", utcOffsetMinutes: 120 });
    expect(scored.score).toBe(candidate.score);
    expect(scored.reasons).toEqual(candidate.reasons);
  });

  it("says nothing about the light of a photo stop whose orientation is unknown", () => {
    // Most POIs are nodes and have no facade at all. Marking one still
    // buys nothing: there is no way to say how the sun meets it, and a
    // bonus would be a guess wearing a sentence.
    const candidate = photoStop({ facadeAzimuth: null });
    const [scored] = scoreForLight([candidate], { date: "2026-06-21", utcOffsetMinutes: 120 });
    expect(scored.score).toBe(candidate.score);
    expect(scored.reasons).toEqual(candidate.reasons);
  });

  it("leaves a spot the sun grazes below one it lights square on", () => {
    const south = photoStop({ osmRef: "way:2", facadeAzimuth: 180 });
    const west = photoStop({ osmRef: "way:3", facadeAzimuth: 285 });
    const scored = scoreForLight([south, west], { date: "2026-06-21", utcOffsetMinutes: 120 });
    const bonus = (before: ScoredCandidate, after: ScoredCandidate) => after.score - before.score;
    expect(bonus(west, scored[1])).toBeGreaterThan(bonus(south, scored[0]));
  });

  it("rewards prominence and explains why", () => {
    const [plain] = toCandidates([spot()]);
    const [known] = toCandidates([spot({ wikidataQid: "Q1", wikipedia: "de:X" })]);

    expect(known.score).toBeGreaterThan(plain.score);
    expect(known.reasons).toContain("in Wikidata verzeichnet");
    expect(known.reasons).toContain("hat einen Wikipedia-Artikel");
  });

  it("raises the score for a stated interest, and names it", () => {
    // "passt zu euren Interessen" was true of nothing in particular;
    // which interest it answers is the part that makes the suggestion
    // arguable (§8.3).
    const [without] = toCandidates([spot()]);
    const [with_] = toCandidates([spot()], { interests: ["museum"] });
    expect(with_.score).toBeGreaterThan(without.score);
    expect(with_.reasons.some((r) => r.startsWith("ihr wolltet:"))).toBe(true);
    expect(with_.reasons.some((r) => r.includes("Museen"))).toBe(true);
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

  it("names a place so the traveller can read it", () => {
    // OpenStreetMap's `name` is the *local* name, and until now the
    // fallback only fired when it was missing — so in Tokyo every row
    // of the plan was in a script the reader does not know. The rule is
    // about script rather than country: a European name stays exactly
    // as it is (§10.4).
    const [tokyo, munich] = toCandidates([
      plain({
        osmRef: "node:1",
        name: "東京国立博物館",
        nameDe: "Tokioter Nationalmuseum",
        nameEn: "Tokyo National Museum",
      }),
      plain({ osmRef: "node:2", name: "Marienplatz", nameEn: "St Mary's Square" }),
    ]);

    expect(tokyo.name).toBe("Tokioter Nationalmuseum");
    expect(munich.name).toBe("Marienplatz");
  });

  it("keeps an unreadable name rather than inventing a readable one", () => {
    const [candidate] = toCandidates([
      plain({ osmRef: "node:1", name: "วัดโพธิ์", nameDe: null, nameEn: null }),
    ]);
    expect(candidate.name).toBe("วัดโพธิ์");
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
