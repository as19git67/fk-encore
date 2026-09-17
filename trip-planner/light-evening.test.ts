/**
 * "Als Abendtermin einplanen?" (§7.3)
 *
 * The proposal is the one place where a minute-accurate window may
 * become a time somebody can miss — so the cases that matter are the
 * ones where it stays quiet: nothing marked, nothing after the day
 * ends, and nothing worth a trip out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { osmRegionImports, tripPlans, users } from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { acceptEveningLight, eveningLight } from "./light-evening";
import { loadPlan, type StoredPlan } from "./plan-store";
import { createTripPlan, moveTripStop } from "./plans";
import { saveTripSpotNote } from "./spot-notes";
import { addTripFixpoint } from "./fixpoint-edit";
import { hideTripSpot } from "./hidden-spots";
import { returnStopToPool } from "./to-pool";

/** Munich in July: the sun sets late, so the evening is a real one. */
const MUNICH = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";
const START = "2027-07-01";

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0002,
    lon: MUNICH.lon,
    distanceM: n * 22,
    detourM: null,
    name: `Aussichtsterrasse ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=viewpoint",
    categories: ["viewpoint"],
    wikidataQid: `Q${n}`,
    wikipedia: null,
    openingHours: null,
    cuisine: null,
    wheelchair: null,
    outdoorSeating: null,
    dietVegetarian: null,
    dietVegan: null,
    phone: null,
    website: null,
    // A west-facing facade: front-lit in the evening (§7.3).
    facadeAzimuth: 270,
  };
}

let ownerId = 0;

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

async function trip() {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate: START, days: 1 }],
  });
  return plan;
}

/** Mark a spot as one the group comes to for the light (§7.3). */
async function markPhotoStop(planId: number, osmRef: string) {
  await saveTripSpotNote({ planId, legIndex: 0, osmRef, photoStop: true });
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [row] = await db
    .insert(users)
    .values({ email: `licht-${stamp}@test.invalid`, name: "Fotografin", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = row.id;
  actAs(ownerId);

  await db.insert(osmRegionImports).values({
    slug: "europe/west",
    geofabrik_url: "https://example.com/x.pbf",
    postgres_db: DB,
    bbox_min_lat: 47.9,
    bbox_min_lon: 11.2,
    bbox_max_lat: 48.5,
    bbox_max_lon: 11.9,
    status: "ready_running",
  });
  const geo = new InMemoryGeoClient();
  geo.setSearchSpots(DB, Array.from({ length: 12 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("the evening proposal", () => {
  it("says nothing when nobody marked a photo stop", async () => {
    // The ordinary case, and the one that keeps this from being a nag.
    const plan = await trip();

    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposals).toEqual([]);
  });

  it("names the spot, the window and what the sun does to it", async () => {
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const anySpot = stored!.legs[0].pool[0] ?? stored!.legs[0].days[0].blocks
      .flatMap((b) => b.stops)[0];
    await markPhotoStop(plan.id, anySpot.osmRef);

    const { proposals, date } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(date).toBe(START);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].sentence).toContain("Als Abendtermin einplanen?");
    expect(proposals[0].sentence).toContain("ca.");
    expect(["golden", "blue"]).toContain(proposals[0].kind);
    expect(proposals[0].label).not.toBe(proposals[0].osmRef);
  });

  it("offers one evening at a time, not a list", async () => {
    // One evening holds one outing; five proposals would be a decision,
    // and this is a hint (§7.3).
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const refs = [
      ...stored!.legs[0].pool.map((c) => c.osmRef),
      ...stored!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef)),
    ].slice(0, 4);
    for (const ref of refs) await markPhotoStop(plan.id, ref);

    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(proposals.length).toBeLessThanOrEqual(1);
  });

  it("says nothing about a trip without dates", async () => {
    // No date, no sun — and guessing one moves the day by however far
    // the guess was wrong.
    const { plan } = await createTripPlan({ legs: [{ title: "München", anchor: MUNICH }] });

    const { date, proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    expect(date).toBeNull();
    expect(proposals).toEqual([]);
  });

  it("refuses a day that is not in the trip", async () => {
    const plan = await trip();

    await expect(eveningLight({ planId: plan.id, dayIndex: 9, utcOffsetMinutes: 120 }))
      .rejects.toThrow(/day 9 not found/);
  });

  it("does not open somebody else's trip", async () => {
    const plan = await trip();
    const [other] = await db
      .insert(users)
      .values({
        email: `fremd-${Date.now()}${Math.random()}@test.invalid`,
        name: "Fremde",
        password_hash: "x",
      })
      .returning({ id: users.id });
    actAs(other.id);

    await expect(eveningLight({ planId: plan.id })).rejects.toThrow(/plan not found/);
  });

  it("leaves the plan alone — it only says a sentence", async () => {
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const before = stored!.legs[0].days[0].fixpoints.length;
    const anySpot = stored!.legs[0].pool[0] ?? stored!.legs[0].days[0].blocks
      .flatMap((b) => b.stops)[0];
    await markPhotoStop(plan.id, anySpot.osmRef);

    await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });

    // The proposal is a sentence: no fixpoint, no re-plan. A time
    // somebody can miss exists only once a person accepts it (§7.3).
    const after = await loadPlan(plan.id, ownerId);
    expect(after!.legs[0].days[0].fixpoints).toHaveLength(before);
    const stops = after!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(stops).toEqual(
      stored!.legs[0].days[0].blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
  });
});

describe("accepting the evening (§7.3)", () => {
  /** A trip with one photo stop and the proposal it produces. */
  async function proposed() {
    const plan = await trip();
    const stored = await loadPlan(plan.id, ownerId);
    const anySpot = stored!.legs[0].pool[0] ?? stored!.legs[0].days[0].blocks
      .flatMap((b) => b.stops)[0];
    await markPhotoStop(plan.id, anySpot.osmRef);
    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });
    expect(proposals).toHaveLength(1);
    return { plan, proposal: proposals[0] };
  }

  const eveningOf = (p: StoredPlan) =>
    [...p.legs[0].days[0].blocks].reverse().find((b) => b.kind === "spots")!;

  it("puts the spot into the day's last block, at the window, pinned", async () => {
    // The complaint this answers: the outing used to be a line in the
    // band of fixed times while the spot stayed in the pool — two
    // places to watch for one evening.
    const { plan, proposal } = await proposed();

    const { plan: after } = await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });

    const evening = eveningOf(after);
    expect(evening.stops.map((s) => s.osmRef)).toEqual([proposal.osmRef]);
    expect(evening.stops[0].pinned).toBe(true);
    // For as long as the light lasts, and the block ends when it does.
    expect(evening.stops[0].dwellMinutes).toBe(proposal.toMinutes - proposal.fromMinutes);
    expect(evening.startMinutes! + evening.budgetMinutes).toBe(proposal.toMinutes);
    expect(evening.startMinutes!).toBeLessThanOrEqual(proposal.fromMinutes);
  });

  it("is one place: not in the pool, not on another block, framed on this one", async () => {
    const { plan, proposal } = await proposed();

    const { plan: after } = await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });

    const day = after.legs[0].days[0];
    expect(after.legs[0].pool.map((c) => c.osmRef)).not.toContain(proposal.osmRef);
    const elsewhere = day.blocks
      .filter((b) => b.id !== eveningOf(after).id)
      .flatMap((b) => b.stops.map((s) => s.osmRef));
    expect(elsewhere).not.toContain(proposal.osmRef);
    // The fixpoint says which block it frames and for which spot — the
    // band can leave it out and the block can show it.
    const frames = day.fixpoints.filter((f) => f.blockId);
    expect(frames).toHaveLength(1);
    expect(frames[0].blockId).toBe(eveningOf(after).id);
    expect(frames[0].spotRef).toBe(proposal.osmRef);
    expect(frames[0].lat).toBeCloseTo(proposal.lat, 5);
  });

  it("stops proposing once the evening is planned", async () => {
    // The planned day now ends when the light does; a proposal for the
    // same window would be the app talking about its own plan.
    const { plan, proposal } = await proposed();
    await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });

    const { proposals } = await eveningLight({ planId: plan.id, utcOffsetMinutes: 120 });
    expect(proposals).toEqual([]);
  });

  it("survives the next re-plan", async () => {
    // A frame is part of what the traveller set, not of what the solver
    // chose: any re-plan — here, a breakfast booking — has to hand the
    // evening back with its spot in it.
    const { plan, proposal } = await proposed();
    await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });

    const { plan: after } = await addTripFixpoint({
      planId: plan.id, dayIndex: 0, label: "Frühstück", at: "08:00", durationMinutes: 30,
    });

    const evening = eveningOf(after);
    expect(evening.stops.map((s) => s.osmRef)).toEqual([proposal.osmRef]);
    expect(evening.stops[0].pinned).toBe(true);
  });

  it("refuses a spot that is not in this evening's light", async () => {
    const { plan } = await proposed();
    await expect(acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: "way:999", utcOffsetMinutes: 120,
    })).rejects.toThrow(/nicht mehr im Licht/);
  });

  it("will not let the spot be dragged out of the block it frames", async () => {
    const { plan, proposal } = await proposed();
    const { plan: after } = await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });
    const stop = eveningOf(after).stops[0];
    const other = after.legs[0].days[0].blocks.find((b) => b.kind === "spots" && b.id !== eveningOf(after).id)!;

    await expect(moveTripStop({
      planId: plan.id, stopId: stop.rowId, toDayIndex: 0, toBlockId: other.id,
    })).rejects.toThrow(/Abendtermin/);
  });

  it("takes the frame away with a hidden spot", async () => {
    const { plan, proposal } = await proposed();
    await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });

    const { plan: after } = await hideTripSpot({ planId: plan.id, osmRef: proposal.osmRef });

    const day = after.legs[0].days[0];
    expect(day.fixpoints.filter((f) => f.blockId)).toEqual([]);
    // And the evening is an ordinary evening again, not a block at
    // 20:10 with nothing in it.
    const evening = eveningOf(after);
    expect(evening.startMinutes).toBeLessThan(proposal.fromMinutes);
  });

  it("will not return the spot to the pool underneath its frame", async () => {
    // "Not today" is said by taking the outing off the block; a stop
    // returned underneath the frame would leave an evening at 20:10
    // with nothing in it.
    const { plan, proposal } = await proposed();
    const { plan: after } = await acceptEveningLight({
      planId: plan.id, dayIndex: 0, osmRef: proposal.osmRef, utcOffsetMinutes: 120,
    });
    const stop = eveningOf(after).stops[0];

    await expect(returnStopToPool({ planId: plan.id, stopId: stop.rowId }))
      .rejects.toThrow(/Abendtermin/);
  });
});
