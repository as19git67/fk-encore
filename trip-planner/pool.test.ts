/**
 * The pool as something you can act on (§5, §9.2).
 *
 * The pool was a list you could look at and nothing else, which is why
 * every one of these cases is about a *consequence*: a spot placed by
 * hand has to survive the next redistribution, a spot dropped has to
 * actually leave, and a placement that overfills a block has to say so
 * instead of being refused — §8.4 is explicit that the app shows the
 * cost of the gesture rather than preventing it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { eq } from "drizzle-orm";
import { osmRegionImports, tripPlanDays, tripPlanLegs, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, deleteTripPlan, getTripPlan, listTripPlans } from "./plans";
import { dropFromPool, placeFromPool } from "./pool";
import { inviteToTrip } from "./shares";
import { addFind } from "./add-find";

const WEST = { lat: 48.37, lon: 10.9 };

/** Museums, close together, all prominent enough to reach the pool. */
function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `node:${n}`,
    type: "node",
    id: n,
    lat: WEST.lat + n * 0.0006,
    lon: WEST.lon,
    distanceM: n * 70,
    detourM: null,
    name: `Museum ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=museum",
    categories: ["museum"],
    wikidataQid: `Q${n}`,
    wikipedia: `de:Museum ${n}`,
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
let companionId = 0;
let companionEmail = "";

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

async function makeUser(email: string, name: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  ownerId = await makeUser(`pool-${stamp}@test.invalid`, "Planerin");
  companionEmail = `mit-${stamp}@test.invalid`;
  companionId = await makeUser(companionEmail, "Mitreisender");
  actAs(ownerId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: "nom_west",
    bbox_min_lat: 48.2,
    bbox_min_lon: 10.5,
    bbox_max_lat: 48.6,
    bbox_max_lon: 11.2,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots("nom_west", Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

async function plannedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST }] });
  return plan;
}

/** Anything still in the pool, i.e. not placed in a day. */
function poolRefs(plan: Awaited<ReturnType<typeof plannedTrip>>) {
  return plan.legs[0].pool.map((c) => c.osmRef);
}

function plannedRefs(plan: Awaited<ReturnType<typeof plannedTrip>>) {
  return plan.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
}

function firstSpotBlock(plan: Awaited<ReturnType<typeof plannedTrip>>) {
  const block = plan.legs[0].days[0].blocks.find((b) => b.kind === "spots");
  if (!block) throw new Error("this trip has no block that holds spots");
  return block;
}

describe("placing a candidate from the pool", () => {
  it("moves it out of the pool and into the day", async () => {
    const plan = await plannedTrip();
    const waiting = poolRefs(plan)[0];
    const block = firstSpotBlock(plan);

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: waiting,
    });

    expect(plannedRefs(after)).toContain(waiting);
    // In two places at once would double-count the budget.
    expect(poolRefs(after)).not.toContain(waiting);
  });

  it("puts it exactly where it was dropped", async () => {
    const plan = await plannedTrip();
    const waiting = poolRefs(plan)[0];
    const block = firstSpotBlock(plan);

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: waiting, position: 0,
    });

    const stops = after.legs[0].days[0].blocks.find((b) => b.id === block.id)!.stops;
    expect(stops[0].osmRef).toBe(waiting);
  });

  it("pins it, so the next redistribution leaves it alone", async () => {
    // The one decision a person made deliberately on this screen. A
    // redistribution that moved it away would undo exactly that (§5).
    const plan = await plannedTrip();
    const waiting = poolRefs(plan)[0];
    const block = firstSpotBlock(plan);

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: waiting,
    });

    const placed = after.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.osmRef === waiting);
    expect(placed?.pinned).toBe(true);
  });

  it("recomputes the walk rather than leaving a placeholder", async () => {
    // It goes in with zero travel and the day is rewalked; a zero left
    // standing would make the block look free.
    const plan = await plannedTrip();
    const waiting = poolRefs(plan)[0];
    const block = firstSpotBlock(plan);

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: waiting, position: 0,
    });

    const stops = after.legs[0].days[0].blocks.find((b) => b.id === block.id)!.stops;
    const second = stops[1];
    if (second) expect(second.travelFromPrevious.distanceM).toBeGreaterThan(0);
    expect(stops[0].travelFromPrevious.distanceM).toBeGreaterThan(0);
  });

  it("reports an overfull block instead of refusing the gesture (§8.4)", async () => {
    const plan = await plannedTrip();
    const block = firstSpotBlock(plan);
    let overfull: string[] = [];

    // Keep stuffing the same block; a morning does not hold the pool.
    for (const ref of poolRefs(plan)) {
      const result = await placeFromPool({
        planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: ref,
      });
      overfull = result.overfullBlockIds;
      if (overfull.length > 0) break;
    }

    expect(overfull).toContain(block.id);
  });

  it("carries the note and the link onto the planned stop (§9.2)", async () => {
    // The pool row is deleted by the placement. If the note did not
    // travel with it, acting on a find would be the moment its reason
    // disappeared — the opposite of what §9.2 asks for.
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      lat: WEST.lat + 0.02,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      sourceUrl: "https://beispiel.test/zehn-cafes",
      dwellMinutes: 30,
    });
    const { plan: withFind } = await getTripPlan({ planId: plan.id });
    const find = withFind.legs[0].pool.find((c) => c.name === "Café Beispielhof")!;

    const { plan: after } = await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: firstSpotBlock(withFind).id, osmRef: find.osmRef,
    });

    const planted = after.legs[0].days[0].blocks
      .flatMap((b) => b.stops)
      .find((s) => s.osmRef === find.osmRef);
    expect(planted?.note).toBe("beste Pastéis laut Blog");
    expect(planted?.sourceUrl).toBe("https://beispiel.test/zehn-cafes");
  });

  it("refuses a block that holds time rather than places", async () => {
    // A meal block is an hour and a rough area, never a venue (§10.3).
    const plan = await plannedTrip();
    const meal = plan.legs[0].days[0].blocks.find((b) => b.kind !== "spots");
    if (!meal) return;

    await expect(placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: meal.id, osmRef: poolRefs(plan)[0],
    })).rejects.toThrow(/holds time/);
  });

  it("says so when the spot is not in this leg's pool", async () => {
    const plan = await plannedTrip();
    await expect(placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: firstSpotBlock(plan).id, osmRef: "node:9999",
    })).rejects.toThrow(/nicht im Vorrat/);
  });

  it("refuses a day that is only framed, and says to plan it first", async () => {
    // A day at trip resolution has budgets and no stops (§4.3); half
    // filling it behind the traveller's back is worse than saying no.
    const plan = await plannedTrip();
    const block = firstSpotBlock(plan);
    await db
      .update(tripPlanDays)
      .set({ detailed: false })
      .where(eq(tripPlanDays.id, plan.legs[0].days[0].id));

    await expect(placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: poolRefs(plan)[0],
    })).rejects.toThrow(/noch nicht ausgeplant/);
  });
});

describe("dropping a candidate", () => {
  it("takes it out of the pool", async () => {
    const plan = await plannedTrip();
    const unwanted = poolRefs(plan)[0];

    const { plan: after } = await dropFromPool({ planId: plan.id, osmRef: unwanted });

    expect(poolRefs(after)).not.toContain(unwanted);
  });

  it("takes a hand-added find with it, note and all", async () => {
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      lat: WEST.lat + 0.02,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      dwellMinutes: 30,
    });
    const { plan: withFind } = await getTripPlan({ planId: plan.id });
    const find = withFind.legs[0].pool.find((c) => c.name === "Café Beispielhof");
    expect(find).toBeTruthy();

    const { plan: after } = await dropFromPool({ planId: plan.id, osmRef: find!.osmRef });
    expect(after.legs[0].pool.some((c) => c.name === "Café Beispielhof")).toBe(false);
  });

  it("says so when it is not there", async () => {
    const plan = await plannedTrip();
    await expect(dropFromPool({ planId: plan.id, osmRef: "node:9999" }))
      .rejects.toThrow(/nicht im Vorrat/);
  });

  it("is open to everybody on the trip, not just the organiser (§6.2)", async () => {
    const plan = await plannedTrip();
    await inviteToTrip({ planId: plan.id, email: companionEmail });
    const unwanted = poolRefs(plan)[0];

    actAs(companionId);
    await expect(dropFromPool({ planId: plan.id, osmRef: unwanted })).resolves.toBeTruthy();
  });
});

describe("what a pool entry carries", () => {
  it("keeps the note and the link a person saved it with (§9.2)", async () => {
    // Why it was saved beats what it is called when you are choosing
    // what to do with an afternoon — and it was being dropped on the
    // way out of the database.
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      lat: WEST.lat + 0.02,
      lon: WEST.lon,
      name: "Café Beispielhof",
      note: "beste Pastéis laut Blog",
      sourceUrl: "https://beispiel.test/zehn-cafes",
      dwellMinutes: 30,
    });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    const find = after.legs[0].pool.find((c) => c.name === "Café Beispielhof");

    expect(find?.note).toBe("beste Pastéis laut Blog");
    expect(find?.sourceUrl).toBe("https://beispiel.test/zehn-cafes");
    expect(find?.origin).toBe("manual");
  });

  it("marks a candidate the region search produced as such", async () => {
    const plan = await plannedTrip();
    expect(plan.legs[0].pool[0].origin).toBe("search");
    expect(plan.legs[0].pool[0].note).toBeNull();
  });
});

describe("deleting a trip", () => {
  it("removes it from the list", async () => {
    const plan = await plannedTrip();
    const { deleted } = await deleteTripPlan({ planId: plan.id });

    expect(deleted).toBe(true);
    const { plans } = await listTripPlans();
    expect(plans.map((p) => p.id)).not.toContain(plan.id);
    await expect(getTripPlan({ planId: plan.id })).rejects.toThrow(/not found/);
  });

  it("takes the days, the stops and the pool with it", async () => {
    // All of it cascades from the plan row; a table added later without
    // the cascade would surface here as a foreign-key error.
    const plan = await plannedTrip();
    await deleteTripPlan({ planId: plan.id });

    const legs = await db
      .select({ id: tripPlanLegs.id })
      .from(tripPlanLegs)
      .where(eq(tripPlanLegs.plan_id, plan.id));
    expect(legs).toEqual([]);
  });

  it("is the organiser's alone — a companion is told who can", async () => {
    // Deleting takes the trip away from everybody it was shared with,
    // which makes it the largest change to the frame there is (§6.2).
    const plan = await plannedTrip();
    await inviteToTrip({ planId: plan.id, email: companionEmail });

    actAs(companionId);
    await expect(deleteTripPlan({ planId: plan.id })).rejects.toThrow(/angelegt hat/);

    actAs(ownerId);
    await expect(getTripPlan({ planId: plan.id })).resolves.toBeTruthy();
  });

  it("tells somebody who was never on it that there is nothing there", async () => {
    const plan = await plannedTrip();
    const strangerId = await makeUser(`fremd-${Date.now()}@test.invalid`, "Fremde");
    actAs(strangerId);
    await expect(deleteTripPlan({ planId: plan.id })).rejects.toThrow(/plan not found/);
  });
});
