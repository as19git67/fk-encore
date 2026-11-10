/**
 * A short German sentence per place, made from its description. The
 * places and their texts are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, tripSpotFame, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { checkSummary, summariseSpots, summarySource, takenAsIs } from "./spot-summary";

const LEAD_IT = "La Torre di Esempio è una torre campanaria del 1250, alta 54 metri, nel centro di Musterstadt.";

describe("the text a sentence is made from", () => {
  it("takes the travel guide first, and knows a German one", () => {
    expect(summarySource({
      wikivoyage: "Kleiner Turm mit Blick.", wikivoyagePage: "https://de.wikivoyage.org/wiki/Musterstadt",
      description: { text: LEAD_IT, source: "wikipedia", url: "https://it.wikipedia.org/wiki/Torre" },
    })).toEqual({ text: "Kleiner Turm mit Blick.", german: true });
    expect(summarySource({
      wikivoyage: null, wikivoyagePage: null,
      description: { text: LEAD_IT, source: "wikipedia", url: "https://it.wikipedia.org/wiki/Torre" },
    })).toEqual({ text: LEAD_IT, german: false });
    expect(summarySource({ wikivoyage: "", wikivoyagePage: null, description: null })).toBeNull();
  });

  it("uses a short German text as it is, and asks for anything else", () => {
    expect(takenAsIs({ text: "Kleiner  Turm mit Blick.", german: true })).toBe("Kleiner Turm mit Blick.");
    expect(takenAsIs({ text: "x".repeat(400), german: true })).toBeNull();
    expect(takenAsIs({ text: "Small tower.", german: false })).toBeNull();
  });
});

describe("checking the model's sentence", () => {
  it("keeps a short sentence with the text's own numbers", () => {
    expect(checkSummary({ summary: "Glockenturm von 1250 mitten in der Altstadt." }, LEAD_IT))
      .toBe("Glockenturm von 1250 mitten in der Altstadt.");
  });

  it("drops one with a number or an hour the text did not have, or one too long", () => {
    expect(checkSummary({ summary: "Glockenturm mit 300 Stufen bis zur Spitze." }, LEAD_IT)).toBeNull();
    expect(checkSummary({ summary: "Glockenturm, täglich geöffnet." }, LEAD_IT)).toBeNull();
    expect(checkSummary({ summary: "Ein Turm. ".repeat(30) }, LEAD_IT)).toBeNull();
    expect(checkSummary({ summary: "Turm." }, LEAD_IT)).toBeNull();
    expect(checkSummary("kein Objekt", LEAD_IT)).toBeNull();
  });
});

describe("making the sentences in the background", () => {
  const CITY = { lat: 48.37, lon: 10.9 };
  const sight = (n: number): GeoPoiSearchSpot => ({
    osmRef: `node:${n}`, type: "node", id: n,
    lat: CITY.lat + n * 0.0005, lon: CITY.lon, distanceM: 100 + n, detourM: null,
    name: `Beispielort ${n}`, nameDe: null, nameEn: null,
    kind: "tourism=attraction", categories: ["sight"],
    wikidataQid: null, wikipedia: null,
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  });

  beforeEach(async () => {
    await db.delete(tripPlans);
    await db.delete(tripSpotFame);
    await db.delete(osmRegionImports);
    clearRouterCache();
    const [user] = await db.insert(users)
      .values({ email: `summary-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
    await db.insert(osmRegionImports).values({
      slug: "europe/test", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_test",
      bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.2, status: "ready_running",
    });
    const geo = new InMemoryGeoClient();
    geo.setSearchSpots("nom_test", [sight(1), sight(2)]);
    setGeoClient(geo);
  });

  afterEach(() => resetGeoClient());

  it("summarises a foreign lead, keeps a short German line, and shows both on the plan", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const at = new Date().toISOString();
    for (const [ref, set] of [
      ["node:1", { description: { text: LEAD_IT, source: "wikipedia", url: "https://it.wikipedia.org/wiki/Torre" } }],
      ["node:2", { wikivoyage: "Kleiner Turm mit Blick.", wikivoyage_page: "https://de.wikivoyage.org/wiki/Musterstadt" }],
    ] as const) {
      await db.insert(tripSpotFame).values({ osm_ref: ref, name: ref, lat: CITY.lat, lon: CITY.lon, fetched_at: at, ...set })
        .onConflictDoUpdate({ target: tripSpotFame.osm_ref, set: { ...set } });
    }

    const prompts: string[] = [];
    const ask = async (prompt: string) => { prompts.push(prompt); return { summary: "Glockenturm von 1250 mitten in der Altstadt." }; };
    expect(await summariseSpots({ ask })).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(LEAD_IT);

    // Nothing changed, so nothing is asked again.
    expect(await summariseSpots({ ask })).toBe(0);
    expect(prompts).toHaveLength(1);

    const { plan: loaded } = await getTripPlan({ planId: plan.id });
    const all = [...loaded.legs[0].pool, ...loaded.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops))];
    expect(all.find((s) => s.osmRef === "node:1")?.summary).toBe("Glockenturm von 1250 mitten in der Altstadt.");
    expect(all.find((s) => s.osmRef === "node:2")?.summary).toBe("Kleiner Turm mit Blick.");
  });

  it("shows no sentence of an older text, and asks again for the new one", async () => {
    await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const at = new Date().toISOString();
    const set = { description: { text: LEAD_IT, source: "wikipedia", url: "https://it.wikipedia.org/wiki/Torre" } };
    await db.insert(tripSpotFame).values({ osm_ref: "node:1", name: "Torre", lat: CITY.lat, lon: CITY.lon, fetched_at: at, ...set })
      .onConflictDoUpdate({ target: tripSpotFame.osm_ref, set });
    let asked = 0;
    const ask = async () => { asked += 1; return { summary: "Ein Turm mit 300 Stufen." }; };
    expect(await summariseSpots({ ask })).toBe(0);
    expect(await summariseSpots({ ask })).toBe(0);
    expect(asked).toBe(1);

    const newer = "La Torre di Esempio è una torre campanaria medievale.";
    await db.update(tripSpotFame)
      .set({ description: { text: newer, source: "wikipedia", url: "https://it.wikipedia.org/wiki/Torre" } })
      .where(eq(tripSpotFame.osm_ref, "node:1"));
    expect(await summariseSpots({ ask: async () => ({ summary: "Mittelalterlicher Glockenturm." }) })).toBe(1);
    const [row] = await db.select().from(tripSpotFame).where(eq(tripSpotFame.osm_ref, "node:1"));
    expect((row.summary as { text: string }).text).toBe("Mittelalterlicher Glockenturm.");
  });
});
