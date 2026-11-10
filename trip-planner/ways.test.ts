/**
 * The way between two places (reise-planen-und-unterwegs.md, stage 6):
 * the sheet "Weg", the day's segments along the streets, and a mode
 * picked for one segment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlanFixpoints, tripPlanStops, tripPlans, tripRouteCache, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearRouterCache } from "../osm-admin/region-router";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { setRouterClient } from "./router-client";
import { InMemoryRouterClient } from "./router-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { arrivalFit, routeCacheKey, setTripSegmentMode, tripDayWays, tripWay } from "./ways";
import type { StoredPlan } from "./plan-store";

const TOWN = { lat: 48.37, lon: 10.9 };

let router: InMemoryRouterClient;

async function newUser(tag: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ email: `${tag}-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  return user.id;
}

function actAs(id: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(id), permissions: ["photos.view"] });
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(tripRouteCache);
  await db.delete(osmRegionImports);
  clearRouterCache();
  actAs(await newUser("ways"));
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  setGeoClient(new InMemoryGeoClient());
  router = new InMemoryRouterClient();
  setRouterClient(router);
  return () => {
    resetGeoClient();
    setRouterClient(null);
  };
});

async function trip(startDate = "2030-09-05"): Promise<StoredPlan> {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate }],
  });
  await addFind({ planId: plan.id, lat: TOWN.lat - 0.004, lon: TOWN.lon, name: "Beispielbrunnen", dwellMinutes: 30 });
  await addFind({ planId: plan.id, lat: TOWN.lat + 0.02, lon: TOWN.lon + 0.03, name: "Beispielmuseum", dwellMinutes: 90 });
  let current = (await getTripPlan({ planId: plan.id })).plan;
  for (const idea of [...current.legs[0].pool]) {
    current = (await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: idea.osmRef })).plan;
  }
  return current;
}

const stopsOf = (plan: StoredPlan) =>
  plan.legs[0].days.find((d) => d.dayIndex === 0)!.blocks.flatMap((b) => b.stops);

describe("POST /trip-planner/routing/way", () => {
  const from = TOWN;
  const to = { lat: TOWN.lat + 0.01, lon: TOWN.lon + 0.01 };

  it("gives a way per mode, along the streets where the router can, and keeps the answer", async () => {
    const { ways } = await tripWay({ from, to });
    expect(ways.map((w) => w.mode)).toEqual(["foot", "bike", "transit", "car"]);
    const car = ways.find((w) => w.mode === "car")!;
    expect(car).toMatchObject({ routed: true, by: "car" });
    expect(car.shape).toBeTruthy();
    const transit = ways.find((w) => w.mode === "transit")!;
    // No timetable in the router: the estimate, a straight line, or a walk.
    if (transit.by === "transit") expect(transit).toMatchObject({ routed: false, shape: null });

    const cached = await db.select().from(tripRouteCache).where(eq(tripRouteCache.key, routeCacheKey(from, to, "car")));
    expect(cached).toHaveLength(1);
    const calls = router.routeCalls.length;
    await tripWay({ from, to, modes: ["car"] });
    expect(router.routeCalls.length).toBe(calls);
  });

  it("falls back to the estimate when the router is away", async () => {
    router.reachable = false;
    const { ways } = await tripWay({ from, to, modes: ["foot"] });
    expect(ways[0]).toMatchObject({ mode: "foot", routed: false, shape: null });
    expect(ways[0].minutes).toBeGreaterThan(0);
  });

  it("refuses a mode that is no way and a point that is no coordinate", async () => {
    await expect(tripWay({ from, to, modes: ["plane"] })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(tripWay({ from: { lat: 99, lon: 0 }, to })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("checks the arrival against the place's hours and its booked time", async () => {
    const plan = await trip();
    const museum = stopsOf(plan).find((s) => s.name === "Beispielmuseum")!;
    await db.update(tripPlanStops).set({ opening_hours: "Mo-Su 10:00-18:00" }).where(eq(tripPlanStops.id, museum.rowId));
    const check = { planId: plan.id, legIndex: 0, dayIndex: 0, osmRef: museum.osmRef };

    const early = await tripWay({ from, to: museum, modes: ["car"], check: { ...check, departMinutes: 8 * 60 } });
    expect(early.target).toEqual({ openingText: "10:00–18:00", ticketMinutes: null });
    expect(early.ways[0].fit).toBe("before_opening");
    expect(early.ways[0].arriveMinutes).toBe(8 * 60 + early.ways[0].minutes);

    const midday = await tripWay({ from, to: museum, modes: ["car"], check: { ...check, departMinutes: 12 * 60 } });
    expect(midday.ways[0].fit).toBe("open");

    await db.insert(tripPlanFixpoints).values({
      day_id: plan.legs[0].days[0].id, kind: "appointment", label: "Führung",
      start_minutes: 12 * 60, duration_minutes: 60, spot_ref: museum.osmRef,
    });
    const late = await tripWay({ from, to: museum, modes: ["car"], check: { ...check, departMinutes: 12 * 60 } });
    expect(late.target?.ticketMinutes).toBe(12 * 60);
    expect(late.ways[0].fit).toBe("after_ticket");
  });
});

describe("arrivalFit", () => {
  const open = { state: "open" as const, windows: [{ from: 600, to: 1080 }] };
  it("reads the hours, and says nothing where they are unknown", () => {
    expect(arrivalFit(700, { opening: open, ticketMinutes: null })).toBe("open");
    expect(arrivalFit(1100, { opening: open, ticketMinutes: null })).toBe("after_closing");
    expect(arrivalFit(700, { opening: { state: "closed" }, ticketMinutes: null })).toBe("closed_day");
    expect(arrivalFit(700, { opening: { state: "unknown" }, ticketMinutes: null })).toBeNull();
    expect(arrivalFit(700, { opening: open, ticketMinutes: 690 })).toBe("after_ticket");
  });
});

describe("the ways of a day", () => {
  it("routes every segment from the start of the day, and only new ones after a reorder", async () => {
    const plan = await trip();
    const { ways } = await tripDayWays({ planId: plan.id, legIndex: 0, dayIndex: 0 });
    const stops = stopsOf(plan);
    expect(ways.map((w) => [w.fromRef, w.toRef])).toEqual([
      ["start", stops[0].osmRef],
      [stops[0].osmRef, stops[1].osmRef],
    ]);
    expect(ways.every((w) => w.chosen === false)).toBe(true);
    const calls = router.routeCalls.length;
    await tripDayWays({ planId: plan.id, legIndex: 0, dayIndex: 0 });
    expect(router.routeCalls.length).toBe(calls);
  });
});

describe("a mode for one segment", () => {
  it("is used by the day times while its two ends stand next to each other, and can be taken back", async () => {
    const plan = await trip();
    const [first, second] = stopsOf(plan);
    const before = second.etaMinutes!;
    const { plan: withCar } = await setTripSegmentMode({
      planId: plan.id, fromRef: first.osmRef, toRef: second.osmRef, mode: "car",
      from: { lat: first.lat, lon: first.lon }, to: { lat: second.lat, lon: second.lon },
    });
    const driven = stopsOf(withCar)[1];
    expect(driven.wayMode).toBe("car");
    expect(driven.etaMinutes!).toBeLessThan(before);
    expect(driven.travelFromPrevious.minutes).toBeLessThan(second.travelFromPrevious.minutes + 1);

    const { ways } = await tripDayWays({ planId: plan.id, legIndex: 0, dayIndex: 0 });
    expect(ways[1]).toMatchObject({ mode: "car", chosen: true });

    const { plan: back } = await setTripSegmentMode({ planId: plan.id, fromRef: first.osmRef, toRef: second.osmRef, mode: null });
    expect(stopsOf(back)[1].wayMode).toBeUndefined();
    expect(stopsOf(back)[1].etaMinutes).toBe(before);
  });

  it("refuses a segment that is not on the trip, and needs the ends with a mode", async () => {
    const plan = await trip();
    const [first, second] = stopsOf(plan);
    await expect(setTripSegmentMode({ planId: plan.id, fromRef: "node:0", toRef: second.osmRef, mode: null }))
      .rejects.toThrow(/no such segment/);
    await expect(setTripSegmentMode({ planId: plan.id, fromRef: first.osmRef, toRef: second.osmRef, mode: "car" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });
});
