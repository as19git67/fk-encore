/**
 * Searching for a place by name (§9.2, case 4).
 *
 * The way in that has to work when nothing else does — no share sheet,
 * no map app, no language model. So the tests are about the things that
 * would quietly make it useless: a region that is down looking like
 * "nothing found", and a place you already have vanishing from the list
 * instead of saying so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { searchPlaces } from "./search";
import { addFind } from "./add-find";

const WEST = { lat: 48.37, lon: 10.9 };
const EAST = { lat: 48.14, lon: 11.58 };

function spot(
  n: number,
  at: { lat: number; lon: number },
  name: string,
  over: Partial<GeoPoiSearchSpot> = {},
): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat,
    lon: at.lon,
    distanceM: 500,
    detourM: null,
    name,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: null,
    wikipedia: null,
    openingHours: "Tu-Su 10:00-17:00",
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

async function seedRegion(slug: string, postgresDb: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: postgresDb,
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: "ready_running",
  });
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `search-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await seedRegion("europe/west", "nom_west", [48.2, 10.5, 48.6, 11.2]);
  await seedRegion("europe/east", "nom_east", [48.0, 11.3, 48.4, 11.9]);
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function twoLegPlan() {
  geo.setSearchSpots("nom_west", []);
  geo.setSearchSpots("nom_east", []);
  const { plan } = await createTripPlan({
    legs: [
      { title: "Weststadt", anchor: WEST },
      { title: "Oststadt", anchor: EAST },
    ],
  });
  return plan;
}

describe("POST /trip-planner/plans/:planId/search", () => {
  it("finds a place by name and says what the planner knows about it", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Weststadt")]);

    const res = await searchPlaces({ planId: plan.id, query: "Stadtmuseum" });

    expect(res.results).toHaveLength(1);
    const [found] = res.results;
    expect(found.osmRef).toBe("node:1");
    expect(found.legIndex).toBe(0);
    expect(found.openingHours).toBe("Tu-Su 10:00-17:00");
    // The category's default, so the app can offer it rather than
    // asking for a duration it could look up.
    expect(found.dwellMinutes).toBeGreaterThan(0);
    expect(found.inPool).toBe(false);
    expect(found.planned).toBe(false);
  });

  it("searches every leg, not just the one on screen", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_east", [spot(2, EAST, "Stadtmuseum Oststadt")]);

    const res = await searchPlaces({ planId: plan.id, query: "Stadtmuseum" });

    expect(res.results.map((r) => r.legIndex)).toEqual([1]);
  });

  it("searches only the leg it was asked about", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Weststadt")]);
    geo.setSearchSpots("nom_east", [spot(2, EAST, "Stadtmuseum Oststadt")]);

    const res = await searchPlaces({ planId: plan.id, query: "Stadtmuseum", legIndex: 1 });

    expect(res.results.map((r) => r.osmRef)).toEqual(["node:2"]);
  });

  it("marks what is already in the pool rather than hiding it", async () => {
    // "Das habt ihr schon" is a useful answer to a search. A silently
    // shorter list is not — it reads as "not in OpenStreetMap".
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Weststadt")]);
    await addFind({
      planId: plan.id,
      lat: WEST.lat,
      lon: WEST.lon,
      name: "Stadtmuseum Weststadt",
      dwellMinutes: 60,
    });

    const res = await searchPlaces({ planId: plan.id, query: "Stadtmuseum" });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].inPool).toBe(true);
  });

  it("orders by how far out of the way it is", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [
      spot(1, WEST, "Museum Fern", { distanceM: 4_000 }),
      spot(2, WEST, "Museum Nah", { distanceM: 300 }),
    ]);

    const res = await searchPlaces({ planId: plan.id, query: "Museum" });

    expect(res.results.map((r) => r.osmRef)).toEqual(["node:2", "node:1"]);
  });

  it("names a region it could not reach instead of reporting nothing found", async () => {
    // "Nichts gefunden" and "eine Region war nicht erreichbar" are
    // different answers, and the traveller should not have to guess
    // which one they got.
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", [spot(1, WEST, "Stadtmuseum Weststadt")]);
    geo.failSearchFor("nom_east");

    const res = await searchPlaces({ planId: plan.id, query: "Stadtmuseum" });

    expect(res.results.map((r) => r.osmRef)).toEqual(["node:1"]);
    expect(res.unavailableLegs).toEqual([1]);
  });

  it("reports that more matched than it returned", async () => {
    const plan = await twoLegPlan();
    geo.setSearchSpots("nom_west", Array.from({ length: 6 }, (_, i) =>
      spot(10 + i, WEST, `Museum ${i}`, { distanceM: i * 100 })));

    const res = await searchPlaces({ planId: plan.id, query: "Museum", limit: 3 });

    expect(res.results).toHaveLength(3);
    expect(res.hasMore).toBe(true);
  });

  it("refuses a query too short to mean anything", async () => {
    const plan = await twoLegPlan();
    await expect(searchPlaces({ planId: plan.id, query: "a" }))
      .rejects.toThrow(/mindestens/);
    await expect(searchPlaces({ planId: plan.id, query: "   " }))
      .rejects.toThrow(/mindestens/);
  });

  it("does not search a plan that is not yours", async () => {
    await expect(searchPlaces({ planId: 999_999, query: "Museum" }))
      .rejects.toThrow(/plan not found/);
  });

  it("says so when the leg does not exist", async () => {
    const plan = await twoLegPlan();
    await expect(searchPlaces({ planId: plan.id, query: "Museum", legIndex: 7 }))
      .rejects.toThrow(/leg 7 not found/);
  });
});
