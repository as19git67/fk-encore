/**
 * What a day left behind (§5): the stops nobody reached go back to
 * the pool with a head start, the diary stays as it is.
 *
 * Coordinates sit near a river town in Bavaria; every place is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { carryOver, carryOverDay } from "./carry-over";
import { createTripPlan, setTripStopStatus } from "./plans";
import { DISPLACEMENT_BOOST, type CurrentBlock, type CurrentStop } from "./redistribute";
import type { Candidate } from "./solver";
import { walkingLeg } from "./travel";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

function north(metres: number) {
  return { lat: ANCHOR.lat + metres / 111_320, lon: ANCHOR.lon };
}

function stop(ref: string, metres: number, over: Partial<CurrentStop> = {}): CurrentStop {
  const at = north(metres);
  return {
    osmRef: ref, name: ref, lat: at.lat, lon: at.lon, category: "sight",
    dwellMinutes: 30, score: 2, travelFromPrevious: walkingLeg(ANCHOR, at),
    status: "planned", pinned: false, ...over,
  };
}

function candidate(ref: string, metres: number, over: Partial<Candidate> = {}): Candidate {
  const at = north(metres);
  return { osmRef: ref, name: ref, lat: at.lat, lon: at.lon, category: "sight", dwellMinutes: 30, score: 2, ...over };
}

function block(id: string, stops: CurrentStop[]): CurrentBlock {
  return { id, label: id, kind: "spots", budgetMinutes: 210, usedMinutes: 60, stops };
}

describe("carrying a day over", () => {
  it("returns what was not reached to the pool, ahead of the rest", () => {
    const morning = block("morning", [stop("node:a", 200), stop("node:done", 300, { status: "done" })]);
    const afternoon = block("afternoon", [stop("node:b", 400, { pinned: true }), stop("node:skip", 500, { status: "skipped" })]);

    const { blocks, pool, carried } = carryOver([morning, afternoon], [candidate("node:c", 600)]);

    expect(blocks.map((b) => b.stops.map((s) => s.osmRef))).toEqual([["node:done"], ["node:skip"]]);
    expect(blocks.every((b) => b.usedMinutes === 0)).toBe(true);
    expect(carried.map((c) => c.osmRef).sort()).toEqual(["node:a", "node:b"]);
    // Boosted, so they come first when the next day is planned.
    expect(pool.map((c) => c.osmRef)).toEqual(["node:a", "node:b", "node:c"]);
    expect(pool[0].score).toBe(2 + DISPLACEMENT_BOOST);
    expect(pool[2].score).toBe(2);
  });

  it("boosts a stop the pool already knows rather than doubling it", () => {
    const { pool } = carryOver(
      [block("morning", [stop("node:a", 200, { score: 1 })])],
      [candidate("node:a", 200, { score: 3 })],
    );
    expect(pool).toHaveLength(1);
    expect(pool[0].score).toBe(3 + DISPLACEMENT_BOOST);
  });

  it("has nothing to carry from a day that was lived", () => {
    const { blocks, pool, carried } = carryOver(
      [block("morning", [stop("node:a", 200, { status: "done" })])],
      [candidate("node:c", 600)],
    );
    expect(carried).toEqual([]);
    expect(blocks[0].stops).toHaveLength(1);
    expect(pool.map((c) => c.osmRef)).toEqual(["node:c"]);
  });
});

function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 12) * 2 * Math.PI;
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (400 * Math.cos(angle)) / 111_320,
    lon: ANCHOR.lon + (400 * Math.sin(angle)) / (111_320 * Math.cos((ANCHOR.lat * Math.PI) / 180)),
    distanceM: 400,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
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
  } as GeoPoiSearchSpot;
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `carry-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({ userID: String(ownerId), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: DB,
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.2,
    status: "ready_running",
  });
  geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("POST /trip-planner/plans/:planId/days/carry-over", () => {
  it("moves the day's open stops into the leg's pool and says which", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });
    const stops = plan.legs[0].days[0].blocks.flatMap((b) => b.stops);
    expect(stops.length).toBeGreaterThan(1);
    // One was actually seen; it stays.
    await setTripStopStatus({ planId: plan.id, stopId: stops[0].rowId, status: "done" });

    const res = await carryOverDay({ planId: plan.id, dayIndex: 0 });

    const after = res.plan.legs[0].days[0].blocks.flatMap((b) => b.stops);
    expect(after.map((s) => s.osmRef)).toEqual([stops[0].osmRef]);
    expect(after[0].status).toBe("done");
    expect(res.carried.map((c) => c.osmRef).sort())
      .toEqual(stops.slice(1).map((s) => s.osmRef).sort());
    // And they are in the pool with their head start: the stop's own
    // score plus the boost, which is what puts them first when the next
    // day is planned.
    const pool = new Map(res.plan.legs[0].pool.map((c) => [c.osmRef, c.score]));
    for (const stop of stops.slice(1)) {
      expect(pool.get(stop.osmRef)).toBeCloseTo(stop.score + DISPLACEMENT_BOOST, 5);
    }
    // The other day is untouched.
    expect(res.plan.legs[0].days[1].blocks.flatMap((b) => b.stops).length)
      .toBe(plan.legs[0].days[1].blocks.flatMap((b) => b.stops).length);
  });

  it("refuses a day that is not there", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 1 });
    await expect(carryOverDay({ planId: plan.id, dayIndex: 4 })).rejects.toMatchObject({ code: "not_found" });
  });
});
