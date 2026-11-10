/**
 * Soft and firm stops (stage 8, step 1): a soft stop the day did not
 * reach goes back to the open spots once the day is over, in the
 * journal and undoable; a firm stop, a visited one and one on a day
 * still to come stay. And the capacity line of the stay on read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports, tripPlanStops, tripPlanVisits, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, moveTripStop } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { setIdeaPriority } from "./idea-priority";
import { planJournal, undoPlanOp } from "./plan-ops";
import { returnOpenSpots, RETURN_OPEN_OP, tickReturnOpen } from "./open-return";
import { addDays } from "./leg-dates";

const TOWN = { lat: 48.37, lon: 10.9 };
const PARK = { lat: TOWN.lat + 0.004, lon: TOWN.lon };
const MUSEUM = { lat: TOWN.lat, lon: TOWN.lon + 0.004 };

function geoSpot(n: number, at: { lat: number; lon: number }, name: string, category: string): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`, type: "node", id: n, ...at, distanceM: 5, detourM: null,
    name, nameDe: null, nameEn: null, kind: null as unknown as string, categories: [category],
    wikidataQid: null, wikipedia: null, openingHours: null, cuisine: null, wheelchair: null,
    outdoorSeating: null, dietVegetarian: null, dietVegan: null, phone: null, website: null,
    facadeAzimuth: null,
  };
}

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** Noon UTC on that date: well inside the day in Central Europe. */
const at = (date: string) => new Date(`${date}T12:00:00Z`);

let userId: number;

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const [user] = await db
    .insert(users)
    .values({ email: `offen-${crypto.randomUUID()}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  userId = user.id;
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: ["photos.view"] });
  await db.insert(osmRegionImports).values({
    slug: "europe/west", geofabrik_url: "https://example.com/x.pbf", postgres_db: "nom_west",
    bbox_min_lat: 48.2, bbox_min_lon: 10.5, bbox_max_lat: 48.6, bbox_max_lon: 11.6, status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", [
    geoSpot(1, PARK, "Beispielpark", "outdoors"),
    geoSpot(2, MUSEUM, "Beispielmuseum", "museum"),
  ]);
  setGeoClient(geo);
  return () => resetGeoClient();
});

/** Two days from tomorrow, the park on day 1 and the museum on day 2. */
async function stay() {
  const startDate = soon(1);
  const { plan } = await createTripPlan({
    startEmpty: true,
    legs: [{ title: "Musterstadt", anchor: TOWN, days: 2, radiusM: 4_000, startDate }],
  });
  await addFind({ planId: plan.id, ...PARK });
  await addFind({ planId: plan.id, ...MUSEUM });
  const pool = (await getTripPlan({ planId: plan.id })).plan.legs[0].pool;
  const park = pool.find((p) => p.name === "Beispielpark")!;
  const museum = pool.find((p) => p.name === "Beispielmuseum")!;
  await placeFromPool({ planId: plan.id, dayIndex: 0, osmRef: park.osmRef });
  await placeFromPool({ planId: plan.id, dayIndex: 1, osmRef: museum.osmRef });
  return { planId: plan.id, startDate, park: park.osmRef, museum: museum.osmRef };
}

async function stopsOf(planId: number) {
  const { plan } = await getTripPlan({ planId });
  return plan.legs[0].days.map((day) => day.blocks.flatMap((b) => b.stops));
}

async function makeSoft(planId: number, osmRef: string) {
  const stop = (await stopsOf(planId)).flat().find((s) => s.osmRef === osmRef)!;
  await db.update(tripPlanStops).set({ placed_by: "fill" }).where(eq(tripPlanStops.id, stop.rowId));
  return stop.rowId;
}

describe("soft and firm stops", () => {
  it("reads every stop placed by a person as firm", async () => {
    const { planId } = await stay();
    expect((await stopsOf(planId)).flat().map((s) => s.placedBy)).toEqual(["hand", "hand"]);
  });

  it("gives an unreached soft stop back once its day is over, in the journal", async () => {
    const { planId, startDate, park } = await stay();
    await makeSoft(planId, park);

    // During the day nothing happens.
    expect(await returnOpenSpots(planId, at(startDate))).toBe(0);

    expect(await returnOpenSpots(planId, at(addDays(startDate, 1)))).toBe(1);
    const { plan } = await getTripPlan({ planId });
    expect(plan.legs[0].days[0].blocks.flatMap((b) => b.stops)).toHaveLength(0);
    expect(plan.legs[0].pool.map((p) => p.osmRef)).toContain(park);

    const { entries } = await planJournal({ planId });
    const entry = entries.find((e) => e.kind === RETURN_OPEN_OP)!;
    expect(entry.sentence).toBe("Beispielpark ist wieder offen: an Tag 1 nicht geschafft");
    expect(entry.actor).toBeNull();
    expect(entry.undoable).toBe(true);

    // Twice is once.
    expect(await returnOpenSpots(planId, at(addDays(startDate, 1)))).toBe(0);
  });

  it("puts it back as a firm stop on undo, so it stays", async () => {
    const { planId, startDate, park } = await stay();
    await makeSoft(planId, park);
    await returnOpenSpots(planId, at(addDays(startDate, 1)));
    const { entries } = await planJournal({ planId });
    const opId = entries.find((e) => e.kind === RETURN_OPEN_OP)!.id;

    await undoPlanOp({ planId, opId });
    const day = (await stopsOf(planId))[0];
    expect(day.map((s) => [s.osmRef, s.placedBy])).toEqual([[park, "hand"]]);
    expect((await getTripPlan({ planId })).plan.legs[0].pool.map((p) => p.osmRef)).not.toContain(park);
    expect(await returnOpenSpots(planId, at(addDays(startDate, 1)))).toBe(0);
  });

  it("leaves firm, done and visited stops on their day", async () => {
    const { planId, startDate, park, museum } = await stay();
    const parkId = await makeSoft(planId, park);
    await db.insert(tripPlanVisits).values({
      plan_id: planId, user_id: userId, stop_id: parkId, osm_ref: park, name: "Beispielpark",
      ...PARK, arrived_at: `${startDate}T09:00:00Z`, sources: ["dwell"],
    });
    expect(await returnOpenSpots(planId, at(addDays(startDate, 3)))).toBe(0);
    expect((await stopsOf(planId)).map((d) => d.map((s) => s.osmRef))).toEqual([[park], [museum]]);
  });

  it("finds the plans with soft stops for the cron", async () => {
    const { planId, startDate, museum } = await stay();
    await makeSoft(planId, museum);
    // Day 2 is not over the day after day 1.
    expect(await tickReturnOpen(at(addDays(startDate, 1)))).toBe(0);
    expect(await tickReturnOpen(at(addDays(startDate, 2)))).toBe(1);
  });

  it("makes a soft stop firm when a person moves it", async () => {
    const { planId, park } = await stay();
    const stopId = await makeSoft(planId, park);
    const toBlockId = (await getTripPlan({ planId })).plan.legs[0].days[1].blocks[0].id;
    await moveTripStop({ planId, stopId, toDayIndex: 1, toBlockId });
    const moved = (await stopsOf(planId))[1].find((s) => s.osmRef === park)!;
    expect(moved.placedBy).toBe("hand");
  });
});

describe("the capacity line of a stay", () => {
  it("weighs the open spots against the free time of the days to come", async () => {
    const { planId, park } = await stay();
    // Back among the open spots, as a Muss.
    const { plan: before } = await getTripPlan({ planId });
    const stop = before.legs[0].days[0].blocks.flatMap((b) => b.stops)[0];
    const { returnStopToPool } = await import("./to-pool");
    await returnStopToPool({ planId, stopId: stop.rowId });
    await setIdeaPriority({ planId, legIndex: 0, osmRef: park, priority: "must" });

    const { plan } = await getTripPlan({ planId });
    const capacity = plan.legs[0].capacity!;
    const parkIdea = plan.legs[0].pool.find((p) => p.osmRef === park)!;
    expect(capacity.mustMinutes).toBe(parkIdea.dwellMinutes);
    expect(capacity.wantMinutes).toBe(0);
    expect(capacity.days).toBe(2);
    expect(capacity.freeMinutes).toBeGreaterThan(0);
    expect(capacity.fits).toBe(true);
    expect(capacity.overMinutes).toBe(0);
  });
});
