/**
 * "Not this one, and not next time either" (§5, §20.5).
 *
 * The cases that matter are about the two halves of the promise: the
 * spot leaves the plan now, and the search does not bring it back
 * later — across a re-plan, which is the moment the old behaviour
 * failed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan, updateTripSettings } from "./plans";
import { addFind } from "./add-find";
import { hideTripSpot, listTripHiddenSpots, unhideTripSpot } from "./hidden-spots";

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
    .values({ email: `ausblenden-${stamp}@test.invalid`, name: "Planerin", password_hash: "x" })
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

function everyRef(plan: Plan): string[] {
  return plan.legs.flatMap((leg) => [
    ...leg.pool.map((c) => c.osmRef),
    ...leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))),
  ]);
}

function plannedRefs(plan: Plan): string[] {
  return plan.legs[0].days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
}

describe("hiding a spot the search keeps proposing", () => {
  it("takes it off the plan and remembers why", async () => {
    const plan = await plannedTrip();
    const unwanted = plannedRefs(plan)[0];

    const result = await hideTripSpot({ planId: plan.id, osmRef: unwanted });

    expect(result.wasPlanned).toBe(true);
    expect(everyRef(result.plan)).not.toContain(unwanted);
    expect(result.hidden.map((h) => h.osmRef)).toEqual([unwanted]);
    // Named, because the list has to say which place it is offering to
    // bring back — and the map will not be asked again.
    expect(result.hidden[0].name).toBe(`Museum ${unwanted.split(":")[1]}`);
  });

  it("keeps it away when the trip is planned again", async () => {
    // The whole point: putting it back in the pool means meeting it on
    // the next re-plan, and the one after that (§5).
    const plan = await plannedTrip();
    const unwanted = plannedRefs(plan)[0];
    await hideTripSpot({ planId: plan.id, osmRef: unwanted });

    await updateTripSettings({ planId: plan.id, pace: "relaxed" });

    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(everyRef(after)).not.toContain(unwanted);
  });

  it("rewalks the day it left a gap in", async () => {
    const plan = await plannedTrip();
    const unwanted = plannedRefs(plan)[0];
    const before = plan.legs[0].days[0].blocks.find((b) => b.stops.length > 1);
    if (!before) throw new Error("this trip has no block with two stops to walk between");

    const result = await hideTripSpot({ planId: plan.id, osmRef: unwanted });

    const after = result.plan.legs[0].days[0].blocks.find((b) => b.id === before.id)!;
    // The walk either side of the gap changed, so the minutes did too.
    expect(after.usedMinutes).not.toBe(before.usedMinutes);
    expect(after.stops.map((s) => s.osmRef)).not.toContain(unwanted);
  });

  it("brings it back with one call, and says nothing else changed", async () => {
    const plan = await plannedTrip();
    const unwanted = plannedRefs(plan)[0];
    await hideTripSpot({ planId: plan.id, osmRef: unwanted });

    const { hidden } = await unhideTripSpot({ planId: plan.id, osmRef: unwanted });

    expect(hidden).toEqual([]);
    // Unhiding puts a spot back in the running, not back on a day: a
    // re-plan as a side effect of undoing a mistake would be the larger
    // surprise (§7.1).
    const { plan: after } = await getTripPlan({ planId: plan.id });
    expect(plannedRefs(after)).not.toContain(unwanted);

    // …and the next re-plan may propose it again.
    await updateTripSettings({ planId: plan.id, pace: "relaxed" });
    const { plan: replanned } = await getTripPlan({ planId: plan.id });
    expect(everyRef(replanned)).toContain(unwanted);
  });

  it("refuses to hide a find somebody brought in themselves", async () => {
    // It exists because a person added it, so removing it from the pool
    // removes it for good — a remembered "no" would be a note about a
    // spot nobody will ever be offered again.
    const plan = await plannedTrip();
    await addFind({
      planId: plan.id,
      name: "Der Geheimtipp",
      // Well away from the museums, so the find is its own place
      // rather than being merged into one of them.
      lat: WEST.lat - 0.01,
      lon: WEST.lon + 0.01,
      note: "vom Blog",
      // No OSM entry out there, so the find brings its own stay length.
      dwellMinutes: 45,
    });
    const { plan: withFind } = await getTripPlan({ planId: plan.id });
    const manual = withFind.legs[0].pool.find((c) => c.origin !== "search")!;

    await expect(hideTripSpot({ planId: plan.id, osmRef: manual.osmRef }))
      .rejects.toThrow(/selbst hinzugefügt/);
  });

  it("refuses a spot this trip has never heard of", async () => {
    const plan = await plannedTrip();
    await expect(hideTripSpot({ planId: plan.id, osmRef: "node:999999" }))
      .rejects.toThrow(/gehört nicht zu dieser Reise/);
  });

  it("refuses to unhide what was never hidden", async () => {
    const plan = await plannedTrip();
    await expect(unhideTripSpot({ planId: plan.id, osmRef: "node:1" }))
      .rejects.toThrow(/nicht ausgeblendet/);
  });

  it("lists what a trip has turned down", async () => {
    const plan = await plannedTrip();
    const first = plannedRefs(plan)[0];
    await hideTripSpot({ planId: plan.id, osmRef: first });
    const { plan: after } = await getTripPlan({ planId: plan.id });
    const second = after.legs[0].pool[0].osmRef;
    await hideTripSpot({ planId: plan.id, osmRef: second });

    const { hidden } = await listTripHiddenSpots({ planId: plan.id });

    expect(hidden.map((h) => h.osmRef).sort()).toEqual([first, second].sort());
  });
});
