/**
 * What the corridor endpoint does around the geo search.
 *
 * The ellipse itself is geo's business and is tested there against a
 * real PostGIS (geo/src/poi-corridor.test.ts). What is this endpoint's
 * own is everything either side of that call: choosing a region for a
 * journey with two ends, forwarding the corridor rather than a radius,
 * and keeping each spot's detour attached to it through scoring — a
 * corridor result without detours is just a list of places.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { planCorridor } from "./corridor";

/** Invented places on an invented road near Augsburg. */
const FROM = { lat: 48.3, lon: 10.9 };
const TO = { lat: 48.3, lon: 11.2 };

async function seedRegion(slug: string, bbox: [number, number, number, number]) {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_" + slug.replace(/[^a-z0-9]/g, "_"),
    bbox_min_lat: bbox[0],
    bbox_min_lon: bbox[1],
    bbox_max_lat: bbox[2],
    bbox_max_lon: bbox[3],
    status: "ready_running",
  });
}

function spot(overrides: Partial<GeoPoiSearchSpot> = {}): GeoPoiSearchSpot {
  return {
    osmRef: "node:1",
    type: "node",
    id: 1,
    lat: 48.3,
    lon: 11.0,
    distanceM: null,
    detourM: 0,
    name: "Museum am Weg",
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
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
    ...overrides,
  };
}

let geo: InMemoryGeoClient;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["photos.view"] });
  await db.delete(osmRegionImports);
  clearRouterCache();
  geo = new InMemoryGeoClient();
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/corridor", () => {
  it("asks geo for a corridor, not a radius", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 13.5]);
    geo.setSearchSpots("nom_europe_germany_bayern", [spot()]);

    await planCorridor({ from: FROM, to: TO, detourBudgetM: 3_000 });

    const [call] = geo.getSearchCalls();
    expect(call.postgresDb).toBe("nom_europe_germany_bayern");
    expect(call.query.corridor).toEqual({ from: FROM, to: TO, detourBudgetM: 3_000 });
    expect(call.query.center).toBeUndefined();
  });

  it("keeps each spot's detour attached through scoring", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 13.5]);
    geo.setSearchSpots("nom_europe_germany_bayern", [
      spot({ osmRef: "node:1", detourM: 12.4 }),
      spot({ osmRef: "node:2", id: 2, detourM: 640.6, name: "Burg Beispielstein" }),
    ]);

    const res = await planCorridor({ from: FROM, to: TO });

    expect(res.spots.map((s) => [s.osmRef, s.detourM])).toEqual([
      ["node:1", 12],
      ["node:2", 641],
    ]);
    // Scoring still happened — this is a planner result, not a raw list.
    expect(res.spots[0].dwellMinutes).toBeGreaterThan(0);
    expect(res.spots[0].reasons).toBeDefined();
  });

  it("reports the direct distance the budget is measured against", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 13.5]);
    geo.setSearchSpots("nom_europe_germany_bayern", []);

    const res = await planCorridor({ from: FROM, to: TO });

    // 0.3° of longitude at 48.3° N is a little over 22 km.
    expect(res.directDistanceM).toBeGreaterThan(21_000);
    expect(res.directDistanceM).toBeLessThan(23_000);
    expect(res.detourBudgetM).toBe(5_000);
  });

  it("refuses a journey whose ends fall in different imported regions", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 11.0]);
    await seedRegion("europe/austria", [47.5, 11.0, 50.5, 13.5]);

    await expect(planCorridor({ from: FROM, to: TO })).rejects.toThrow(
      /crosses region boundaries/,
    );
  });

  it("says which end is not covered rather than returning half a corridor", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 11.0]);

    await expect(planCorridor({ from: FROM, to: TO })).rejects.toThrow(/destination/);
    await expect(planCorridor({ from: TO, to: FROM })).rejects.toThrow(/start/);
  });

  it("rejects a budget large enough to be a second destination", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 13.5]);
    await expect(
      planCorridor({ from: FROM, to: TO, detourBudgetM: 500_000 }),
    ).rejects.toThrow(/at most/);
  });

  it("rejects a journey too long to be a transfer", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 13.5]);
    await expect(
      planCorridor({ from: FROM, to: { lat: 35.68, lon: 139.69 } }),
    ).rejects.toThrow(/at most/);
  });

  it("rejects coordinates that are not coordinates", async () => {
    await expect(
      planCorridor({ from: { lat: 91, lon: 10.9 }, to: TO }),
    ).rejects.toThrow(/from.lat/);
    await expect(
      planCorridor({ from: FROM, to: { lat: 48.3, lon: 200 } }),
    ).rejects.toThrow(/to.lon/);
  });
});
