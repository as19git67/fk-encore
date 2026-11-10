/**
 * A ticket on a trip of ideas: the spot in front whose estimated visit
 * runs into the ticket steps behind it; one that ends in time stays.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { addTripFixpoint } from "./fixpoint-edit";

const TOWN = { lat: 48.37, lon: 10.9 };

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `ticket-${crypto.randomUUID()}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  setGeoClient(new InMemoryGeoClient());
  return () => resetGeoClient();
});

/** A day with the fountain (two hours) in front of the tower. */
async function day() {
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate: "2026-09-05" }],
  });
  await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon - 0.004, name: "Beispielbrunnen", dwellMinutes: 120 });
  await addFind({ planId: plan.id, lat: TOWN.lat, lon: TOWN.lon + 0.004, name: "Beispielturm", dwellMinutes: 30 });
  const pool = (await getTripPlan({ planId: plan.id })).plan.legs[0].pool;
  const ref = (name: string) => pool.find((c) => c.name === name)!.osmRef;
  await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: ref("Beispielbrunnen") });
  await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: ref("Beispielturm") });
  return { planId: plan.id, tower: ref("Beispielturm") };
}

const names = (plan: Awaited<ReturnType<typeof getTripPlan>>["plan"]) =>
  plan.legs[0].days[0].blocks.flatMap((b) => b.stops).map((s) => s.name);

describe("a ticket makes room in front of it", () => {
  it("moves the spot that runs into the ticket behind it", async () => {
    const { planId, tower } = await day();
    expect(names((await getTripPlan({ planId })).plan)).toEqual(["Beispielbrunnen", "Beispielturm"]);
    const { plan } = await addTripFixpoint({ planId, dayIndex: 0, at: "09:45", durationMinutes: 30, spotRef: tower, pinReason: "ticket" });
    expect(names(plan)).toEqual(["Beispielturm", "Beispielbrunnen"]);
  });

  it("leaves the order alone when the spot in front ends in time", async () => {
    const { planId, tower } = await day();
    const { plan } = await addTripFixpoint({ planId, dayIndex: 0, at: "16:00", durationMinutes: 30, spotRef: tower, pinReason: "ticket" });
    expect(names(plan)).toEqual(["Beispielbrunnen", "Beispielturm"]);
  });
});
