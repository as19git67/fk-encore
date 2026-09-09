/**
 * The plan the phone can keep (§3.9).
 *
 * What these tests hold onto is mostly what the bundle must *not* do:
 * it must not need a second request to be complete, it must not claim
 * light for a day the trip has no date for, and it must not hand out
 * somebody else's trip. The pleasant part — that a coarse plan is
 * fully usable offline — needs no test; it is a property of §4.1.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { offlineBundle } from "./bundle";
import { createTripPlan } from "./plans";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 40) * 2 * Math.PI;
  const radiusM = 400;
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: ANCHOR.lat + (radiusM * Math.cos(angle)) / 111_320,
    lon:
      ANCHOR.lon +
      (radiusM * Math.sin(angle)) / (111_320 * Math.cos((ANCHOR.lat * Math.PI) / 180)),
    distanceM: radiusM,
    detourM: null,
    name: `Sehenswürdigkeit ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
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
  };
}

let ownerId = 0;
let strangerId = 0;

async function makeUser(email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name: "Reisende", password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  ownerId = await makeUser(`bundle-${stamp}@test.invalid`);
  strangerId = await makeUser(`fremd-${stamp}@test.invalid`);
  actAs(ownerId);

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
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 40 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function datedTrip(days = 3) {
  const { plan } = await createTripPlan({
    legs: [{ anchor: ANCHOR, days, startDate: "2026-06-18" }],
  });
  return plan;
}

describe("the offline bundle", () => {
  it("carries the whole plan in one answer", async () => {
    const plan = await datedTrip();

    const bundle = await offlineBundle({ planId: plan.id });

    expect(bundle.plan.id).toBe(plan.id);
    expect(bundle.plan.legs[0].days).toHaveLength(3);
    // The pool travels with it: "was fällt aus, wenn etwas ausfällt"
    // has to be answerable without a connection (§5).
    expect(bundle.plan.legs[0].pool.length).toBeGreaterThan(0);
    const stops = bundle.plan.legs[0].days[0].blocks.flatMap((b) => b.stops);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s.name !== null && s.name !== undefined)).toBe(true);
  });

  it("brings the light of every detailed day along", async () => {
    const plan = await datedTrip();

    const bundle = await offlineBundle({ planId: plan.id, utcOffsetMinutes: 120 });

    // Two days are detailed at creation (§4.3); the third is a frame,
    // and light over a day with no stops is weight without a reader.
    expect(bundle.light.map((d) => d.dayIndex)).toEqual([0, 1]);
    expect(bundle.light[0].date).toBe("2026-06-18");
    expect(bundle.light[0].light.windows.length).toBeGreaterThan(0);
    expect(bundle.light[0].light.spots.length).toBeGreaterThan(0);
  });

  it("says nothing about the sun when the trip has no date", async () => {
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2 });

    const bundle = await offlineBundle({ planId: plan.id });

    expect(bundle.light).toEqual([]);
    expect(bundle.plan.legs[0].days.length).toBe(2);
  });

  it("is honest about what it leaves out", async () => {
    const plan = await datedTrip();

    const bundle = await offlineBundle({ planId: plan.id });

    // §14: no map offline, and a stale forecast is worse than none.
    expect(bundle.omits).toEqual(["weather", "map"]);
  });

  it("stamps itself, so the phone can say how old it is", async () => {
    const before = Date.now();
    const plan = await datedTrip();

    const bundle = await offlineBundle({ planId: plan.id });

    expect(Date.parse(bundle.generatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("refuses an offset no clock could show", async () => {
    const plan = await datedTrip();

    await expect(
      offlineBundle({ planId: plan.id, utcOffsetMinutes: 7200 }),
    ).rejects.toThrow(/utcOffsetMinutes/);
  });

  it("does not hand a trip to somebody who is not on it", async () => {
    const plan = await datedTrip();
    actAs(strangerId);

    await expect(offlineBundle({ planId: plan.id })).rejects.toThrow(/not found/);
  });

  it("says so plainly when the plan is gone", async () => {
    await expect(offlineBundle({ planId: 987654 })).rejects.toThrow(/not found/);
  });
});
