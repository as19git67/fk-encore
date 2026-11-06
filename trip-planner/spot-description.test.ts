/**
 * Text for a card where Wikipedia is thin (ranking plan, stage 4). The
 * places, the page and the summary are invented.
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
import { checkSiteSummary, chooseDescription, describeSpots, MIN_LEAD_CHARS } from "./spot-description";

const PAGE = `<html><body><nav>Start | Kontakt</nav><main>
<h1>Mühle Beispieltal</h1>
<p>Die Mühle Beispieltal ist eine wassergetriebene Getreidemühle aus dem Jahr 1820, in der heute noch Mehl gemahlen wird.</p>
<p>Ein Lehrpfad führt am Mühlbach entlang zu drei Wasserrädern.</p>
</main></body></html>`;

describe("choosing a description", () => {
  it("takes the travel guide first, then a lead that says something", () => {
    expect(chooseDescription({ wikivoyage: "Alte Mühle am Bach.", wikivoyagePage: "https://de.wikivoyage.org/wiki/Musterstadt", lead: "Lang genug.".repeat(10), leadUrl: null })?.source)
      .toBe("wikivoyage");
    expect(chooseDescription({ wikivoyage: "", wikivoyagePage: null, lead: "x".repeat(MIN_LEAD_CHARS), leadUrl: null })?.source)
      .toBe("wikipedia");
    expect(chooseDescription({ wikivoyage: null, wikivoyagePage: null, lead: "Stub.", leadUrl: null })).toBeNull();
  });
});

describe("checking a website summary", () => {
  const text = "Die Mühle Beispieltal ist eine wassergetriebene Getreidemühle aus dem Jahr 1820, in der heute noch Mehl gemahlen wird.";

  it("keeps a summary whose quote is on the page", () => {
    expect(checkSiteSummary({
      summary: "Eine Getreidemühle von 1820, in der noch gemahlen wird.",
      quote: "wassergetriebene Getreidemühle aus dem Jahr 1820",
    }, text)).toBe("Eine Getreidemühle von 1820, in der noch gemahlen wird.");
  });

  it("drops one whose quote is not on the page, or that adds an hour", () => {
    expect(checkSiteSummary({ summary: "Eine Mühle.", quote: "eine Mühle mit Café und Biergarten" }, text)).toBeNull();
    expect(checkSiteSummary({
      summary: "Täglich ab 10 Uhr geöffnet.", quote: "wassergetriebene Getreidemühle",
    }, text)).toBeNull();
  });
});

describe("looking for descriptions in the background", () => {
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
      .values({ email: `describe-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
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

  it("summarises the place's own website and shows it on the plan", async () => {
    const { plan } = await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const at = new Date().toISOString();
    await db.insert(tripSpotFame).values([
      { osm_ref: "node:1", name: "Mühle Beispieltal", lat: CITY.lat, lon: CITY.lon, website: "https://muehle.example.test", fetched_at: at },
      { osm_ref: "node:2", name: "Beispielort 2", lat: CITY.lat, lon: CITY.lon, wikivoyage: "Kleiner Turm mit Blick.", wikivoyage_page: "https://de.wikivoyage.org/wiki/Musterstadt", fetched_at: at },
    ]).onConflictDoUpdate({ target: tripSpotFame.osm_ref, set: { fetched_at: at } });
    await db.update(tripSpotFame).set({ website: "https://muehle.example.test" }).where(eq(tripSpotFame.osm_ref, "node:1"));
    await db.update(tripSpotFame).set({ wikivoyage: "Kleiner Turm mit Blick.", wikivoyage_page: "https://de.wikivoyage.org/wiki/Musterstadt" })
      .where(eq(tripSpotFame.osm_ref, "node:2"));

    const fetched: string[] = [];
    const described = await describeSpots({ deps: {
      fetchPage: async (url) => { fetched.push(url); return PAGE; },
      ask: async () => ({
        summary: "Eine Getreidemühle von 1820 mit Lehrpfad am Mühlbach.",
        quote: "Ein Lehrpfad führt am Mühlbach entlang",
      }),
    } });
    expect(described).toBe(1);
    expect(fetched).toEqual(["https://muehle.example.test"]);

    const { plan: loaded } = await getTripPlan({ planId: plan.id });
    const all = [...loaded.legs[0].pool, ...loaded.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops))];
    expect(all.find((s) => s.osmRef === "node:1")?.description).toEqual({
      text: "Eine Getreidemühle von 1820 mit Lehrpfad am Mühlbach.", source: "website", url: "https://muehle.example.test",
    });
    expect(all.find((s) => s.osmRef === "node:2")?.description?.source).toBe("wikivoyage");
  });

  it("stores nothing when the summary does not hold, and does not ask again soon", async () => {
    await createTripPlan({ legs: [{ title: "Musterstadt", anchor: CITY, days: 1 }] });
    const at = new Date().toISOString();
    await db.insert(tripSpotFame).values({ osm_ref: "node:1", name: "Mühle", lat: CITY.lat, lon: CITY.lon, website: "https://muehle.example.test", fetched_at: at })
      .onConflictDoUpdate({ target: tripSpotFame.osm_ref, set: { website: "https://muehle.example.test", fetched_at: at } });
    let asked = 0;
    const deps = {
      fetchPage: async () => PAGE,
      ask: async () => { asked += 1; return { summary: "Eine Mühle.", quote: "steht nirgends auf der Seite" }; },
    };
    expect(await describeSpots({ deps })).toBe(0);
    expect(await describeSpots({ deps })).toBe(0);
    expect(asked).toBe(1);
    const [row] = await db.select().from(tripSpotFame).where(eq(tripSpotFame.osm_ref, "node:1"));
    expect(row.description).toBeNull();
    expect(row.described_at).not.toBeNull();
  });
});
