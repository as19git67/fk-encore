/**
 * A trip that starts with an empty list (plan `ideen-statt-pool.md`,
 * stage 1).
 *
 * The planner searches nothing and fills no day; every stop on a day is
 * one the travellers put there, and a re-plan keeps it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripLegCuration, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, detailTripDay, getTripPlan, updateTripSettings } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { dayTripSuggestion } from "./day-trip";
import { getTripItinerary, putTripItinerary, type ItineraryItem } from "./itinerary";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(n: number, lat: number, lon: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n, lat, lon, distanceM: 10, detourM: null,
    name: `Beispielplatz ${n}`, nameDe: null, nameEn: null,
    kind: "tourism=museum", categories: ["museum"], wikidataQid: "Q1", wikipedia: "de:Beispiel",
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `ideas-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [1, 2, 3, 4].map((n) => spot(n, TOWN.lat + n * 0.001, TOWN.lon)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function emptyTrip(days = 3) {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  return plan;
}

const stopsOf = (leg: { days: { blocks: { stops: { osmRef: string; name: string | null }[] }[] }[] }) =>
  leg.days.map((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.name)));

let nextIdea = 0;

async function ideaOnDay(planId: number, name: string, dayIndex: number) {
  // Far enough apart that two ideas are never taken for one place.
  nextIdea += 1;
  const find = await addFind({
    planId, lat: TOWN.lat - nextIdea * 0.01, lon: TOWN.lon + nextIdea * 0.01, name, dwellMinutes: 45,
  });
  const { plan } = await getTripPlan({ planId });
  const entry = plan.legs[0].pool.find((c) => c.name === name)!;
  const block = plan.legs[0].days[dayIndex].blocks.find((b) => b.kind === "spots")!;
  await placeFromPool({ planId, dayIndex, blockId: block.id, osmRef: entry.osmRef });
  return find;
}

describe("a trip that starts with an empty list", () => {
  it("searches nothing, plans no stop and leaves every day open for stops", async () => {
    const plan = await emptyTrip();
    expect(geo.getSearchCalls()).toEqual([]);
    expect(plan.constraints.ideas).toBe(true);
    const leg = plan.legs[0];
    expect(leg.pool).toEqual([]);
    expect(stopsOf(leg).flat()).toEqual([]);
    expect(leg.days.map((d) => d.detailed)).toEqual([true, true, true]);
    expect(leg.days[0].blocks.length).toBeGreaterThan(0);
    // Nothing for the model to order.
    expect(await db.select().from(tripLegCuration).where(eq(tripLegCuration.leg_id, leg.id))).toEqual([]);
  });

  it("builds the earlier way when asked to", async () => {
    const { plan } = await createTripPlan({
      startEmpty: false,
      legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000 }],
    });
    expect(plan.constraints.ideas).toBe(false);
    expect(geo.getSearchCalls().length).toBeGreaterThan(0);
    expect(plan.legs[0].pool.length + stopsOf(plan.legs[0]).flat().length).toBeGreaterThan(0);
  });

  it("takes an idea in only through a deliberate act, and lets it be placed on a day", async () => {
    const plan = await emptyTrip();
    await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon + 0.003, name: "Café Beispiel", dwellMinutes: 30 });
    const { plan: withIdea } = await getTripPlan({ planId: plan.id });
    expect(withIdea.legs[0].pool.map((c) => c.name)).toEqual(["Café Beispiel"]);

    await ideaOnDay(plan.id, "Beispielturm", 1);
    const { plan: placed } = await getTripPlan({ planId: plan.id });
    expect(stopsOf(placed.legs[0])[1]).toEqual(["Beispielturm"]);
  });

  it("keeps the stops on their days when a setting re-plans the trip", async () => {
    const plan = await emptyTrip();
    await ideaOnDay(plan.id, "Beispielturm", 0);
    await ideaOnDay(plan.id, "Beispielgarten", 2);

    const searched = geo.getSearchCalls().length;
    const { plan: after } = await updateTripSettings({ planId: plan.id, pace: "relaxed" });
    expect(stopsOf(after.legs[0])[0]).toEqual(["Beispielturm"]);
    expect(stopsOf(after.legs[0])[2]).toEqual(["Beispielgarten"]);
    expect(after.legs[0].pool).toEqual([]);
    expect(geo.getSearchCalls()).toHaveLength(searched);
  });

  it("puts a stop back among the ideas when the stay loses its day", async () => {
    const plan = await emptyTrip();
    await ideaOnDay(plan.id, "Beispielturm", 0);
    await ideaOnDay(plan.id, "Beispielgarten", 2);

    const chain = await getTripItinerary({ planId: plan.id });
    const items = chain.items.map((i) => ({ ...i }) as ItineraryItem);
    items.find((i) => i.kind === "stay")!.days = 2;
    const { plan: shorter } = await putTripItinerary({ planId: plan.id, startDate: chain.startDate, items });

    const leg = shorter.legs[0];
    expect(leg.days).toHaveLength(2);
    expect(stopsOf(leg)[0]).toEqual(["Beispielturm"]);
    expect(leg.pool.map((c) => c.name)).toEqual(["Beispielgarten"]);
    expect(leg.pool[0].origin).toBe("manual");
  });

  it("detailing a day puts nothing in it", async () => {
    const plan = await emptyTrip();
    await ideaOnDay(plan.id, "Beispielturm", 0);
    const searched = geo.getSearchCalls().length;
    const { plan: after } = await detailTripDay({ planId: plan.id, dayIndex: 0 });
    expect(stopsOf(after.legs[0])[0]).toEqual(["Beispielturm"]);
    expect(geo.getSearchCalls()).toHaveLength(searched);
  });

  it("suggests no day trip for days that are empty only because nobody has added anything yet", async () => {
    const plan = await emptyTrip();
    const answer = await dayTripSuggestion({ planId: plan.id });
    expect(answer.suggestion).toBeNull();
    expect(answer.note).toMatch(/Ideen/);
  });
});
