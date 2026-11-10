/**
 * Food as its own list and the vote behind a switch (ideas plan,
 * stages 6 and 7).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, updateTripSettings } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { orderTripDay } from "./day-order-api";
import { addTripFixpoint, setTripFixpointPinReason } from "./fixpoint-edit";
import { nearbyFood } from "./food";
import { applyVotesToPlan } from "./plan-votes";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(id: number, name: string, lat: number, lon: number, kind: string, categories: string[]): GeoPoiSearchSpot {
  return {
    osmRef: `node:${id}`, type: "node", id, lat, lon, distanceM: 5, detourM: null,
    name, nameDe: null, nameEn: null, kind, categories, wikidataQid: null, wikipedia: null,
    openingHours: null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

const TRATTORIA = spot(11, "Beispieltrattoria", TOWN.lat + 0.003, TOWN.lon, "amenity=restaurant", ["food"]);
const CAFE = spot(12, "Beispielcafé", TOWN.lat + 0.001, TOWN.lon, "amenity=cafe", ["cafe"]);
const OSTERIA = spot(13, "Beispielosteria", TOWN.lat + 0.012, TOWN.lon, "amenity=restaurant", ["food"]);

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `food-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [TRATTORIA, CAFE, OSTERIA]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function trip() {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  return plan;
}

describe("food on a trip of ideas", () => {
  it("lists the trip's own food ideas first, marked, then the map's", async () => {
    const plan = await trip();
    await addFind({ planId: plan.id, lat: TRATTORIA.lat, lon: TRATTORIA.lon, name: "Beispieltrattoria", note: "Pasta laut Blog" });
    const { places } = await nearbyFood({ position: TOWN, planId: plan.id });
    expect(places[0]).toMatchObject({ name: "Beispieltrattoria", idea: true, note: "Pasta laut Blog" });
    expect(places.filter((p) => p.osmRef === places[0].osmRef)).toHaveLength(1);
    expect(places.some((p) => p.name === "Beispielcafé" && !p.idea)).toBe(true);
  });

  it("orders a restaurant like any spot, and holds a booked table at its hour", async () => {
    const plan = await trip();
    // The restaurant far to the north, the tower to the east, the fountain
    // to the west: a walk that begins at the restaurant is the long way.
    await addFind({ planId: plan.id, lat: OSTERIA.lat, lon: OSTERIA.lon, name: "Beispielosteria" });
    await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon + 0.006, name: "Beispielturm", dwellMinutes: 30 });
    await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon - 0.006, name: "Beispielbrunnen", dwellMinutes: 30 });
    let current = (await getTripPlan({ planId: plan.id })).plan;
    const byName = (name: string) => current.legs[0].pool.find((c) => c.name === name)!.osmRef;
    const trattoria = byName("Beispielosteria");
    for (const osmRef of [trattoria, byName("Beispielturm"), byName("Beispielbrunnen")]) {
      current = (await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef })).plan;
    }
    const { plan: ordered } = await orderTripDay({ planId: plan.id, dayIndex: 0 });
    const names = ordered.legs[0].days[0].blocks[0].stops.map((s) => s.name);
    expect(names).toHaveLength(3);
    expect(names[0]).not.toBe("Beispielosteria");

    const { plan: booked } = await addTripFixpoint({
      planId: plan.id, dayIndex: 0, at: "13:00", durationMinutes: 60, spotRef: trattoria, pinReason: "reservation",
    });
    const fix = booked.legs[0].days[0].fixpoints.find((f) => f.spotRef === trattoria)!;
    expect(fix.pinReason).toBe("reservation");
    await orderTripDay({ planId: plan.id, dayIndex: 0 });
    const day = (await getTripPlan({ planId: plan.id })).plan.legs[0].days[0];
    const table = day.blocks.flatMap((b) => b.stops).find((s) => s.osmRef === trattoria)!;
    expect(table.etaMinutes).toBe(13 * 60);

    const { plan: event } = await setTripFixpointPinReason({ planId: plan.id, fixpointId: fix.rowId!, pinReason: "event" });
    expect(event.legs[0].days[0].fixpoints.find((f) => f.rowId === fix.rowId)!.pinReason).toBe("event");
    await expect(setTripFixpointPinReason({ planId: plan.id, fixpointId: fix.rowId!, pinReason: "guess" }))
      .rejects.toThrow(/pinReason/);
  });
});

describe("the vote", () => {
  it("is off on a trip of ideas until it is switched on", async () => {
    const plan = await trip();
    await expect(applyVotesToPlan({ planId: plan.id })).rejects.toThrow(/nicht abgestimmt/);

    const { plan: on } = await updateTripSettings({ planId: plan.id, voting: true });
    expect((on.constraints as Record<string, unknown>).voting).toBe(true);
    await expect(applyVotesToPlan({ planId: plan.id })).resolves.toBeDefined();

    const { plan: off } = await updateTripSettings({ planId: plan.id, voting: false });
    expect((off.constraints as Record<string, unknown>).voting).toBe(false);
  });

  it("stays on for a trip from before", async () => {
    const { plan } = await createTripPlan({
      startEmpty: false,
      legs: [{ title: "Musterstadt", anchor: TOWN, days: 1, radiusM: 4_000 }],
    });
    await expect(applyVotesToPlan({ planId: plan.id })).resolves.toBeDefined();
  });
});
