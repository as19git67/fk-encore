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
import { corridorBox, corridorCandidates, corridorStretches, planCorridor } from "./corridor";
import { encodeLine, InMemoryRouterClient } from "./router-client.test-helper";
import { setRouterClient } from "./router-client";
import { pathsBox } from "./route-corridor";

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

  it("searches both regions when the journey crosses from one into another", async () => {
    await seedRegion("europe/germany/bayern", [47.5, 9, 50.5, 11.0]);
    await seedRegion("europe/austria", [47.5, 11.0, 50.5, 13.5]);
    geo.setSearchSpots("nom_europe_germany_bayern", [spot({ osmRef: "node:1", detourM: 300 })]);
    geo.setSearchSpots("nom_europe_austria", [
      spot({ osmRef: "node:2", id: 2, lon: 11.1, detourM: 100, name: "Burg Beispielstein" }),
      // On the border, in both extracts: one place.
      spot({ osmRef: "node:1", detourM: 300 }),
    ]);

    const res = await planCorridor({ from: FROM, to: TO });

    expect(res.regions).toEqual(["nom_europe_germany_bayern", "nom_europe_austria"]);
    expect(geo.getSearchCalls().map((c) => c.postgresDb).sort())
      .toEqual(["nom_europe_austria", "nom_europe_germany_bayern"]);
    // Merged, each place once, least detour first.
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:2", "node:1"]);
  });

  it("searches a region the corridor crosses without touching either end", async () => {
    // Home in the west, the coast in the east, and a third extract
    // between them that contains neither end but the road through it.
    const home = { lat: 48.3, lon: 9.0 };
    const coast = { lat: 48.3, lon: 12.0 };
    await seedRegion("europe/west", [47.5, 8.0, 50.5, 9.5]);
    await seedRegion("europe/middle", [47.5, 9.5, 50.5, 11.5]);
    await seedRegion("europe/east", [47.5, 11.5, 50.5, 13.0]);
    // Far off to the side: its rectangle never meets the corridor.
    await seedRegion("europe/north", [52.0, 8.0, 55.0, 13.0]);
    geo.setSearchSpots("nom_europe_middle", [
      spot({ osmRef: "node:7", id: 7, lon: 10.5, detourM: 400, name: "Kloster am Weg" }),
    ]);

    const res = await planCorridor({ from: home, to: coast });

    expect(res.regions).toEqual(["nom_europe_west", "nom_europe_east", "nom_europe_middle"]);
    expect(geo.getSearchCalls().map((c) => c.postgresDb).sort())
      .toEqual(["nom_europe_east", "nom_europe_middle", "nom_europe_west"]);
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:7"]);
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

describe("corridorBox", () => {
  it("wraps the ellipse: half the minor axis all round the ends", () => {
    // 100 km east-west at 48°, budget 10 km: the ellipse reaches
    // √(10·210)/2 ≈ 22.9 km to either side and 5 km past either end.
    const box = corridorBox({ lat: 48, lon: 10 }, { lat: 48, lon: 11.345 }, 10_000);
    const padLat = (box.maxLat - 48) * 111_195;
    expect(padLat).toBeGreaterThan(22_000);
    expect(padLat).toBeLessThan(24_000);
    expect(box.minLat).toBeCloseTo(48 - (box.maxLat - 48), 9);
    // Longitude is padded in metres too, so it is wider in degrees.
    expect(box.maxLon - 11.345).toBeGreaterThan(box.maxLat - 48);
    expect(box.minLon).toBeLessThan(10);
  });

  it("is at least the ends themselves for a journey with no length", () => {
    const box = corridorBox({ lat: 48, lon: 10 }, { lat: 48, lon: 10 }, 2_000);
    expect(box.maxLat).toBeGreaterThan(48);
    expect(box.minLon).toBeLessThan(10);
  });
});

describe("corridorStretches", () => {
  it("is one stretch for a transfer between two cities", () => {
    expect(corridorStretches(FROM, TO)).toEqual([{ from: FROM, to: TO }]);
  });

  it("cuts a day's drive into stretches geo will take, end to end", () => {
    // 424 km east along the 48th parallel: two stretches, meeting in
    // the middle, the second ending where the journey ends.
    const far = { lat: 48.3, lon: 16.62 };
    const stretches = corridorStretches(FROM, far);
    expect(stretches).toHaveLength(2);
    expect(stretches[0].from).toEqual(FROM);
    expect(stretches[0].to).toEqual(stretches[1].from);
    expect(stretches[1].to).toEqual(far);
    expect(stretches[0].to.lon).toBeCloseTo((FROM.lon + far.lon) / 2, 6);
  });
});

describe("corridorCandidates on a long journey", () => {
  it("searches stretch by stretch and finds the abbey halfway", async () => {
    // Geo refuses one ellipse of 424 km (the in-memory client refuses
    // the same); the journey has to reach it in pieces.
    const far = { lat: 48.3, lon: 16.62 };
    geo.setSearchSpots("nom_x", [
      spot({ osmRef: "node:5", id: 5, lon: 13.76, detourM: 800, name: "Kloster Beispielau" }),
      spot({ osmRef: "node:6", id: 6, lon: 16.3, detourM: 200, name: "Burg am Ziel" }),
    ]);

    const found = await corridorCandidates(["nom_x"], FROM, far, { detourBudgetM: 30_000 });

    expect(geo.getSearchCalls()).toHaveLength(2);
    expect(found.map((s) => s.osmRef)).toEqual(["node:6", "node:5"]);
  });
});

describe("the corridor along the road (§24, stage 2)", () => {
  // The road from FROM to TO swings 8 km north through the valley; the
  // straight line is where nobody drives.
  const BEND = { lat: FROM.lat + 0.072, lon: 11.05 };
  let router: InMemoryRouterClient;

  beforeEach(async () => {
    await seedRegion("europe/x", [48.0, 10.5, 48.7, 11.6]);
    router = new InMemoryRouterClient();
    router.shapes = [encodeLine([FROM, BEND, TO])];
    setRouterClient(router);
    geo.setSearchSpots("nom_europe_x", [
      // On the road, at the bend.
      spot({ osmRef: "node:1", id: 1, lat: BEND.lat, lon: BEND.lon, name: "Kloster im Tal" }),
      // On the straight line, 8 km from the road: the ellipse's favourite.
      spot({ osmRef: "node:2", id: 2, lat: FROM.lat, lon: 11.05, name: "Museum an der Luftlinie" }),
      // A kilometre off the road.
      spot({ osmRef: "node:3", id: 3, lat: BEND.lat + 0.009, lon: BEND.lon, name: "Burg überm Tal" }),
    ]);
    return () => setRouterClient(null);
  });

  it("searches along the road and measures the detour the car drives", async () => {
    const res = await planCorridor({ from: FROM, to: TO, detourBudgetM: 10_000, mode: "car" });
    expect(res.source).toBe("router");
    expect(res.spots.map((s) => s.osmRef)).toEqual(["node:1", "node:3"]);
    // Geo was asked along the road, not for an ellipse.
    const calls = geo.getSearchCalls();
    expect(calls.every((c) => c.query.path !== undefined && c.query.corridor === undefined)).toBe(true);
    expect(calls[0].query.path?.widthM).toBe(5_000);
    // Two matrices: origin → stops, stops → destination.
    expect(router.matrixCalls.map((c) => [c.sources, c.targets])).toEqual([[1, 2], [2, 1]]);
    expect(res.spots[0].detourM).toBeLessThan(res.spots[1].detourM);
  });

  it("falls back to the ellipse when the router is away, and says so", async () => {
    router.reachable = false;
    const res = await planCorridor({ from: FROM, to: TO, detourBudgetM: 10_000, mode: "car" });
    expect(res.source).toBe("estimate");
    expect(res.spots.map((s) => s.osmRef)).toContain("node:2");
    expect(geo.getSearchCalls().every((c) => c.query.corridor !== undefined)).toBe(true);
  });

  it("asks for the roads only with a mode, and never for one the router cannot route", async () => {
    const without = await planCorridor({ from: FROM, to: TO, detourBudgetM: 10_000 });
    expect(without.source).toBe("estimate");
    const byTrain = await planCorridor({ from: FROM, to: TO, detourBudgetM: 10_000, mode: "transit" });
    expect(byTrain.source).toBe("estimate");
    expect(router.routeCalls).toEqual(["transit"]);
  });

  it("boxes the regions around the roads, widened by the corridor", () => {
    const box = pathsBox([[FROM, BEND, TO]], 5_000);
    expect(box.maxLat).toBeGreaterThan(BEND.lat + 0.04);
    expect(box.minLat).toBeLessThan(FROM.lat - 0.04);
    expect(box.minLon).toBeLessThan(FROM.lon);
    expect(box.maxLon).toBeGreaterThan(TO.lon);
  });
});
