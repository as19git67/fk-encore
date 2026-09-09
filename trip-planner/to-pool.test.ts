/**
 * Putting a planned spot back in the pool (§8.4).
 *
 * The gesture §8.4 names and the one thing it must not be confused
 * with: back in the pool is "not this afternoon", hiding is "not this
 * trip". So these cases are mostly about what stays true afterwards —
 * the spot is still in the running, the day adds up again, and what is
 * already past stays where it is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, setTripStopStatus, updateTripSettings } from "./plans";
import { addFind } from "./add-find";
import { placeFromPool } from "./pool";
import { returnStopToPool } from "./to-pool";

const WEST = { lat: 48.37, lon: 10.9 };

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

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = Date.now() + Math.random();
  const [row] = await db
    .insert(users)
    .values({ email: `vorrat-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(ownerId),
    permissions: ["photos.view"],
  });

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

type Plan = Awaited<ReturnType<typeof plannedTrip>>;

async function plannedTrip() {
  const { plan } = await createTripPlan({ legs: [{ title: "Weststadt", anchor: WEST }] });
  return plan;
}

function firstStop(plan: Plan) {
  for (const block of plan.legs[0].days[0].blocks) {
    if (block.stops.length > 0) return { block, stop: block.stops[0] };
  }
  throw new Error("this trip has nothing planned");
}

function poolRefs(plan: Plan) {
  return plan.legs[0].pool.map((c) => c.osmRef);
}

function plannedRefs(plan: Plan) {
  return plan.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
}

describe("putting a planned spot back in the pool", () => {
  it("takes it off the day and leaves it in the running", async () => {
    const plan = await plannedTrip();
    const { stop } = firstStop(plan);

    const { plan: after, name } = await returnStopToPool({ planId: plan.id, stopId: stop.rowId });

    expect(name).toBe(stop.name);
    expect(plannedRefs(after)).not.toContain(stop.osmRef);
    expect(poolRefs(after)).toContain(stop.osmRef);
  });

  it("gives it the boost a displaced spot gets", async () => {
    // It was wanted enough to be planned once, so it comes back ahead
    // of an equally scored newcomer rather than competing from scratch
    // (§5).
    const plan = await plannedTrip();
    const { stop } = firstStop(plan);

    const { plan: after } = await returnStopToPool({ planId: plan.id, stopId: stop.rowId });

    const returned = after.legs[0].pool.find((c) => c.osmRef === stop.osmRef)!;
    expect(returned.score).toBeGreaterThan(stop.score);
  });

  it("rewalks the day it left a gap in", async () => {
    const plan = await plannedTrip();
    const { block, stop } = firstStop(plan);

    const { plan: after } = await returnStopToPool({ planId: plan.id, stopId: stop.rowId });

    const sameBlock = after.legs[0].days[0].blocks.find((b) => b.id === block.id)!;
    expect(sameBlock.usedMinutes).toBeLessThan(block.usedMinutes);
  });

  it("does not fill the hole with something else", async () => {
    // Taking one spot out is not asking for the afternoon to be
    // rearranged — that is redistribution, and §5 has it as a thing you
    // ask for.
    const plan = await plannedTrip();
    const { stop } = firstStop(plan);
    const before = plannedRefs(plan);

    const { plan: after } = await returnStopToPool({ planId: plan.id, stopId: stop.rowId });

    expect(plannedRefs(after)).toEqual(before.filter((ref) => ref !== stop.osmRef));
  });

  it("refuses a spot that is already past", async () => {
    const plan = await plannedTrip();
    const { stop } = firstStop(plan);
    await setTripStopStatus({ planId: plan.id, stopId: stop.rowId, status: "done" });

    await expect(returnStopToPool({ planId: plan.id, stopId: stop.rowId }))
      .rejects.toThrow(/abgehakt/);
  });

  it("refuses a stop from somebody else's plan", async () => {
    const plan = await plannedTrip();
    await expect(returnStopToPool({ planId: plan.id, stopId: 999_999 }))
      .rejects.toThrow(/stop not found/);
  });
});

describe("what the pool remembers about a spot", () => {
  it("keeps a find a find, there and back again", async () => {
    // The pool row is deleted when a spot is planned, so its origin has
    // to travel with the stop (§9.2). Coming back as a search result
    // means the next re-plan deletes it.
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      name: "Der Geheimtipp",
      lat: WEST.lat - 0.01,
      lon: WEST.lon + 0.01,
      note: "vom Blog",
      dwellMinutes: 45,
    });
    const { plan: withFind } = await getTripPlan({ planId: plan.id });
    const find = withFind.legs[0].pool.find((c) => c.origin === "manual")!;
    const block = withFind.legs[0].days[0].blocks.find((b) => b.kind === "spots")!;

    await placeFromPool({
      planId: plan.id, dayIndex: 0, blockId: block.id, osmRef: find.osmRef,
    });
    const { plan: placed } = await getTripPlan({ planId: plan.id });
    const stop = placed.legs[0].days[0].blocks
      .flatMap((b) => b.stops).find((s) => s.osmRef === find.osmRef)!;

    const { plan: after } = await returnStopToPool({ planId: plan.id, stopId: stop.rowId });

    expect(after.legs[0].pool.find((c) => c.osmRef === find.osmRef)?.origin).toBe("manual");
  });

  it("does not turn everybody's finds into suggestions on a redistribution", async () => {
    // A re-plan keeps exactly the pool rows whose origin is not
    // "search". Rewriting the pool without its provenance therefore
    // deleted people's own finds one settings change later.
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      name: "Der Geheimtipp",
      lat: WEST.lat - 0.01,
      lon: WEST.lon + 0.01,
      note: "vom Blog",
      dwellMinutes: 45,
    });
    const { plan: withFind } = await getTripPlan({ planId: plan.id });
    const find = withFind.legs[0].pool.find((c) => c.origin === "manual")!;

    // Any write that rewrites the pool: returning a spot does it.
    const { stop } = firstStop(withFind);
    await returnStopToPool({ planId: plan.id, stopId: stop.rowId });
    await updateTripSettings({ planId: plan.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    const kept = after.legs[0].pool.find((c) => c.osmRef === find.osmRef);
    expect(kept?.origin).toBe("manual");
    expect(kept?.note).toBe("vom Blog");
  });
});
