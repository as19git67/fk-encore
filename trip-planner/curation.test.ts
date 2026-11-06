/**
 * The local model's order of a stay's pool, without the model (ranking
 * plan, stage 3): the prompt, the gate, and when to ask again. All
 * places are invented.
 */
import { describe, expect, it } from "vitest";
import { CURATED_FLOOR, CURATED_TOP, MANUAL_SCORE, curatedScore, toCandidates } from "./candidates";
import {
  buildCurationPrompt,
  curationDue,
  gateCuration,
  groupLine,
  namesUnknownFact,
  signatureOf,
  type CurationContext,
  type CurationEntry,
} from "./curation";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";

const context: CurationContext = {
  town: "Musterstadt",
  days: 2,
  interests: ["Burgen und Schlösser"],
  group: "2 Erwachsene, 1 Kind (7)",
};

const entries: CurationEntry[] = [
  { osmRef: "way:1", name: "Burg Beispielstein", category: "castle", reasons: ["12.000 Aufrufe im Monat"], text: "Burg aus dem 12. Jahrhundert über der Stadt." },
  { osmRef: "node:2", name: "Sparkasse am Markt", category: "sight", reasons: [], text: null },
  { osmRef: "node:3", name: "Aussichtsturm Musterberg", category: "viewpoint", reasons: ["in Wikivoyage genannt"], text: null, manual: true },
];

describe("the prompt", () => {
  it("names every place, the interests and the group, and no person", () => {
    const prompt = buildCurationPrompt(entries, context);
    expect(prompt).toContain("way:1 | Burg Beispielstein | kategorie=castle");
    expect(prompt).toContain("Interessen: Burgen und Schlösser.");
    expect(prompt).toContain("Reisegruppe: 2 Erwachsene, 1 Kind (7).");
    expect(prompt).toContain("von den Reisenden selbst hinzugefügt");
    expect(prompt).toContain("keine Öffnungszeiten, keine Preise");
  });
});

describe("the gate", () => {
  it("drops invented places and names a place once", () => {
    const gated = gateCuration({ order: [
      { ref: "way:1", why: "Eine Burg für Kinder." },
      { ref: "way:99", why: "Gibt es nicht." },
      { ref: "way:1", why: "Noch einmal." },
      { ref: "node:3", why: "Weiter Blick." },
    ] }, entries, context);
    expect(gated.picks.map((p) => p.osmRef)).toEqual(["way:1", "node:3"]);
    expect(gated.invented).toBe(1);
    expect(gated.picks[0].reason).toBe("Eine Burg für Kinder.");
  });

  it("replaces a sentence that names an hour or a price with the open-data reason", () => {
    const gated = gateCuration([
      { osmRef: "way:1", reason: "Täglich ab 9 Uhr geöffnet, Eintritt 8 €." },
      { osmRef: "node:2", reason: "Kostenlos zu besichtigen." },
    ], entries, context);
    expect(gated.picks[0].reason).toBe("12.000 Aufrufe im Monat");
    expect(gated.picks[1].reason).toBeNull();
    expect(gated.replaced).toBe(2);
  });

  it("lets a number through that the input said", () => {
    expect(namesUnknownFact("Eine Burg aus dem 12. Jahrhundert.", "Burg aus dem 12. Jahrhundert")).toBe(false);
    expect(namesUnknownFact("Seit 1350 bewohnt.", "Burg aus dem 12. Jahrhundert")).toBe(true);
  });

  it("reads a bare list of references", () => {
    expect(gateCuration(["node:3", "way:1"], entries, context).picks)
      .toEqual([{ osmRef: "node:3", reason: null }, { osmRef: "way:1", reason: null }]);
  });
});

describe("the score of an order", () => {
  it("lies between everything open data can say and a place the family brought", () => {
    expect(curatedScore(0, 10)).toBe(CURATED_TOP);
    expect(curatedScore(9, 10)).toBe(CURATED_FLOOR);
    expect(curatedScore(0, 1)).toBe(CURATED_TOP);
    expect(CURATED_TOP).toBeLessThan(MANUAL_SCORE);
  });

  it("puts the model's first ahead of a better known place, with its sentence", () => {
    const spot = (n: number, name: string): GeoPoiSearchSpot => ({
      osmRef: `node:${n}`, type: "node", id: n, lat: 48, lon: 10, distanceM: 100, detourM: null,
      name, nameDe: null, nameEn: null, kind: "tourism=attraction", categories: ["sight"],
      wikidataQid: n === 1 ? "Q1" : null, wikipedia: n === 1 ? "de:Beispiel" : null,
      openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
      dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
    });
    const scored = toCandidates([spot(1, "Bekannt"), spot(2, "Unbekannt")], {
      curated: new Map([["node:2", { rank: 0, of: 1, reason: "Passt zur Gruppe." }]]),
    });
    const [known, curated] = scored;
    expect(curated.score).toBeGreaterThan(known.score);
    expect(curated.reasons[0]).toBe("Passt zur Gruppe.");
    expect(curated.searchScore).toBe(1.5);
    expect(known.curatedScore).toBeUndefined();
  });
});

describe("when to ask again", () => {
  const before = signatureOf(["a", "b", "c", "d"], ["castles"]);

  it("asks a pool that was never ordered, and never a tiny one", () => {
    expect(curationDue(null, before)).toBe(true);
    expect(curationDue(null, signatureOf(["a", "b"], []))).toBe(false);
  });

  it("asks again when the interests change or more than a handful of places", () => {
    expect(curationDue(before, signatureOf(["a", "b", "c", "d", "e"], ["castles"]))).toBe(false);
    expect(curationDue(before, signatureOf(["a", "b", "c", "d"], ["museums"]))).toBe(true);
    expect(curationDue(before, signatureOf(["a", "e", "f", "g", "h", "i"], ["castles"]))).toBe(true);
  });
});

describe("the group in the abstract", () => {
  it("counts adults and gives children their age on the first day", () => {
    expect(groupLine(["1980-05-01", null, "2019-08-20"], "2026-08-10")).toBe("2 Erwachsene, 1 Kind (6)");
    expect(groupLine(["1980-05-01"], "2026-08-10")).toBe("1 Erwachsener");
    expect(groupLine([], "2026-08-10")).toBeNull();
  });
});
