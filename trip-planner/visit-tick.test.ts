/**
 * A ticked-off stop stays ticked off (§5, §8.5), and one the device saw
 * visited goes where the visit happened.
 *
 * Out of the trial: a replan moved a stop that was already done, and a
 * stop the geofence ticked off in the morning went on standing in the
 * afternoon. Coordinates sit near a river town in Bavaria; every place
 * is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, moveTripStop, setTripStopStatus } from "./plans";
import { answerTripVisit, listTripVisits, reportVisit } from "./visit";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";

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
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    facadeAzimuth: null,
  };
}

let geo: InMemoryGeoClient;
let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `tick-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
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
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

const START = "2026-09-05";
const OFFSET = 120;

/** The instant the destination's clock shows `minutes` past midnight on the first day. */
function localInstant(minutes: number): string {
  return new Date(Date.parse(`${START}T00:00:00Z`) + (minutes - OFFSET) * 60_000).toISOString();
}

async function datedPlan() {
  const { plan } = await createTripPlan({ legs: [{ anchor: ANCHOR, days: 1, startDate: START }] });
  const blocks = plan.legs[0].days[0].blocks.filter((b) => b.kind === "spots");
  const withStops = blocks.filter((b) => b.stops.length > 0);
  expect(withStops.length).toBeGreaterThan(1);
  return { plan, first: withStops[0], last: withStops[withStops.length - 1] };
}

async function reload(planId: number) {
  const { plan } = await getTripPlan({ planId });
  return plan;
}

function blockOf(plan: Awaited<ReturnType<typeof reload>>, osmRef: string) {
  return plan.legs[0].days[0].blocks.find((b) => b.stops.some((s) => s.osmRef === osmRef))!;
}

function stopOf(plan: Awaited<ReturnType<typeof reload>>, osmRef: string) {
  return blockOf(plan, osmRef).stops.find((s) => s.osmRef === osmRef)!;
}

describe("the moment a stop was ticked off", () => {
  it("is stamped by a tap, kept on a second one, and cleared when reopened", async () => {
    const { plan, first } = await datedPlan();
    const target = first.stops[0];

    const before = Date.now();
    await setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "done" });
    const stamped = stopOf(await reload(plan.id), target.osmRef).doneAt;
    expect(stamped).not.toBeNull();
    expect(Date.parse(stamped!)).toBeGreaterThanOrEqual(before - 5_000);

    await setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "done" });
    expect(stopOf(await reload(plan.id), target.osmRef).doneAt).toBe(stamped);

    await setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "planned" });
    expect(stopOf(await reload(plan.id), target.osmRef).doneAt).toBeNull();
  });
});

describe("a stop that is done", () => {
  it("cannot be dragged to another block", async () => {
    const { plan, first, last } = await datedPlan();
    const target = first.stops[0];
    await setTripStopStatus({ planId: plan.id, stopId: target.rowId, status: "done" });

    await expect(moveTripStop({
      planId: plan.id, stopId: target.rowId, toDayIndex: 0, toBlockId: last.id,
    })).rejects.toMatchObject({ code: "failed_precondition" });
    expect(blockOf(await reload(plan.id), target.osmRef).id).toBe(first.id);
  });
});

describe("a visit the device saw", () => {
  it("ticks the stop at the arrival and moves it into the block that covers it", async () => {
    const { plan, first, last } = await datedPlan();
    const target = last.stops[last.stops.length - 1];
    const arrivedAt = localInstant(first.startMinutes! + 20);

    const res = await reportVisit({
      planId: plan.id,
      stopId: target.rowId,
      arrivedAt,
      leftAt: new Date(Date.parse(arrivedAt) + 60 * 60_000).toISOString(),
      hasMatchingPhoto: true,
      utcOffsetMinutes: OFFSET,
    });
    expect(res.verdict).toBe("confirmed");

    const after = await reload(plan.id);
    const block = blockOf(after, target.osmRef);
    expect(block.id).toBe(first.id);
    // First in the block: it happened, the rest has not yet.
    expect(block.stops[0].osmRef).toBe(target.osmRef);
    expect(block.stops[0].status).toBe("done");
    expect(block.stops[0].doneAt).toBe(arrivedAt);
    // The diary still knows which stop it was, although the move gave
    // the stop a new row.
    expect(res.visit?.stopId).toBe(block.stops[0].rowId);
  });

  it("keeps other visits linked to their stops through the move", async () => {
    const { plan, first, last } = await datedPlan();
    const other = first.stops[0];
    const { visit: pending } = await reportVisit({
      planId: plan.id,
      stopId: other.rowId,
      arrivedAt: localInstant(first.startMinutes! + 5),
      leftAt: localInstant(first.startMinutes! + 65),
    });
    expect(pending?.confirmed).toBe(false);

    const target = last.stops[0];
    await reportVisit({
      planId: plan.id,
      stopId: target.rowId,
      arrivedAt: localInstant(first.startMinutes! + 70),
      leftAt: localInstant(first.startMinutes! + 130),
      hasMatchingPhoto: true,
      utcOffsetMinutes: OFFSET,
    });

    const after = await reload(plan.id);
    const visits = (await listTripVisits({ planId: plan.id })).visits;
    expect(visits.find((v) => v.id === pending!.id)?.stopId).toBe(stopOf(after, other.osmRef).rowId);
  });

  it("only ticks when the app does not say which time zone it is in", async () => {
    const { plan, first, last } = await datedPlan();
    const target = last.stops[0];
    const arrivedAt = localInstant(first.startMinutes! + 20);
    await reportVisit({
      planId: plan.id,
      stopId: target.rowId,
      arrivedAt,
      leftAt: localInstant(first.startMinutes! + 80),
      hasMatchingPhoto: true,
    });
    const after = await reload(plan.id);
    expect(blockOf(after, target.osmRef).id).toBe(last.id);
    expect(stopOf(after, target.osmRef).doneAt).toBe(arrivedAt);
  });

  it("moves on a yes to „wart ihr hier?“ as well", async () => {
    const { plan, first, last } = await datedPlan();
    const target = last.stops[0];
    const arrivedAt = localInstant(first.startMinutes! + 20);
    const { visit } = await reportVisit({
      planId: plan.id,
      stopId: target.rowId,
      arrivedAt,
      leftAt: localInstant(first.startMinutes! + 80),
    });
    expect(visit?.confirmed).toBe(false);

    const res = await answerTripVisit({
      planId: plan.id, visitId: visit!.id, confirmed: true, utcOffsetMinutes: OFFSET,
    });
    const after = await reload(plan.id);
    expect(blockOf(after, target.osmRef).id).toBe(first.id);
    expect(stopOf(after, target.osmRef).doneAt).toBe(arrivedAt);
    expect(res.visit.stopId).toBe(stopOf(after, target.osmRef).rowId);
  });

  it("refuses an offset no place on earth has", async () => {
    const { plan, first } = await datedPlan();
    await expect(reportVisit({
      planId: plan.id,
      stopId: first.stops[0].rowId,
      arrivedAt: localInstant(first.startMinutes!),
      leftAt: localInstant(first.startMinutes! + 60),
      hasMatchingPhoto: true,
      utcOffsetMinutes: 5000,
    })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
