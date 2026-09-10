/**
 * Splitting a block for real (§6.5).
 *
 * What the endpoints have to get right beyond the arithmetic: a split
 * is an attribute of a block rather than a second trip, nobody walks in
 * two branches at once, each branch really is planned by the solver,
 * and putting the group back together leaves an ordinary block.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  osmRegionImports,
  tripPlanBranches,
  tripPlanShares,
  tripPlanTravellers,
  tripPlans,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { loadBranches } from "./branch-store";
import { castVote } from "./plan-votes";
import { loadPlan } from "./plan-store";
import { createTripPlan } from "./plans";
import { createSplit, removeSplit, splitSuggestion } from "./splits";

const MUNICH = { lat: 48.14, lon: 11.58 };
const DB = "nom_west";

function spot(n: number): GeoPoiSearchSpot {
  return {
    osmRef: `way:${n}`,
    type: "way",
    id: n,
    lat: MUNICH.lat + n * 0.0002,
    lon: MUNICH.lon,
    distanceM: n * 22,
    detourM: null,
    name: `Ort ${n}`,
    nameDe: null,
    nameEn: null,
    kind: "tourism=attraction",
    categories: ["sight"],
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
    facadeAzimuth: null,
  };
}

let annaId = 0;
let papaId = 0;

async function makeUser(prefix: string, name: string, stamp: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${prefix}-${stamp}@test.invalid`, name, password_hash: "x" })
    .returning({ id: users.id });
  return row.id;
}

function actAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["photos.view"],
  });
}

async function trip() {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate: "2027-07-01", days: 2 }],
  });
  return plan;
}

function pooled(plan: { legs: { pool: { osmRef: string }[] }[] }): string[] {
  return plan.legs[0].pool.map((c) => c.osmRef);
}

/** The block of day 0 that has a clock time and some room in it. */
function firstBlockIndex(plan: {
  legs: { days: { blocks: { startMinutes: number | null }[] }[] }[];
}): number {
  return plan.legs[0].days[0].blocks.findIndex((block) => block.startMinutes !== null);
}

beforeEach(async () => {
  await db.delete(tripPlans);
  await db.delete(osmRegionImports);
  clearRouterCache();
  const stamp = `${Date.now()}-${Math.random()}`;
  annaId = await makeUser("anna", "Anna", stamp);
  papaId = await makeUser("papa", "Papa", stamp);
  actAs(annaId);

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
  geo.setSearchSpots(DB, Array.from({ length: 60 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("does the planner offer a split", () => {
  it("when two spots divide the group", async () => {
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: papaId });
    const [mine, theirs] = pooled(plan);
    await castVote({ planId: plan.id, osmRef: mine, value: "want" });
    actAs(papaId);
    await castVote({ planId: plan.id, osmRef: theirs, value: "want" });
    actAs(annaId);

    const { suggestion } = await splitSuggestion({ planId: plan.id });

    expect(suggestion).not.toBeNull();
    expect([suggestion!.a.osmRef, suggestion!.b.osmRef].sort()).toEqual([mine, theirs].sort());
    expect(suggestion!.sentence).toContain("trennen");
  });

  it("and stays quiet when nobody has said anything", async () => {
    const plan = await trip();

    expect((await splitSuggestion({ planId: plan.id })).suggestion).toBeNull();
  });
});

describe("separating", () => {
  it("plans each branch and gives each its own people", async () => {
    const plan = await trip();
    const blockIndex = firstBlockIndex(plan);
    const [mine, theirs] = pooled(plan);
    const [child] = await db
      .insert(tripPlanTravellers)
      .values({ plan_id: plan.id, label: "Kind A", added_by: annaId })
      .returning({ id: tripPlanTravellers.id });

    const { plan: after } = await createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex,
      meetAt: "13:00",
      meetingLabel: "Am Brunnen",
      branches: [
        { label: "Ins Museum", userIds: [annaId], osmRefs: [mine] },
        { label: "Auf den Markt", travellerIds: [child.id], osmRefs: [theirs] },
      ],
    });

    const stored = await loadPlan(after.id, annaId);
    const block = stored!.legs[0].days[0].blocks[blockIndex];
    const branches = (await loadBranches([block.rowId])).get(block.rowId) ?? [];
    expect(branches).toHaveLength(2);
    expect(branches[0].label).toBe("Ins Museum");
    expect(branches[0].members.map((m) => m.name)).toEqual(["Anna"]);
    expect(branches[1].members.map((m) => m.name)).toEqual(["Kind A"]);
    expect(branches[0].stops.map((s) => s.osmRef)).toContain(mine);
    expect(branches[1].stops.map((s) => s.osmRef)).toContain(theirs);
  });

  it("ends every branch at the same meeting point and time", async () => {
    const plan = await trip();
    const blockIndex = firstBlockIndex(plan);
    const [mine, theirs] = pooled(plan);

    await createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex,
      meetAt: "13:00",
      branches: [
        { label: "A", userIds: [annaId], osmRefs: [mine] },
        { label: "B", userIds: [papaId], osmRefs: [theirs] },
      ],
    });

    const stored = await loadPlan(plan.id, annaId);
    const block = stored!.legs[0].days[0].blocks[blockIndex];
    const branches = (await loadBranches([block.rowId])).get(block.rowId) ?? [];
    expect(branches.every((b) => b.meetingMinutes === 13 * 60)).toBe(true);
    // Each branch gets its own budget from that one meeting (§6.5).
    expect(branches.every((b) => b.budgetMinutes > 0)).toBe(true);
  });

  it("refuses to put somebody in two places at once", async () => {
    const plan = await trip();
    const blockIndex = firstBlockIndex(plan);

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex,
      meetAt: "13:00",
      branches: [
        { label: "A", userIds: [annaId] },
        { label: "B", userIds: [annaId] },
      ],
    })).rejects.toThrow(/zwei Zweigen/);
  });

  it("refuses a split with one branch, which is not a split", async () => {
    const plan = await trip();

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex: firstBlockIndex(plan),
      meetAt: "13:00",
      branches: [{ label: "Allein", userIds: [annaId] }],
    })).rejects.toThrow(/mindestens zwei Zweige/);
  });

  it("refuses a meeting before the group even sets off", async () => {
    const plan = await trip();

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex: firstBlockIndex(plan),
      meetAt: "00:30",
      branches: [
        { label: "A", userIds: [annaId] },
        { label: "B", userIds: [papaId] },
      ],
    })).rejects.toThrow(/vor dem Aufbruch/);
  });

  it("refuses a clock time it cannot read", async () => {
    const plan = await trip();

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex: firstBlockIndex(plan),
      meetAt: "mittags",
      branches: [
        { label: "A", userIds: [annaId] },
        { label: "B", userIds: [papaId] },
      ],
    })).rejects.toThrow(/meetAt must be a time of day/);
  });

  it("says when separating would leave too little time to be worth it", async () => {
    const plan = await trip();
    const blockIndex = firstBlockIndex(plan);
    const start = plan.legs[0].days[0].blocks[blockIndex].startMinutes!;
    const soon = `${String(Math.floor((start + 25) / 60)).padStart(2, "0")}:`
      + `${String((start + 25) % 60).padStart(2, "0")}`;

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex,
      meetAt: soon,
      branches: [
        { label: "A", userIds: [annaId] },
        { label: "B", userIds: [papaId] },
      ],
    })).rejects.toThrow(/lohnt sich das Trennen nicht/);
  });

  it("lets nobody who is not on the trip open one", async () => {
    const plan = await trip();
    actAs(papaId);

    await expect(createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex: 0,
      meetAt: "13:00",
      branches: [{ label: "A" }, { label: "B" }],
    })).rejects.toThrow(/plan not found/);
  });
});

describe("coming back together", () => {
  it("leaves an ordinary block, planned as one", async () => {
    const plan = await trip();
    const blockIndex = firstBlockIndex(plan);
    const [mine, theirs] = pooled(plan);
    await createSplit({
      planId: plan.id,
      dayIndex: 0,
      blockIndex,
      meetAt: "13:00",
      branches: [
        { label: "A", userIds: [annaId], osmRefs: [mine] },
        { label: "B", userIds: [papaId], osmRefs: [theirs] },
      ],
    });

    const { plan: after } = await removeSplit({ planId: plan.id, dayIndex: 0, blockIndex });

    const stored = await loadPlan(after.id, annaId);
    const block = stored!.legs[0].days[0].blocks[blockIndex];
    expect(await db.select().from(tripPlanBranches)
      .where(eq(tripPlanBranches.block_id, block.rowId))).toEqual([]);
    expect(block.stops.length).toBeGreaterThan(0);
  });

  it("refuses to dissolve a block that was never split", async () => {
    const plan = await trip();

    await expect(removeSplit({
      planId: plan.id, dayIndex: 0, blockIndex: firstBlockIndex(plan),
    })).rejects.toThrow(/nicht geteilt/);
  });
});
