/**
 * How far a leg looks, and what it looks for (§4.2).
 *
 * Written after a trip to San Francisco came back as a day in the four
 * streets around the hotel: the bridge, the park, the pier with the sea
 * lions and Sausalito were never in the pool at all. Two causes, and
 * both are ordinary arithmetic rather than taste:
 *
 *   - the search radius was 2 500 m for every leg, which is a walking
 *     radius around a European old town, and
 *   - the area search fills its page nearest-first, so cutting the page
 *     by distance and *then* keeping what is worth a block keeps
 *     neither: in a dense city the nearest hundred and fifty rows are a
 *     hundred and fifty ordinary ones.
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

/** An invented bay city, and a landmark on the far side of it. */
const DOWNTOWN = { lat: 37.79, lon: -122.40 };
const FAR_LANDMARK = { lat: 37.82, lon: -122.47 }; // ≈ 6,5 km west

function spot(
  ref: string,
  at: { lat: number; lon: number },
  extras: Partial<GeoPoiSearchSpot> = {},
): GeoPoiSearchSpot {
  return {
    osmRef: ref,
    type: "node",
    id: Number(ref.split(":")[1]),
    lat: at.lat,
    lon: at.lon,
    distanceM: null,
    detourM: null,
    name: ref,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: ["sight"],
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
    ...extras,
  };
}

/** Enough ordinary spots around the hotel to fill the page on their own. */
function crowdedBlock(): GeoPoiSearchSpot[] {
  return Array.from({ length: 200 }, (_, i) =>
    spot(`node:${100 + i}`, {
      // A few hundred metres out, fanned around the anchor.
      lat: DOWNTOWN.lat + (i % 20) * 0.0002,
      lon: DOWNTOWN.lon + Math.floor(i / 20) * 0.0002,
    }));
}

const BRIDGE = spot("way:1", FAR_LANDMARK, {
  name: "Die große Brücke",
  wikidataQid: "Q1",
  wikipedia: "de:Die große Brücke",
});

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `reach-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  await db.insert(osmRegionImports).values({
    slug: "america/bay",
    geofabrik_url: "https://example.com/bay.pbf",
    postgres_db: "nom_bay",
    bbox_min_lat: 37.0,
    bbox_min_lon: -123.0,
    bbox_max_lat: 38.5,
    bbox_max_lon: -121.5,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** Every spot the leg ended up with, planned or in the pool. */
function refsOf(leg: { days: Array<{ blocks: Array<{ stops: Array<{ osmRef: string }> }> }>;
                      pool: Array<{ osmRef: string }> }): string[] {
  return [
    ...leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))),
    ...leg.pool.map((c) => c.osmRef),
  ];
}

describe("how far a leg reaches", () => {
  it("searches a city, not a quarter, when the leg has a car", async () => {
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    await createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1 }] });

    const radii = geo.getSearchCalls().map((c) => c.query.center?.radiusM);
    // 2 500 m does not reach the far side of a bay; a car does.
    expect(radii.every((r) => (r ?? 0) >= 20_000)).toBe(true);
  });

  it("takes the mode from the one-city shorthand too", async () => {
    // It used to drop it on the floor, which planned every flat request
    // on foot however the caller travelled.
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    const { plan } = await createTripPlan({ anchor: DOWNTOWN, mode: "car", days: 1 });

    expect(plan.legs[0].mode).toBe("car");
    expect(geo.getSearchCalls()[0].query.center?.radiusM).toBeGreaterThanOrEqual(20_000);
  });

  it("keeps the walking radius for a leg on foot", async () => {
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    await createTripPlan({ legs: [{ anchor: DOWNTOWN, days: 1 }] });

    const radii = geo.getSearchCalls().map((c) => c.query.center?.radiusM);
    expect(radii.every((r) => r === 3_000)).toBe(true);
  });

  it("obeys a radius the traveller named, whatever the mode", async () => {
    // "Zwei Kilometer, wir bleiben im Viertel" answers the question
    // better than any table can.
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    await createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1, radiusM: 2_000 }] });

    const radii = geo.getSearchCalls().map((c) => c.query.center?.radiusM);
    expect(radii.every((r) => r === 2_000)).toBe(true);
  });

  it("asks the same disc twice — for what is near and for what is known", async () => {
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    await createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1 }] });

    const ranks = geo.getSearchCalls().map((c) => c.query.rank);
    expect(ranks).toContain("distance");
    expect(ranks).toContain("prominence");
  });

  it("finds the landmark the nearest page would never have reached", async () => {
    // The whole point. Two hundred ordinary spots sit between the hotel
    // and the bridge, and the page holds a hundred and fifty.
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);

    const { plan } = await createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1 }] });

    expect(refsOf(plan.legs[0])).toContain("way:1");
  });

  it("refuses rather than calling a dead search an empty city", async () => {
    // Both searches down is not "there is nothing here". Saved as a
    // trip it writes a lie into the plan and hides it behind a day that
    // looks merely empty — which is how Florence came back with no
    // spots and no explanation.
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);
    geo.failSearchFor("nom_bay");

    await expect(createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1 }] }))
      .rejects.toThrow(/Umgebungssuche/);
  });

  it("still plans when only one of the two searches fails", async () => {
    // A leg with half a pool beats a refusal to save what somebody
    // typed (§4.3).
    geo.setSearchSpots("nom_bay", [BRIDGE, ...crowdedBlock()]);
    geo.failSearchFor("nom_bay", { rank: "prominence" });

    const { plan } = await createTripPlan({ legs: [{ anchor: DOWNTOWN, mode: "car", days: 1 }] });

    expect(plan.legs[0].days).toHaveLength(1);
    expect(refsOf(plan.legs[0]).length).toBeGreaterThan(0);
  });
});
