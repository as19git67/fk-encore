/**
 * Afterwards (§8.7).
 *
 * The tick list is the easy half. What these cases hold onto is the
 * other one: that a stay nobody planned is reported *as* unplanned
 * rather than dropped, and that "Fotos je Spot" counts this
 * traveller's photos from this trip — not every photograph ever taken
 * of the same church.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  osmRegionImports,
  photoPoiMatches,
  photos,
  recaps,
  tripPlans,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, setTripStopStatus } from "./plans";
import { tripReview } from "./review";
import { recordVisit } from "./visit-store";

const ANCHOR = { lat: 48.37, lon: 10.9 };
const DB = "nom_west";
const START = "2026-06-18";

function spot(n: number): GeoPoiSearchSpot {
  const angle = (n / 20) * 2 * Math.PI;
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

/** A photo of `osmRef`, taken on `day`, belonging to `userId`. */
async function photoOf(userId: number, osmRef: string, day: string) {
  const [photo] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `${osmRef}-${day}.jpg`,
      original_name: "p.jpg",
      mime_type: "image/jpeg",
      size: 1,
      taken_at: `${day} 12:00:00`,
    })
    .returning({ id: photos.id });
  await db.insert(photoPoiMatches).values({
    photo_id: photo.id,
    osm_ref: osmRef,
    name: "Ort",
    match_score: 0.9,
    source: "test",
  });
}

beforeEach(async () => {
  await db.delete(recaps);
  await db.delete(photoPoiMatches);
  await db.delete(photos);
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  ownerId = await makeUser(`danach-${stamp}@test.invalid`);
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
  geo.setSearchSpots(DB, Array.from({ length: 20 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function trip() {
  const { plan } = await createTripPlan({
    legs: [{ title: "Weststadt", anchor: ANCHOR, startDate: START }],
    days: 2,
  });
  return plan;
}

const firstStop = (plan: Awaited<ReturnType<typeof trip>>) =>
  plan.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];

describe("looking back at a trip", () => {
  it("lists every planned stop with what became of it", async () => {
    const plan = await trip();
    const stop = firstStop(plan);
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });

    const review = await tripReview({ planId: plan.id });

    expect(review.startsOn).toBe(START);
    expect(review.stops.length).toBeGreaterThan(0);
    expect(review.stops.find((s) => s.osmRef === stop.osmRef)?.status).toBe("done");
    expect(review.totals.done).toBe(1);
    expect(review.totals.planned).toBe(review.stops.length);
  });

  it("counts a planned stop as visited when the diary says so", async () => {
    const plan = await trip();
    const stop = firstStop(plan);
    await recordVisit({
      planId: plan.id,
      userId: ownerId,
      stopId: stop.rowId,
      osmRef: stop.osmRef,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      arrivedAt: `${START}T10:00:00.000Z`,
      sources: ["dwell", "photo"],
      confirmed: true,
    });

    const review = await tripReview({ planId: plan.id });

    expect(review.stops.find((s) => s.osmRef === stop.osmRef)?.visited).toBe(true);
    // Still "planned" as far as the day plan goes: the diary confirms
    // where somebody was, it does not tick the list for them.
    expect(review.totals.untouched).toBe(review.stops.length - 1);
  });

  it("reports a stay nobody planned as its own thing", async () => {
    // §6.4 calls this the more valuable half, and it is the one a tick
    // list would throw away.
    const plan = await trip();
    await recordVisit({
      planId: plan.id,
      userId: ownerId,
      osmRef: "node:999",
      name: "Buchladen um die Ecke",
      lat: ANCHOR.lat,
      lon: ANCHOR.lon,
      arrivedAt: `${START}T15:00:00.000Z`,
      sources: ["dwell", "payment"],
      confirmed: true,
    });

    const review = await tripReview({ planId: plan.id });

    expect(review.unplanned.map((s) => s.name)).toEqual(["Buchladen um die Ecke"]);
    expect(review.totals.unplanned).toBe(1);
  });

  it("leaves an unconfirmed or dismissed stay out of the account", async () => {
    const plan = await trip();
    await recordVisit({
      planId: plan.id,
      userId: ownerId,
      osmRef: "node:998",
      name: "Nur vorbeigelaufen",
      lat: ANCHOR.lat,
      lon: ANCHOR.lon,
      arrivedAt: `${START}T16:00:00.000Z`,
      sources: ["dwell"],
      confirmed: false,
    });

    const review = await tripReview({ planId: plan.id });

    expect(review.unplanned).toEqual([]);
  });

  it("counts the photos of a spot taken on the trip", async () => {
    const plan = await trip();
    const stop = firstStop(plan);
    await photoOf(ownerId, stop.osmRef, START);
    await photoOf(ownerId, stop.osmRef, START);

    const review = await tripReview({ planId: plan.id });

    expect(review.stops.find((s) => s.osmRef === stop.osmRef)?.photos).toBe(2);
    expect(review.totals.photos).toBe(2);
  });

  it("does not count an earlier visit's photos of the same place", async () => {
    // Without the date window every holiday ever taken to the same
    // church would land in this trip's account.
    const plan = await trip();
    const stop = firstStop(plan);
    await photoOf(ownerId, stop.osmRef, "2023-05-04");

    const review = await tripReview({ planId: plan.id });

    expect(review.stops.find((s) => s.osmRef === stop.osmRef)?.photos).toBe(0);
  });

  it("counts only this traveller's photos", async () => {
    const plan = await trip();
    const stop = firstStop(plan);
    await photoOf(strangerId, stop.osmRef, START);

    const review = await tripReview({ planId: plan.id });

    expect(review.stops.find((s) => s.osmRef === stop.osmRef)?.photos).toBe(0);
  });

  it("has no recap while the trip has produced no memory yet", async () => {
    // A recap is made of photographs, and they arrive before it does.
    const plan = await trip();

    const review = await tripReview({ planId: plan.id });

    expect(review.recap).toBeNull();
  });

  it("names the recap once the builder has tied one to this plan", async () => {
    const plan = await trip();
    const [recap] = await db
      .insert(recaps)
      .values({
        user_id: ownerId,
        kind: "trip",
        title: "Zwei Tage Weststadt",
        subtitle: "18.–19. Juni",
        dedup_key: `trip:weststadt:${START}:${START}`,
        score: 50,
        seed: { trip_plan_id: plan.id },
      })
      .returning({ id: recaps.id });

    const review = await tripReview({ planId: plan.id });

    expect(review.recap?.id).toBe(recap.id);
    expect(review.recap?.title).toBe("Zwei Tage Weststadt");
  });

  it("does not claim somebody else\u2019s recap", async () => {
    const plan = await trip();
    await db.insert(recaps).values({
      user_id: strangerId,
      kind: "trip",
      title: "Fremde Reise",
      dedup_key: "trip:fremd:2026-06-18:2026-06-19",
      score: 50,
      seed: { trip_plan_id: plan.id },
    });

    const review = await tripReview({ planId: plan.id });

    expect(review.recap).toBeNull();
  });

  it("does not hand a trip to somebody who is not on it", async () => {
    const plan = await trip();
    actAs(strangerId);

    await expect(tripReview({ planId: plan.id })).rejects.toThrow(/not found/);
  });
});
