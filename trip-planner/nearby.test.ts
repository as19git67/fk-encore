/**
 * "Was ist hier in der Nähe?" (§7.1).
 *
 * The decision worth protecting is where the answer comes from: the
 * leg's own pool first, the region search only behind it. The
 * travellers already told the planner what they like; a fresh
 * unfiltered search would answer a different question than the plan
 * does, and the two would quietly disagree about what is worth seeing.
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
import { nearbySpots } from "./nearby";

const HERE = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

/** `n` metres north of where the group is standing. */
function north(metres: number) {
  return { lat: HERE.lat + metres / 111_320, lon: HERE.lon };
}

function spot(n: number, metres: number, category = "sight"): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    ...north(metres),
    distanceM: metres,
    detourM: null,
    name: `Spot ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: [category],
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
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `near-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
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

describe("POST /trip-planner/nearby", () => {
  it("works without a plan at all", async () => {
    geo.setSearchSpots(DB, [spot(1, 100), spot(2, 400)]);
    const res = await nearbySpots({ position: HERE });

    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:1", "node:2"]);
    expect(res.spots.every((s) => !s.fromPool)).toBe(true);
  });

  it("puts what the travellers already wanted ahead of what is merely here", async () => {
    // The whole point (§7.1): the pool is the answer, the region search
    // is the fallback. A closer unknown spot does not outrank a spot
    // they already chose.
    geo.setSearchSpots(DB, Array.from({ length: 10 }, (_, i) => spot(i + 1, (i + 1) * 100)));
    const { plan } = await createTripPlan({ anchor: HERE, days: 1 });

    // A newcomer nearer than anything the plan knows.
    geo.setSearchSpots(DB, [spot(99, 20), ...Array.from({ length: 10 }, (_, i) => spot(i + 1, (i + 1) * 100))]);

    const res = await nearbySpots({ position: HERE, planId: plan.id });
    expect(res.spots[0].fromPool).toBe(true);
    const newcomer = res.spots.find((s) => s.osmRef === "node:99")!;
    expect(newcomer.fromPool).toBe(false);
    expect(newcomer.distanceM).toBeLessThan(res.spots[0].distanceM);
  });

  it("says which spots are already in the plan rather than hiding them", async () => {
    // "Das steht schon für Donnerstag" is worth knowing while standing
    // in front of it.
    geo.setSearchSpots(DB, Array.from({ length: 6 }, (_, i) => spot(i + 1, (i + 1) * 100)));
    const { plan } = await createTripPlan({ anchor: HERE, days: 1 });
    const plannedRefs = plan.legs[0].days[0].blocks
      .flatMap((b) => b.stops.map((s) => s.osmRef));

    const res = await nearbySpots({ position: HERE, planId: plan.id });
    for (const ref of plannedRefs) {
      const found = res.spots.find((s) => s.osmRef === ref);
      expect(found?.alreadyPlanned, ref).toBe(true);
    }
  });

  it("orders each group by distance", async () => {
    geo.setSearchSpots(DB, [spot(3, 900), spot(1, 100), spot(2, 400)]);
    const res = await nearbySpots({ position: HERE });
    // The order is the assertion; the metres are recomputed from the
    // coordinates and land a metre either side of the fixture.
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:1", "node:2", "node:3"]);
    for (let i = 1; i < res.spots.length; i += 1) {
      expect(res.spots[i].distanceM).toBeGreaterThanOrEqual(res.spots[i - 1].distanceM);
    }
  });

  it("keeps what is out of range out of the list, whatever geo returned", async () => {
    // geo filters by radius as well, but the guarantee is made here
    // too: half the list checked and half taken on trust is one geo
    // change away from being wrong.
    geo.setSearchSpots(DB, [spot(1, 100), spot(2, 5_000)]);
    const res = await nearbySpots({ position: HERE, radiusM: 500 });
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:1"]);
  });

  it("carries the same reasons the plan shows", async () => {
    geo.setSearchSpots(DB, [
      { ...spot(1, 100), wikidataQid: "Q1", wikipedia: "de:Beispiel" },
    ]);
    const res = await nearbySpots({ position: HERE });
    expect(res.spots[0].reasons).toContain("hat einen Wikipedia-Artikel");
  });

  it("narrows to a category when asked", async () => {
    geo.setSearchSpots(DB, [spot(1, 100, "sight"), spot(2, 200, "museum")]);
    const res = await nearbySpots({ position: HERE, categories: ["museum"] });
    expect(geo.getSearchCalls().at(-1)!.query.categories).toEqual(["museum"]);
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:2"]);
  });

  it("keeps a place that satisfies the asked-for category among others", async () => {
    // A spot can be both a sight and a museum. Filtering on the single
    // category the scoring picks would drop it from a museum search.
    const both = { ...spot(1, 100), categories: ["sight", "museum"] };
    geo.setSearchSpots(DB, [both]);
    const res = await nearbySpots({ position: HERE, categories: ["museum"] });
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:1"]);
  });

  it("answers with an empty list rather than failing where nothing is imported", async () => {
    await db.delete(osmRegionImports);
    clearRouterCache();
    const res = await nearbySpots({ position: HERE });
    expect(res.region).toBeNull();
    expect(res.spots).toEqual([]);
  });

  it("refuses a radius that is a search across town", async () => {
    await expect(nearbySpots({ position: HERE, radiusM: 90_000 })).rejects.toThrow(/at most/);
  });

  it("does not read another user's pool", async () => {
    geo.setSearchSpots(DB, [spot(1, 100)]);
    const { plan } = await createTripPlan({ anchor: HERE, days: 1 });
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(nearbySpots({ position: HERE, planId: plan.id })).rejects.toThrow(
      /plan not found/,
    );
  });
});
