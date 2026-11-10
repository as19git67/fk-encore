/**
 * On the road (reise-planen-und-unterwegs.md, stage 5): checks by hand
 * and their undo, "Neu ordnen" from now on, the weather of a visit, and
 * the photos of a day that each traveller may see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { albumPhotos, albumShares, albums, osmRegionImports, photoPoiMatches, photos, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, setTripStopStatus } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { orderTripDay } from "./day-order-api";
import { listTripVisits, reportVisit, undoTripVisit } from "./visit";
import { tripDayDiary } from "./day-diary";
import { resetWeatherClient, setWeatherClient } from "./weather-client";
import { weatherAt } from "./visit-weather";
import type { StoredPlan } from "./plan-store";

const TOWN = { lat: 48.37, lon: 10.9 };
const TOWER = { lat: TOWN.lat, lon: TOWN.lon + 0.006 };

let userId = 0;

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
  await db.delete(osmRegionImports);
  clearRouterCache();
  userId = await newUser("road");
  actAs(userId);
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  setGeoClient(new InMemoryGeoClient());
  return () => resetGeoClient();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetWeatherClient();
});

async function trip(startDate = "2030-09-05"): Promise<StoredPlan> {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate }],
  });
  await addFind({ planId: plan.id, lat: TOWN.lat - 0.004, lon: TOWN.lon, name: "Beispielbrunnen", dwellMinutes: 30 });
  await addFind({ planId: plan.id, ...TOWER, name: "Beispielturm", dwellMinutes: 45 });
  await addFind({ planId: plan.id, lat: TOWN.lat + 0.004, lon: TOWN.lon, name: "Beispielmuseum", dwellMinutes: 90 });
  let current = (await getTripPlan({ planId: plan.id })).plan;
  for (const idea of [...current.legs[0].pool]) {
    current = (await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: idea.osmRef })).plan;
  }
  return current;
}

const stopsOf = (plan: StoredPlan, dayIndex = 0) =>
  plan.legs[0].days.find((d) => d.dayIndex === dayIndex)!.blocks.flatMap((b) => b.stops);

describe("checking off by hand", () => {
  it("is a visit with the source manual, and taking it back removes it", async () => {
    const plan = await trip();
    const stop = stopsOf(plan)[0];
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });
    const [visit] = (await listTripVisits({ planId: plan.id })).visits;
    expect(visit).toMatchObject({ stopId: stop.rowId, sources: ["manual"], confirmed: true });

    // A second tap adds no second visit.
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });
    expect((await listTripVisits({ planId: plan.id })).visits).toHaveLength(1);

    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "planned" });
    expect((await listTripVisits({ planId: plan.id })).visits).toEqual([]);
  });
});

describe("„Doch nicht“", () => {
  it("dismisses an automatic check, reopens the stop, and the same stay is not ticked again", async () => {
    const plan = await trip();
    const stop = stopsOf(plan)[1];
    const report = () => reportVisit({
      planId: plan.id, stopId: stop.rowId,
      arrivedAt: "2030-09-05T10:00:00Z", leftAt: "2030-09-05T11:00:00Z",
    });
    const { verdict, visit } = await report();
    expect(verdict).toBe("confirmed");
    expect(stopsOf((await getTripPlan({ planId: plan.id })).plan).find((s) => s.osmRef === stop.osmRef)!.status)
      .toBe("done");

    const { plan: after } = await undoTripVisit({ planId: plan.id, visitId: visit!.id });
    expect(stopsOf(after).find((s) => s.osmRef === stop.osmRef)!.status).toBe("planned");
    expect((await listTripVisits({ planId: plan.id })).visits[0]).toMatchObject({ confirmed: false, dismissed: true });

    await report();
    expect(stopsOf((await getTripPlan({ planId: plan.id })).plan).find((s) => s.osmRef === stop.osmRef)!.status)
      .toBe("planned");
  });

  it("is only the traveller's own", async () => {
    const plan = await trip();
    const { visit } = await reportVisit({
      planId: plan.id, stopId: stopsOf(plan)[0].rowId,
      arrivedAt: "2030-09-05T10:00:00Z", leftAt: "2030-09-05T11:00:00Z",
    });
    actAs(await newUser("other"));
    await expect(undoTripVisit({ planId: plan.id, visitId: visit!.id })).rejects.toThrow(/not found/);
  });
});

describe("„Neu ordnen“ from now on", () => {
  it("starts what is open no earlier than now, and offers another day for what no longer fits", async () => {
    const plan = await trip();
    const first = stopsOf(plan)[0];
    await setTripStopStatus({ planId: plan.id, stopId: first.rowId, status: "done" });

    const res = await orderTripDay({ planId: plan.id, dayIndex: 0, fromMinutes: 17 * 60 + 30 });
    const stops = stopsOf(res.plan);
    // What is done stays at the front.
    expect(stops[0].osmRef).toBe(first.osmRef);
    expect(stops).toHaveLength(3);
    expect(res.overrunMinutes).toBeGreaterThan(0);
    expect(res.toDrop.length).toBeGreaterThan(0);
    expect(res.elsewhere.map((e) => e.osmRef)).toEqual(res.toDrop);
    for (const e of res.elsewhere) expect(e.dayIndex).toBe(1);
  });

  it("refuses a minute that is not one", async () => {
    const plan = await trip();
    await expect(orderTripDay({ planId: plan.id, dayIndex: 0, fromMinutes: 24 * 60 }))
      .rejects.toThrow(/minute of the day/);
  });
});

describe("the weather of a visit", () => {
  it("is the nearest hour of the forecast, kept on the row", async () => {
    vi.stubEnv("TRIP_VISIT_WEATHER", "1");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hours = Array.from({ length: 24 }, (_, h) => ({
      time: `${day}T${String(h).padStart(2, "0")}:00:00Z`,
      precipitationMm: 0, cloudCover: 20, temperatureC: 10 + h, relativeHumidity: 50,
    }));
    setWeatherClient({ forecast: async (lat, lon) => ({ lat, lon, hours }) });

    const plan = await trip(day);
    const stop = stopsOf(plan)[0];
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });
    const [visit] = (await listTripVisits({ planId: plan.id })).visits;
    expect(visit.weather).toEqual(weatherAt(hours, new Date(visit.arrivedAt)));
    expect(visit.weather?.cloudCover).toBe(20);
  });

  it("says nothing about an hour too far from any forecast", () => {
    const hours = [{ time: "2030-09-05T08:00:00Z", precipitationMm: 1, cloudCover: 90, temperatureC: 12, relativeHumidity: 80 }];
    expect(weatherAt(hours, new Date("2030-09-05T08:40:00Z"))).toEqual({ temperatureC: 12, precipitationMm: 1, cloudCover: 90 });
    expect(weatherAt(hours, new Date("2030-09-05T11:00:00Z"))).toBeNull();
  });
});

describe("the photos of a day", () => {
  async function photo(owner: number, taken: string, at: { lat: number; lon: number } | null, osmRef?: string) {
    const [row] = await db.insert(photos).values({
      user_id: owner, filename: `p-${crypto.randomUUID()}.jpg`, original_name: "p.jpg",
      mime_type: "image/jpeg", size: 1, taken_at: taken,
      latitude: at?.lat ?? null, longitude: at?.lon ?? null,
    }).returning({ id: photos.id });
    if (osmRef) {
      await db.insert(photoPoiMatches).values({ photo_id: row.id, osm_ref: osmRef, name: "Ort", match_score: 0.9, source: "test" });
    }
    return row.id;
  }

  it("counts what was taken at the spot that day, and only what the traveller may see", async () => {
    const plan = await trip();
    const tower = stopsOf(plan).find((s) => s.name === "Beispielturm")!;
    const mine = await photo(userId, "2030-09-05 11:00:00", TOWER);
    const matched = await photo(userId, "2030-09-05 12:00:00", null, tower.osmRef);
    await photo(userId, "2030-09-06 11:00:00", TOWER); // another day
    await photo(userId, "2030-09-05 11:00:00", { lat: TOWER.lat + 0.01, lon: TOWER.lon }); // elsewhere

    // A fellow traveller's photo is not theirs to see — unless shared.
    const other = await newUser("fellow");
    await photo(other, "2030-09-05 11:30:00", TOWER);
    const shared = await photo(other, "2030-09-05 11:45:00", TOWER);
    const [album] = await db.insert(albums).values({ user_id: other, name: "Beispielalbum" }).returning({ id: albums.id });
    await db.insert(albumPhotos).values({ album_id: album.id, photo_id: shared });
    await db.insert(albumShares).values({ album_id: album.id, user_id: userId });

    const diary = await tripDayDiary({ planId: plan.id, legIndex: 0, dayIndex: 0 });
    expect(diary.date).toBe("2030-09-05");
    const spot = diary.spots.find((s) => s.osmRef === tower.osmRef)!;
    expect(spot.photoCount).toBe(3);
    expect(spot.photos.map((p) => p.id)).toEqual([mine, shared, matched]);
  });

  it("lists a stay nobody planned", async () => {
    const plan = await trip();
    await reportVisit({
      planId: plan.id, lat: TOWN.lat + 0.01, lon: TOWN.lon, name: "Beispielhof",
      arrivedAt: "2030-09-05T13:40:00Z", leftAt: "2030-09-05T14:20:00Z",
    });
    const diary = await tripDayDiary({ planId: plan.id, legIndex: 0, dayIndex: 0 });
    expect(diary.unplanned.map((u) => u.name)).toEqual(["Beispielhof"]);
    expect((await tripDayDiary({ planId: plan.id, legIndex: 0, dayIndex: 1 })).unplanned).toEqual([]);
  });
});
