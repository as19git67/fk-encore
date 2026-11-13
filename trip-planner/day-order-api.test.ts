/**
 * The day of ideas as one window, its order and its breaks (ideas plan,
 * stage 4).
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
import { addTripBreak, orderTripDay, removeTripBreak } from "./day-order-api";
import { setTripDayShape } from "./day-blocks";
import { addTripFixpoint } from "./fixpoint-edit";

const TOWN = { lat: 48.37, lon: 10.9 };
const MUSEUM = { lat: TOWN.lat + 0.004, lon: TOWN.lon };

function museum(): GeoPoiSearchSpot {
  return {
    osmRef: "node:77", type: "node", id: 77, ...MUSEUM, distanceM: 5, detourM: null,
    name: "Beispielmuseum", nameDe: null, nameEn: null,
    kind: "tourism=museum", categories: ["museum"], wikidataQid: null, wikipedia: null,
    // Opens only in the afternoon.
    openingHours: "Mo-Su 14:00-18:00", cuisine: null, wheelchair: null, outdoorSeating: null,
    dietVegetarian: null, dietVegan: null, phone: null, website: null, facadeAzimuth: null,
  };
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `order-${crypto.randomUUID()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [museum()]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function tripWithIdeas() {
  // 2026-09-05 is a Saturday.
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  await addFind({ planId: plan.id, ...MUSEUM, name: "Beispielmuseum" });
  await addFind({ planId: plan.id, lat: TOWN.lat - 0.004, lon: TOWN.lon, name: "Beispielbrunnen", dwellMinutes: 30 });
  await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon + 0.006, name: "Beispielturm", dwellMinutes: 45 });
  let current = (await getTripPlan({ planId: plan.id })).plan;
  for (const idea of [...current.legs[0].pool]) {
    current = (await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: idea.osmRef })).plan;
  }
  return current;
}

const namesOf = (day: { blocks: { stops: { name: string | null }[] }[] }) =>
  day.blocks.flatMap((b) => b.stops.map((s) => s.name));

describe("a day of ideas", () => {
  it("is one window, and every stop on it has an estimated time", async () => {
    const plan = await tripWithIdeas();
    const day = plan.legs[0].days[0];
    expect(day.blocks.map((b) => b.label)).toEqual(["Tag"]);
    expect(day.window).toEqual({ startMinutes: 9 * 60, endMinutes: 19 * 60 });
    expect(day.blocks[0].stops).toHaveLength(3);
    for (const stop of day.blocks[0].stops) expect(typeof stop.etaMinutes).toBe("number");
    expect(day.plannedMinutes).toBeGreaterThan(0);
  });

  it("is ordered so the museum comes after it opens, and nothing is dropped", async () => {
    const plan = await tripWithIdeas();
    const { plan: ordered, overrunMinutes, toDrop } = await orderTripDay({ planId: plan.id, dayIndex: 0 });
    const day = ordered.legs[0].days[0];
    expect(namesOf(day)).toHaveLength(3);
    expect(namesOf(day).at(-1)).toBe("Beispielmuseum");
    const museumStop = day.blocks[0].stops.find((s) => s.name === "Beispielmuseum")!;
    expect(museumStop.etaMinutes).toBeGreaterThanOrEqual(14 * 60);
    expect(museumStop.outsideHours).toBeUndefined();
    expect(overrunMinutes).toBe(0);
    expect(toDrop).toEqual([]);
    const etas = day.blocks[0].stops.map((s) => s.etaMinutes!);
    expect([...etas].sort((a, b) => a - b)).toEqual(etas);
  });

  it("says what would make an overfull day fit, Wenn Zeit first", async () => {
    const plan = await tripWithIdeas();
    await addFind({
      planId: plan.id, lat: TOWN.lat + 0.002, lon: TOWN.lon + 0.002, name: "Beispielwanderung",
      dwellMinutes: 480, priority: "maybe",
    });
    const walk = (await getTripPlan({ planId: plan.id })).plan.legs[0].pool[0];
    await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: walk.osmRef });
    const { plan: ordered, overrunMinutes, toDrop } = await orderTripDay({ planId: plan.id, dayIndex: 0 });
    expect(namesOf(ordered.legs[0].days[0])).toHaveLength(4);
    expect(overrunMinutes).toBeGreaterThan(0);
    expect(ordered.legs[0].days[0].overrunMinutes).toBe(overrunMinutes);
    expect(toDrop).toEqual([walk.osmRef]);
  });
});

describe("a fixed time on a day of ideas", () => {
  // The one block of the day used to be cut at the appointment like a
  // block of the four-part day, with nothing after it to take over: a
  // ticket at 11:00 ended the day at noon, one at 09:30 left no day at
  // all ("endet 15:30 statt 09:15").
  for (const at of ["09:30", "11:00", "15:00"]) {
    it(`keeps the window of the day around a ticket at ${at}`, async () => {
      const plan = await tripWithIdeas();
      const tower = plan.legs[0].days[0].blocks[0].stops.find((s) => s.name === "Beispielturm")!;
      await addTripFixpoint({ planId: plan.id, dayIndex: 0, at, durationMinutes: 60, spotRef: tower.osmRef, pinReason: "ticket" });
      const day = (await getTripPlan({ planId: plan.id })).plan.legs[0].days[0];
      expect(day.window).toEqual({ startMinutes: 9 * 60, endMinutes: 19 * 60 });
      expect(namesOf(day)).toHaveLength(3);
      expect(day.overrunMinutes).toBe(0);
    });
  }

  it("keeps the window around an appointment without a spot, and nothing is planned into it", async () => {
    const plan = await tripWithIdeas();
    await addTripFixpoint({ planId: plan.id, dayIndex: 0, label: "Führung", at: "09:30", durationMinutes: 60 });
    const day = (await getTripPlan({ planId: plan.id })).plan.legs[0].days[0];
    expect(day.window).toEqual({ startMinutes: 9 * 60, endMinutes: 19 * 60 });
    expect(namesOf(day)).toHaveLength(3);
    for (const stop of day.blocks[0].stops) expect(stop.etaMinutes!).toBeGreaterThanOrEqual(10 * 60 + 30);
  });
});

describe("a break", () => {
  it("stays where it was put, has its time, and survives a re-plan", async () => {
    const plan = await tripWithIdeas();
    const { plan: withBreak } = await addTripBreak({ planId: plan.id, dayIndex: 0, label: "Mittag", minutes: 60, position: 1 });
    const brk = withBreak.legs[0].days[0].breaks![0];
    expect(brk).toMatchObject({ label: "Mittag", minutes: 60, position: 1, blockId: "day" });
    expect(typeof brk.etaMinutes).toBe("number");

    const { plan: ordered } = await orderTripDay({ planId: plan.id, dayIndex: 0 });
    const first = ordered.legs[0].days[0].blocks[0].stops[0];
    const kept = ordered.legs[0].days[0].breaks![0];
    expect(kept.position).toBe(1);
    expect(kept.etaMinutes).toBeGreaterThanOrEqual(first.etaMinutes! + first.dwellMinutes);

    const { plan: replanned } = await setTripDayShape({
      planId: plan.id, blocks: [{ id: "day", label: "Tag", kind: "spots", baseBudgetMinutes: 540 }],
    });
    expect(replanned.legs[0].days[0].breaks?.map((b) => b.label)).toEqual(["Mittag"]);
    expect(namesOf(replanned.legs[0].days[0])).toHaveLength(3);

    const { plan: without } = await removeTripBreak({ planId: plan.id, dayIndex: 0, breakId: kept.id });
    expect(without.legs[0].days[0].breaks).toBeUndefined();
  });

  it("refuses a break that is no break", async () => {
    const plan = await tripWithIdeas();
    await expect(addTripBreak({ planId: plan.id, dayIndex: 0, label: "Mittag", minutes: 600 })).rejects.toThrow(/minutes/);
    await expect(addTripBreak({ planId: plan.id, dayIndex: 0, label: " ", minutes: 30 })).rejects.toThrow(/label/);
  });
});
