/**
 * The food list you get on the spot (§10.3).
 *
 * The concept is unusually explicit about what this must not be, and
 * that is what these tests hold: not a ranking, not a choice made for
 * you, and above all not an inference from silence. Open data knows a
 * restaurant exists, not whether it is any good — so an untagged place
 * is unknown, never "no".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { nearbyFood } from "./food";

const HERE = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

/** Invented places, all near the anchor. */
function place(
  n: number,
  distanceM: number,
  tags: Partial<GeoPoiSearchSpot> = {},
): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: HERE.lat + distanceM / 111_320,
    lon: HERE.lon,
    distanceM,
    detourM: null,
    name: `Lokal ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "amenity=restaurant",
    categories: ["food"],
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
    ...tags,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `food-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/food", () => {
  it("asks only for places to eat, nearest first", async () => {
    geo.setSearchSpots(DB, [place(1, 80), place(2, 300)]);

    const res = await nearbyFood({ position: HERE });

    const [call] = geo.getSearchCalls();
    expect(call.query.categories).toEqual(["food", "cafe"]);
    expect(call.query.center).toEqual({ ...HERE, radiusM: 1_000 });
    // The order is the search's, which is by distance — the only
    // ordering this list is allowed to have (§10.3).
    expect(res.places.map((p) => p.distanceM)).toEqual([80, 300]);
  });

  it("passes the attributes through exactly as OSM has them", async () => {
    geo.setSearchSpots(DB, [
      place(1, 80, {
        cuisine: "italian",
        openingHours: "Tu-Su 11:30-22:00",
        dietVegetarian: "yes",
        dietVegan: "limited",
        outdoorSeating: "yes",
        wheelchair: "limited",
        phone: "+49 000 0000000",
        website: "https://beispiel.test/lokal",
      }),
    ]);

    const [p] = (await nearbyFood({ position: HERE })).places;
    expect(p.cuisine).toBe("italian");
    // "limited" survives rather than collapsing to a boolean: it is a
    // real answer, and someone deciding where to eat can use it.
    expect(p.dietVegan).toBe("limited");
    expect(p.wheelchair).toBe("limited");
    expect(p.phone).toBe("+49 000 0000000");
    expect(p.website).toBe("https://beispiel.test/lokal");
  });

  it("keeps untagged places when nothing was filtered for", async () => {
    // The mistake to avoid: reading a missing tag as "no". Most places
    // in OSM are tagged with almost nothing (§10.1), and an unfiltered
    // list that dropped them would be nearly empty.
    geo.setSearchSpots(DB, [place(1, 80), place(2, 200), place(3, 300)]);
    const res = await nearbyFood({ position: HERE });
    expect(res.places).toHaveLength(3);
  });

  it("keeps only what says yes when a diet is asked for", async () => {
    geo.setSearchSpots(DB, [
      place(1, 80, { dietVegetarian: "yes" }),
      place(2, 150, { dietVegetarian: "only" }),
      place(3, 200, { dietVegetarian: "limited" }),
      place(4, 250, { dietVegetarian: "no" }),
      place(5, 300),
    ]);

    const res = await nearbyFood({ position: HERE, vegetarian: true });
    // yes, only and limited are all a yes for someone deciding where to
    // eat; "no" and untagged are not what was asked for.
    expect(res.places.map((p) => p.osmRef)).toEqual(["node:1", "node:2", "node:3"]);
  });

  it("filters vegan separately from vegetarian", async () => {
    geo.setSearchSpots(DB, [
      place(1, 80, { dietVegetarian: "yes", dietVegan: "no" }),
      place(2, 150, { dietVegetarian: "yes", dietVegan: "yes" }),
    ]);
    const res = await nearbyFood({ position: HERE, vegan: true });
    expect(res.places.map((p) => p.osmRef)).toEqual(["node:2"]);
  });

  it("takes step-free to mean step-free", async () => {
    // "limited" is a step or a narrow door. A real answer, but not what
    // someone who asked for step-free access wants to be handed.
    geo.setSearchSpots(DB, [
      place(1, 80, { wheelchair: "yes" }),
      place(2, 150, { wheelchair: "limited" }),
      place(3, 200),
    ]);
    const res = await nearbyFood({ position: HERE, wheelchair: true });
    expect(res.places.map((p) => p.osmRef)).toEqual(["node:1"]);
  });

  it("combines filters", async () => {
    geo.setSearchSpots(DB, [
      place(1, 80, { dietVegetarian: "yes" }),
      place(2, 150, { dietVegetarian: "yes", outdoorSeating: "yes" }),
      place(3, 200, { outdoorSeating: "yes" }),
    ]);
    const res = await nearbyFood({ position: HERE, vegetarian: true, outdoorSeating: true });
    expect(res.places.map((p) => p.osmRef)).toEqual(["node:2"]);
  });

  it("searches wider than the page so a filter has something to work with", async () => {
    // Asking for ten vegan places must not return three of them because
    // the nearest ten happened to be steakhouses.
    geo.setSearchSpots(DB, [place(1, 80)]);
    await nearbyFood({ position: HERE, limit: 10, vegan: true });
    expect(geo.getSearchCalls()[0].query.limit).toBeGreaterThan(10);
  });

  it("reports how many it looked at, not just how many survived", async () => {
    geo.setSearchSpots(DB, [
      place(1, 80, { dietVegan: "yes" }),
      place(2, 150),
      place(3, 200),
    ]);
    const res = await nearbyFood({ position: HERE, vegan: true });
    expect(res.places).toHaveLength(1);
    expect(res.consideredCount).toBe(3);
  });

  it("narrows to cafés when asked", async () => {
    geo.setSearchSpots(DB, [place(1, 80)]);
    await nearbyFood({ position: HERE, categories: ["cafe"] });
    expect(geo.getSearchCalls()[0].query.categories).toEqual(["cafe"]);
  });

  it("refuses a category that is not somewhere to eat", async () => {
    await expect(
      nearbyFood({ position: HERE, categories: ["museum"] }),
    ).rejects.toThrow(/subset of food, cafe/);
  });

  it("refuses a radius that is a search across town", async () => {
    await expect(nearbyFood({ position: HERE, radiusM: 50_000 })).rejects.toThrow(/at most/);
  });

  it("says plainly when no region covers the spot", async () => {
    await db.delete(osmRegionImports);
    clearRouterCache();
    await expect(nearbyFood({ position: HERE })).rejects.toThrow(/no imported OSM region/);
  });
});
