/**
 * Dragging and pinning, at the endpoint (§8.4).
 *
 * The arithmetic is covered in move.test.ts. What is this endpoint's own
 * is everything around it: finding the stop the app named by row id,
 * refusing the moves that would quietly produce a wrong plan, writing
 * both days back, and reporting which blocks went red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, moveTripStop, pinTripStop } from "./plans";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

/** Spots on a small circle, so everything stays walkable. */
function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 24) * 2 * Math.PI;
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

let geo: InMemoryGeoClient;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `move-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
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
  geo.setSearchSpots(DB, Array.from({ length: 24 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** A two-day plan, both days planned down to spots. */
async function twoPlannedDays() {
  const { plan } = await createTripPlan({ anchor: ANCHOR, days: 2, detailDays: 2 });
  return plan;
}

const blocksOf = (plan: Awaited<ReturnType<typeof twoPlannedDays>>, day: number) =>
  plan.legs[0].days[day].blocks;

describe("POST /trip-planner/plans/:planId/stops/move", () => {
  it("moves a spot to another block of the same day", async () => {
    const plan = await twoPlannedDays();
    const morning = blocksOf(plan, 0).find((b) => b.id === "morning")!;
    const target = morning.stops[0];

    const res = await moveTripStop({
      planId: plan.id,
      stopId: target.rowId,
      toDayIndex: 0,
      toBlockId: "afternoon",
      toPosition: 0,
    });

    const after = res.plan.legs[0].days[0].blocks;
    expect(after.find((b) => b.id === "morning")!.stops.map((s) => s.osmRef))
      .not.toContain(target.osmRef);
    expect(after.find((b) => b.id === "afternoon")!.stops[0].osmRef).toBe(target.osmRef);
  });

  it("moves a spot to another day", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];

    const res = await moveTripStop({
      planId: plan.id,
      stopId: target.rowId,
      toDayIndex: 1,
      toBlockId: "morning",
      toPosition: 0,
    });

    const day0 = res.plan.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    const day1 = res.plan.legs[0].days[1].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(day0).not.toContain(target.osmRef);
    expect(day1).toContain(target.osmRef);
  });

  it("recomputes the walks of the day it left", async () => {
    const plan = await twoPlannedDays();
    const morning = blocksOf(plan, 0).find((b) => b.id === "morning")!;
    // Take the first spot out: the second one's walk now starts at the
    // anchor instead of at the first.
    const first = morning.stops[0];
    const secondRef = morning.stops[1].osmRef;
    const before = morning.stops[1].travelFromPrevious.distanceM;

    const res = await moveTripStop({
      planId: plan.id,
      stopId: first.rowId,
      toDayIndex: 1,
      toBlockId: "morning",
    });

    const after = res.plan.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.osmRef === secondRef)!;
    expect(after.travelFromPrevious.distanceM).not.toBe(before);
  });

  it("reports a block that went over budget instead of refusing the drag", async () => {
    const plan = await twoPlannedDays();
    // Pile the whole morning into the evening, which is the shortest
    // block of the default day.
    const morning = blocksOf(plan, 0).find((b) => b.id === "morning")!;
    let overfull: string[] = [];
    let current = plan;
    for (const stop of morning.stops) {
      const fresh = current.legs[0].days[0].blocks
        .flatMap((b) => b.stops)
        .find((s) => s.osmRef === stop.osmRef)!;
      const res = await moveTripStop({
        planId: plan.id,
        stopId: fresh.rowId,
        toDayIndex: 0,
        toBlockId: "evening",
      });
      current = res.plan;
      overfull = res.overfullBlockIds;
    }
    expect(overfull).toContain("evening");
    // And every one of them actually landed there — on top of what the
    // evening already held, which is why it went over in the first place.
    const evening = current.legs[0].days[0].blocks.find((b) => b.id === "evening")!;
    for (const stop of morning.stops) {
      expect(evening.stops.map((s) => s.osmRef)).toContain(stop.osmRef);
    }
    expect(evening.usedMinutes).toBeGreaterThan(evening.budgetMinutes);
  });

  it("refuses a meal block", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];
    await expect(
      moveTripStop({ planId: plan.id, stopId: target.rowId, toDayIndex: 0, toBlockId: "midday" }),
    ).rejects.toThrow(/holds time, not places/);
  });

  it("refuses a day that is not planned yet", async () => {
    // A day at trip resolution has a frame but no stops (§4.3);
    // dropping one in would half-plan it behind the traveller's back.
    const { plan } = await createTripPlan({ anchor: ANCHOR, days: 4 });
    const target = plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    await expect(
      moveTripStop({ planId: plan.id, stopId: target.rowId, toDayIndex: 3, toBlockId: "morning" }),
    ).rejects.toThrow(/not planned yet/);
  });

  it("says which stop or day it could not find", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];
    await expect(
      moveTripStop({ planId: plan.id, stopId: 999_999, toDayIndex: 0, toBlockId: "afternoon" }),
    ).rejects.toThrow(/stop 999999 not found/);
    await expect(
      moveTripStop({ planId: plan.id, stopId: target.rowId, toDayIndex: 9, toBlockId: "afternoon" }),
    ).rejects.toThrow(/day 9 not found/);
  });

  it("does not move another user's spot", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      moveTripStop({ planId: plan.id, stopId: target.rowId, toDayIndex: 0, toBlockId: "afternoon" }),
    ).rejects.toThrow(/plan not found/);
  });
});

describe("POST /trip-planner/plans/:planId/stops/pin", () => {
  it("pins and releases a stop", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];

    const pinned = await pinTripStop({ planId: plan.id, stopId: target.rowId, pinned: true });
    const find = (p: typeof pinned.plan) =>
      p.legs[0].days[0].blocks.flatMap((b) => b.stops).find((s) => s.rowId === target.rowId)!;
    expect(find(pinned.plan).pinned).toBe(true);

    const released = await pinTripStop({ planId: plan.id, stopId: target.rowId, pinned: false });
    expect(find(released.plan).pinned).toBe(false);
  });

  it("survives being dragged elsewhere", async () => {
    // Pinning says "keep this", not "keep this here": the traveller can
    // still move it themselves, and it stays pinned where it lands.
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];
    await pinTripStop({ planId: plan.id, stopId: target.rowId, pinned: true });

    const res = await moveTripStop({
      planId: plan.id,
      stopId: target.rowId,
      toDayIndex: 0,
      toBlockId: "afternoon",
    });

    const moved = res.plan.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.osmRef === target.osmRef)!;
    expect(moved.pinned).toBe(true);
  });

  it("does not pin another user's spot", async () => {
    const plan = await twoPlannedDays();
    const target = blocksOf(plan, 0).find((b) => b.id === "morning")!.stops[0];
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(other.id),
      permissions: ["photos.view"],
    });

    await expect(
      pinTripStop({ planId: plan.id, stopId: target.rowId, pinned: true }),
    ).rejects.toThrow(/not found/);
  });
});
