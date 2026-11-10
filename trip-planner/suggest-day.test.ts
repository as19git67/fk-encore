/**
 * The spot picker's "+ Tag n" and "In diesem Bereich suchen"
 * (reise-planen-und-unterwegs.md, stage 4).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { suggestDay, suggestTripDay } from "./suggest-day";
import { tripHighlights } from "./highlights";
import { searchPlaces } from "./search";
import { parseSearchArea, MAX_AREA_RADIUS_M, MIN_AREA_RADIUS_M } from "./search-area";

const TOWN = { lat: 48.37, lon: 10.9 };

function spot(n: number, opts: { famous?: boolean } = {}): GeoPoiSearchSpot {
  const famous = opts.famous ?? true;
  return {
    osmRef: `node:${n}`, type: "node", id: n, lat: TOWN.lat + n * 0.002, lon: TOWN.lon, distanceM: 10, detourM: null,
    name: `Beispielplatz ${n}`, nameDe: null, nameEn: null,
    kind: famous ? "tourism=museum" : "amenity=bench",
    categories: ["museum"],
    wikidataQid: famous ? `Q${n}` : null, wikipedia: famous ? `de:Beispiel ${n}` : null,
    openingHours: n === 2 ? "Fr 10:00-18:00" : null, cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

const block = (id = "b0") => [{ id, kind: "spots" }];

describe("the day a place would go to", () => {
  const dates = { startDate: "2030-09-05", today: "2030-09-01" }; // a Thursday

  it("is the first day with room", () => {
    const days = [
      { dayIndex: 0, blocks: block(), freeMinutes: 20 },
      { dayIndex: 1, blocks: block("b1"), freeMinutes: 200 },
    ];
    expect(suggestDay(days, { dwellMinutes: 60, openingHours: null }, dates))
      .toEqual({ dayIndex: 1, blockId: "b1", full: false });
  });

  it("skips a day the place is closed, and a day that is over", () => {
    const days = [0, 1, 2].map((dayIndex) => ({ dayIndex, blocks: block(`b${dayIndex}`), freeMinutes: 300 }));
    // Open on Fridays only: the second day.
    expect(suggestDay(days, { dwellMinutes: 60, openingHours: "Fr 10:00-18:00" }, dates).dayIndex).toBe(1);
    // Hours nobody understands are not "closed".
    expect(suggestDay(days, { dwellMinutes: 60, openingHours: "nach Absprache" }, dates).dayIndex).toBe(0);
    expect(suggestDay(days, { dwellMinutes: 60, openingHours: null }, { ...dates, today: "2030-09-06" }).dayIndex)
      .toBe(1);
  });

  it("falls back to the open day with the most time left, marked full", () => {
    const days = [
      { dayIndex: 0, blocks: block(), freeMinutes: 10 },
      { dayIndex: 1, blocks: block("b1"), freeMinutes: 40 },
    ];
    expect(suggestDay(days, { dwellMinutes: 90, openingHours: null }, dates))
      .toEqual({ dayIndex: 1, blockId: "b1", full: true });
    expect(suggestDay([], { dwellMinutes: 90, openingHours: null }, dates))
      .toEqual({ dayIndex: null, blockId: null, full: false });
  });

  it("reads a day without a clock as having room, and a trip without a date as never closed", () => {
    const days = [{ dayIndex: 0, blocks: block() }];
    expect(suggestDay(days, { dwellMinutes: 600, openingHours: "Fr 10:00-18:00" }, { startDate: null, today: null }))
      .toEqual({ dayIndex: 0, blockId: "b0", full: false });
  });
});

describe("the search area", () => {
  it("is clamped and checked", () => {
    expect(parseSearchArea(undefined)).toBeNull();
    expect(parseSearchArea({ lat: 1, lon: 2, radiusM: 10 })!.radiusM).toBe(MIN_AREA_RADIUS_M);
    expect(parseSearchArea({ lat: 1, lon: 2, radiusM: 1e9 })!.radiusM).toBe(MAX_AREA_RADIUS_M);
    expect(() => parseSearchArea({ lat: 91, lon: 2, radiusM: 500 })).toThrow(/lat and lon/);
    expect(() => parseSearchArea({ lat: 1, lon: 2, radiusM: 0 })).toThrow(/radiusM/);
  });
});

describe("the picker against a trip", () => {
  beforeEach(async () => {
    await db.delete(tripPlans);
    await db.delete(osmRegionImports);
    clearRouterCache();
    const [user] = await db
      .insert(users)
      .values({ email: `suggest-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
    await db.insert(osmRegionImports).values({
      slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
      bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
    });
    const geo = new InMemoryGeoClient();
    geo.setSearchSpots("nom_west", [spot(1), spot(2), spot(3), spot(4), spot(5, { famous: false })]);
    setGeoClient(geo);
    return () => resetGeoClient();
  });

  async function trip() {
    const { plan } = await createTripPlan({
      startEmpty: true,
      legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate: "2030-09-05" }],
    });
    return plan;
  }

  it("suggests the day the place is open, and takes an idea's own duration", async () => {
    const plan = await trip();
    const { suggestions } = await suggestTripDay({
      planId: plan.id,
      legIndex: 0,
      spots: [
        { osmRef: "node:1", category: "museum" },
        { osmRef: "node:2", openingHours: "Fr 10:00-18:00" },
      ],
    });
    expect(suggestions.map((s) => s.dayIndex)).toEqual([0, 1]);
    expect(suggestions.every((s) => s.blockId !== null && !s.full)).toBe(true);

    // A day filled past its window sends the next place to the day after.
    await addFind({ planId: plan.id, lat: TOWN.lat + 0.001, lon: TOWN.lon, name: "Beispielmarkt", dwellMinutes: 590 });
    const current = (await getTripPlan({ planId: plan.id })).plan;
    const market = current.legs[0].pool.find((c) => c.name === "Beispielmarkt")!;
    await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: market.osmRef });
    const after = await suggestTripDay({ planId: plan.id, legIndex: 0, spots: [{ osmRef: "node:3", dwellMinutes: 60 }] });
    expect(after.suggestions[0]).toMatchObject({ dayIndex: 1, full: false });
  });

  it("searches the map's area instead of the stay's reach", async () => {
    const plan = await trip();
    const area = { lat: TOWN.lat + 4 * 0.002, lon: TOWN.lon, radiusM: 300 };
    const res = await tripHighlights({ planId: plan.id, legIndex: 0, area });
    expect(res.results.map((r) => r.osmRef).sort()).toEqual(["node:3", "node:4"]);
    expect(res.sorting).toBe(false);
    // Still how far out of the way, from the lodging.
    expect(res.results.find((r) => r.osmRef === "node:4")!.distanceM).toBeGreaterThan(800);
    expect(res.results.find((r) => r.osmRef === "node:2")).toBeUndefined();

    const all = await tripHighlights({ planId: plan.id, legIndex: 0 });
    expect(all.results.find((r) => r.osmRef === "node:2")!.openingHours).toBe("Fr 10:00-18:00");

    const named = await searchPlaces({ planId: plan.id, legIndex: 0, query: "Beispielplatz", area });
    expect(named.results.map((r) => r.osmRef).sort()).toEqual(["node:3", "node:4", "node:5"]);
    expect(named.results.find((r) => r.osmRef === "node:4")!.distanceM).toBeGreaterThan(800);
  });
});
