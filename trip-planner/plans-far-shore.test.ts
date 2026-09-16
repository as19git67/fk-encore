/**
 * A trip on the far shore of a lake that is also a border (§4.2, §13.0).
 *
 * The reported case: quarters on the east shore of a lake whose west
 * shore belongs to the only region imported. The region's rectangle
 * reaches across the water and so does its data probe, so the planner
 * took it — a hundred spots, every one of them on the wrong side — and
 * from the towns further north, with nothing in walking reach, an empty
 * plan and no word about the region it actually needed.
 *
 * The router now asks Geofabrik's polygon (`region-router.ts`); this
 * file checks that the planner *behaves* differently for it: the trip
 * waits for its own region and says so, instead of being filled from
 * across the water.
 *
 * Places invented, geometry Lake Garda's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache, setRegionIndexSource } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";

const requested = vi.hoisted(() => ({ slugs: [] as string[] }));

vi.mock("../osm-admin/region.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../osm-admin/region.service")>();
  return {
    ...actual,
    suggestForCoord: async () => ({
      slug: "europe/italy/nord-est",
      pbfUrl: "https://example.com/ne.pbf",
      pbfSizeMb: 900,
      autoApprove: false,
    }),
    createPending: async (slug: string) => {
      requested.slugs.push(slug);
      return { slug, status: "pending_approval" as const, created: true };
    },
  };
});

import { createTripPlan, planPendingTrip } from "./plans";

/** The imported shore and the one across the water. */
const WEST_SHORE = { lat: 45.8, lon: 10.70 };
const EAST_SHORE = { lat: 45.8, lon: 10.90 };
const WEST_DB = "nom_europe_italy_nord_ovest";

function spot(n: number, at: { lat: number; lon: number }): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: at.lat + (n % 5) * 0.002,
    lon: at.lon + Math.floor(n / 5) * 0.002,
    distanceM: null,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
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

/** Which extract holds which shore — what the real index knows. */
function lakeIndex() {
  setRegionIndexSource({
    containing: async (_lat, lon) =>
      lon < 10.8 ? ["europe", "europe/italy", "europe/italy/nord-ovest"]
                 : ["europe", "europe/italy", "europe/italy/nord-est"],
  });
}

const stopCount = (p: { legs: { days: { blocks: { stops: unknown[] }[] }[] }[] }) =>
  p.legs.reduce((n, leg) =>
    n + leg.days.reduce((m, d) =>
      m + d.blocks.reduce((k, b) => k + b.stops.length, 0), 0), 0);

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  requested.slugs.length = 0;
  const [user] = await db
    .insert(users)
    .values({ email: `shore-${Date.now()}@test.invalid`, name: "P", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
  // The west shore's region, with a rectangle reaching across the lake.
  await db.insert(osmRegionImports).values({
    slug: "europe/italy/nord-ovest",
    geofabrik_url: "https://example.com/no.pbf",
    postgres_db: WEST_DB,
    bbox_min_lat: 45.0,
    bbox_min_lon: 7.0,
    bbox_max_lat: 46.7,
    bbox_max_lon: 11.5,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  // Its data: the west shore only. The probe finds these within 25 km
  // of the east shore too, which is the whole problem.
  geo.setSearchSpots(WEST_DB, Array.from({ length: 12 }, (_, i) => spot(i + 1, WEST_SHORE)));
  setGeoClient(geo);
  lakeIndex();
  return () => {
    resetGeoClient();
    setRegionIndexSource(null);
  };
});

describe("a trip on the far shore", () => {
  it("waits for its own region instead of being planned from across the water", async () => {
    const { plan, pendingRegions } = await createTripPlan({
      legs: [{ anchor: EAST_SHORE, days: 2, mode: "car" }],
      detailDays: 2,
    });

    // Not a single spot from the other shore, and the trip says why.
    expect(stopCount(plan)).toBe(0);
    expect(plan.legs[0].awaitingRegion).toBe(true);
    expect(pendingRegions?.map((r) => r.slug)).toEqual(["europe/italy/nord-est"]);
    expect(requested.slugs).toEqual(["europe/italy/nord-est"]);
  });

  it("is planned from the imported shore when it is on it", async () => {
    const { plan, pendingRegions } = await createTripPlan({
      legs: [{ anchor: WEST_SHORE, days: 1, mode: "car" }],
      detailDays: 1,
    });

    expect(stopCount(plan)).toBeGreaterThan(0);
    expect(plan.legs[0].awaitingRegion).toBe(false);
    expect(pendingRegions ?? []).toEqual([]);
  });

  it("asks for the region when an older plan is filled in, rather than only waiting", async () => {
    // A plan made while the router still took the neighbour for this
    // shore. Its owner presses "Jetzt nachsehen": the answer must start
    // the import, not describe one that nobody started.
    setRegionIndexSource(null);
    const { plan } = await createTripPlan({
      legs: [{ anchor: EAST_SHORE, days: 1, mode: "car" }],
      detailDays: 1,
    });
    expect(plan.legs[0].awaitingRegion).toBe(false);
    expect(requested.slugs).toEqual([]);

    lakeIndex();
    clearRouterCache();
    await expect(planPendingTrip({ planId: plan.id })).rejects.toThrow(/nord-est/);
    expect(requested.slugs).toEqual(["europe/italy/nord-est"]);
  });
});
