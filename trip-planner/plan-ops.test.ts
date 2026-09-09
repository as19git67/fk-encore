/**
 * Buffered changes, merged rather than overwritten (§6.3).
 *
 * The three things that decide whether offline editing helps or
 * destroys: a batch that arrives twice must not be applied twice, two
 * people's independent changes must both survive, and the journal has
 * to say who did what — including that one kind of change cannot be
 * taken back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  osmRegionImports,
  tripHiddenSpots,
  tripPlanOps,
  tripPlanShares,
  tripPlans,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan, getTripPlan } from "./plans";
import { applyPlanOps, planJournal, undoPlanOp } from "./plan-ops";

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

function plannedRefs(plan: {
  legs: { days: { blocks: { stops: { osmRef: string }[] }[] }[] }[];
}): string[] {
  return plan.legs[0].days.flatMap((day) =>
    day.blocks.flatMap((block) => block.stops.map((stop) => stop.osmRef)));
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

describe("handing over what a device buffered", () => {
  it("applies the operations in order", async () => {
    const plan = await trip();
    const [first, second] = pooled(plan);

    const { results } = await applyPlanOps({
      planId: plan.id,
      ops: [
        { clientOpId: "a", kind: "hide-spot", payload: { osmRef: first } },
        { clientOpId: "b", kind: "vote", payload: { osmRef: second, value: "want" } },
      ],
    });

    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    const hidden = await db.select().from(tripHiddenSpots)
      .where(eq(tripHiddenSpots.plan_id, plan.id));
    expect(hidden.map((row) => row.osm_ref)).toEqual([first]);
  });

  it("recognises a batch that arrives twice", async () => {
    // The connection that dropped mid-request is exactly what the id
    // minted on the device is for (§6.3).
    const plan = await trip();
    const ops = [{
      clientOpId: "same-id",
      kind: "hide-spot",
      payload: { osmRef: pooled(plan)[0] },
    }];
    await applyPlanOps({ planId: plan.id, ops });

    const { results } = await applyPlanOps({ planId: plan.id, ops });

    expect(results[0].status).toBe("duplicate");
    const journal = await planJournal({ planId: plan.id });
    expect(journal.entries).toHaveLength(1);
  });

  it("keeps the others when one operation fails", async () => {
    const plan = await trip();
    const good = pooled(plan)[0];

    const { results } = await applyPlanOps({
      planId: plan.id,
      ops: [
        { clientOpId: "a", kind: "hide-spot", payload: { osmRef: "node:does-not-exist" } },
        { clientOpId: "b", kind: "hide-spot", payload: { osmRef: good } },
      ],
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].message).toBeTruthy();
    expect(results[1].status).toBe("applied");
  });

  it("does not journal an operation that was refused", async () => {
    const plan = await trip();

    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: "node:nope" } }],
    });

    expect((await planJournal({ planId: plan.id })).entries).toEqual([]);
  });

  it("refuses the whole batch when one entry is malformed", async () => {
    // Applied in order, so a refusal halfway through would leave a trip
    // that is neither the old one nor the new one.
    const plan = await trip();

    await expect(applyPlanOps({
      planId: plan.id,
      ops: [
        { clientOpId: "a", kind: "hide-spot", payload: { osmRef: pooled(plan)[0] } },
        { clientOpId: "b", kind: "vote", payload: { osmRef: "way:2" } },
      ],
    })).rejects.toThrow(/value is required/);

    expect(await db.select().from(tripHiddenSpots)
      .where(eq(tripHiddenSpots.plan_id, plan.id))).toEqual([]);
  });

  it("refuses a word it does not know", async () => {
    const plan = await trip();

    await expect(applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "drop-the-trip", payload: {} }],
    })).rejects.toThrow(/unknown operation/);
  });

  it("keeps both people's changes rather than the last writer's", async () => {
    // The whole reason the plan is never written as a document (§6.3).
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: papaId });
    const [mine, theirs] = pooled(plan);

    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "anna-1", kind: "hide-spot", payload: { osmRef: mine } }],
    });
    actAs(papaId);
    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "papa-1", kind: "hide-spot", payload: { osmRef: theirs } }],
    });

    const hidden = (await db.select().from(tripHiddenSpots)
      .where(eq(tripHiddenSpots.plan_id, plan.id))).map((row) => row.osm_ref);
    expect(hidden.sort()).toEqual([mine, theirs].sort());
  });

  it("hands back the trip once, so a device can replace its copy", async () => {
    const plan = await trip();

    const { plan: after } = await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: pooled(plan)[0] } }],
    });

    expect(after.id).toBe(plan.id);
    expect(pooled(after)).not.toContain(pooled(plan)[0]);
  });

  it("lets nobody who is not on the trip write to it", async () => {
    const plan = await trip();
    actAs(papaId);

    await expect(applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: "way:1" } }],
    })).rejects.toThrow(/plan not found/);
  });
});

describe("who changed what", () => {
  it("says it in a sentence, with a name", async () => {
    const plan = await trip();
    const ref = pooled(plan)[0];
    const name = plan.legs[0].pool.find((c) => c.osmRef === ref)!.name;

    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: ref } }],
    });

    const [entry] = (await planJournal({ planId: plan.id })).entries;
    expect(entry.actor).toBe("Anna");
    expect(entry.sentence).toContain(name!);
    expect(entry.undoable).toBe(true);
  });

  it("newest first", async () => {
    const plan = await trip();
    const [first, second] = pooled(plan);
    await applyPlanOps({
      planId: plan.id,
      ops: [
        { clientOpId: "a", kind: "vote", payload: { osmRef: first, value: "want" } },
        { clientOpId: "b", kind: "vote", payload: { osmRef: second, value: "rather-not" } },
      ],
    });

    const { entries } = await planJournal({ planId: plan.id });

    expect(entries[0].sentence).toContain("lieber nicht");
  });
});

describe("taking a change back", () => {
  it("puts the spot back and records both steps", async () => {
    const plan = await trip();
    const ref = pooled(plan)[0];
    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: ref } }],
    });
    const [hidden] = (await planJournal({ planId: plan.id })).entries;

    const { entries } = await undoPlanOp({ planId: plan.id, opId: hidden.id });

    expect(await db.select().from(tripHiddenSpots)
      .where(eq(tripHiddenSpots.plan_id, plan.id))).toEqual([]);
    // Nothing deleted: the journal is what happened (§6.3).
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === hidden.id)?.undoneBy).toBe("Anna");
  });

  it("restores the answer a vote replaced", async () => {
    const plan = await trip();
    const ref = pooled(plan)[0];
    await applyPlanOps({
      planId: plan.id,
      ops: [
        { clientOpId: "a", kind: "vote", payload: { osmRef: ref, value: "want" } },
        { clientOpId: "b", kind: "vote", payload: { osmRef: ref, value: "rather-not" } },
      ],
    });
    const changed = (await planJournal({ planId: plan.id })).entries[0];

    await undoPlanOp({ planId: plan.id, opId: changed.id });

    const { entries } = await planJournal({ planId: plan.id });
    expect(entries[0].sentence).toContain("will ich");
  });

  it("refuses to undo the same change twice", async () => {
    const plan = await trip();
    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: pooled(plan)[0] } }],
    });
    const [entry] = (await planJournal({ planId: plan.id })).entries;
    await undoPlanOp({ planId: plan.id, opId: entry.id });

    await expect(undoPlanOp({ planId: plan.id, opId: entry.id }))
      .rejects.toThrow(/schon zurückgenommen/);
  });

  it("says why a re-solved day cannot be undone", async () => {
    // §6.3: putting the stop back would be a new decision, and calling
    // that "undo" is worse than a button that refuses.
    const plan = await trip();
    const stopId = plan.legs[0].days[0].blocks
      .flatMap((block) => block.stops)
      .map((stop) => (stop as unknown as { rowId: number }).rowId)[0];
    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "stop-to-pool", payload: { stopId } }],
    });
    const [entry] = (await planJournal({ planId: plan.id })).entries;

    expect(entry.undoable).toBe(false);
    await expect(undoPlanOp({ planId: plan.id, opId: entry.id }))
      .rejects.toThrow(/neue Entscheidung/);
  });

  it("does not undo a change belonging to another trip", async () => {
    const plan = await trip();
    const other = await trip();
    await applyPlanOps({
      planId: other.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: pooled(other)[0] } }],
    });
    const [entry] = (await planJournal({ planId: other.id })).entries;

    await expect(undoPlanOp({ planId: plan.id, opId: entry.id }))
      .rejects.toThrow(/gehört nicht zu dieser Reise/);
  });
});

describe("the trip a batch leaves behind", () => {
  it("is the one the ops describe, read back fresh", async () => {
    const plan = await trip();
    const stop = plannedRefs(plan)[0];

    await applyPlanOps({
      planId: plan.id,
      ops: [{ clientOpId: "a", kind: "hide-spot", payload: { osmRef: stop } }],
    });

    const { plan: fresh } = await getTripPlan({ planId: plan.id });
    expect(plannedRefs(fresh)).not.toContain(stop);
  });
});
