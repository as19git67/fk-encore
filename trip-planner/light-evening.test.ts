/**
 * "Als Abendtermin einplanen?" (§7.3)
 *
 * The proposal is the one place where a minute-accurate window may
 * become a time somebody can miss — so the cases that matter are the
 * ones where it stays quiet: nothing marked, nothing after the day
 * ends, and nothing worth a trip out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { eveningLight } from "./light-evening";
import { loadPlan } from "./plan-store";
import { createTripPlan } from "./plans";
import { saveTripSpotNote } from "./spot-notes";

/** Munich in July: the sun sets late, so the evening is a real one. */
const MUNICH = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";
const START = "2027-07-01";

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0002,
    lon: MUNICH.lon,
    distanceM: n * 22,
    detourM: null,
    name: `Aussichtsterrasse ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=viewpoint",
    categories: ["viewpoint"],
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
    // A west-facing facade: front-lit in the evening (§7.3).
    facadeAzimuth: 270,
  };
}

let ownerId = 0;

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

async function trip() {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate: START, days: 1 }],
  });
  return plan;
}

/** Mark a spot as one the group comes to for the light (§7.3). */
async function markPhotoStop(planId: number, osmRef: string) {
  await saveTripSpotNote({ planId, legIndex: 0, osmRef, photoStop: true });
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [row] = await db
    .insert(users)
    .values({ email: `licht-${stamp}@test.invalid`, name: "Fotografin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  actAs(ownerId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("the evening proposal", () => {
  it("says nothing when nobody marked a photo stop", async () => {
    // The ordinary case, and the one that keeps this from being a nag.
    const plan = await trip();

    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposals).toEqual([]);
  });

  it("names the spot, the window and what the sun does to it", async () => {
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const anySpot = stored!.legs[0].pool[0] ?? stored!.legs[0].days[0].blocks
      .flatMap((b) => b.stops)[0];
    await markPhotoStop(plan.id, anySpot.osmRef);

    const { proposals, date } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(date).toBe(START);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].sentence).toContain("Als Abendtermin einplanen?");
    expect(proposals[0].sentence).toContain("ca.");
    expect(["golden", "blue"]).toContain(proposals[0].kind);
    expect(proposals[0].label).not.toBe(proposals[0].osmRef);
  });

  it("offers one evening at a time, not a list", async () => {
    // One evening holds one outing; five proposals would be a decision,
    // and this is a hint (§7.3).
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const refs = [
      ...stored!.legs[0].pool.map((c) => c.osmRef),
      ...stored!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef)),
    ].slice(0, 4);
    for (const ref of refs) await markPhotoStop(plan.id, ref);

    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposals.length).toBeLessThanOrEqual(1);
  });

  it("says nothing about a trip without dates", async () => {
    // No date, no sun — and guessing one moves the day by however far
    // the guess was wrong.
    const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });

    const { date, proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(date).toBeNull();
    expect(proposals).toEqual([]);
  });

  it("refuses a day that is not in the trip", async () => {
    const plan = await trip();

    await expect(eveningLight({ planId: plan.id, dayIndex: 9, utcOffsetMinutes: 120 }))
      .rejects.toThrow(/day 9 not found/);
  });

  it("does not open somebody else's trip", async () => {
    const plan = await trip();
    const [other] = await db
      .insert(users)
      .values({
        email: `fremd-${Date.now()}${Math.random()}@test.invalid`,
        name: "Fremde",
        password_hash: "x",
      })
      .returning({ id: users.id });
    actAs(other.id);

    await expect(eveningLight({ planId: plan.id })).rejects.toThrow(/plan not found/);
  });

  it("leaves the plan alone — it only says a sentence", async () => {
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const before = stored!.legs[0].days[0].fixpoints.length;
    const anySpot = stored!.legs[0].pool[0] ?? stored!.legs[0].days[0].blocks
      .flatMap((b) => b.stops)[0];
    await markPhotoStop(plan.id, anySpot.osmRef);

    await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    // The proposal is a sentence: no fixpoint, no re-plan. A time
    // somebody can miss exists only once a person accepts it (§7.3).
    const after = await loadPlan(plan.id, ownerId);
    expect(after!.legs[0].days[0].fixpoints).toHaveLength(before);
    const stops = after!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(stops).toEqual(
      stored!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
  });
});
