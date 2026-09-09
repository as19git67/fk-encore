/**
 * Voting on a trip (§6.1).
 *
 * What the endpoints have to get right, beyond the arithmetic the pure
 * module already covers: that a vote actually reaches the plan, that a
 * heart wish is limited per leg rather than per swipe, that a proxy
 * voice counts as the child's and not as the grown-up's, and that
 * rating stays open to everybody on the trip (§6.2 reserves three
 * rights, and this is not one of them).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  osmRegionImports,
  tripPlanShares,
  tripPlanTravellers,
  tripPlanVotes,
  tripPlans,
  users,
} from "../db/schema";
import { clearRouterCache } from "../osm-admin/region-router";
import type { GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { resetGeoClient, setGeoClient } from "../osm-admin/geo-client";
import { InMemoryGeoClient } from "../osm-admin/geo-client.test-helper";
import { createTripPlan } from "./plans";
import { applyVotesToPlan, castVote, tripBallot, tripFairness } from "./plan-votes";
import { tripReadiness } from "./readiness";

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

/** A trip with more candidates than fit, so a ranking has consequences. */
async function trip(days = 3) {
  const { plan } = await createTripPlan({
    legs: [{ title: "München", anchor: MUNICH, startDate: "2027-07-01", days }],
  });
  return plan;
}

/** The spots that are in the pool rather than on a day. */
function pooled(plan: { legs: { pool: { osmRef: string }[] }[] }): string[] {
  return plan.legs[0].pool.map((candidate) => candidate.osmRef);
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
  // More candidates than three days can hold, so there is a pool to
  // rank — a trip whose every candidate is planned has nothing to vote
  // about.
  geo.setSearchSpots(DB, Array.from({ length: 60 }, (_, i) => spot(i + 1)));
  setGeoClient(geo);
  return () => resetGeoClient();
});

describe("what is up for a vote", () => {
  it("lists the planned spots and the pool, with nobody's answer yet", async () => {
    const plan = await trip();

    const ballot = await tripBallot({ planId: plan.id });

    expect(ballot.entries.length).toBeGreaterThan(0);
    expect(ballot.entries.every((entry) => entry.myVote === null)).toBe(true);
    expect(ballot.entries.some((entry) => entry.planned)).toBe(true);
  });

  it("says how many settings are left on this leg", async () => {
    const plan = await trip(3);

    const ballot = await tripBallot({ planId: plan.id });

    expect(ballot.heartQuota).toBe(2);
    expect(ballot.heartsLeft).toBe(2);
  });

  it("shows everybody's answers, not a number", async () => {
    // §3.8: a ranking you cannot argue with is one nobody trusts.
    const plan = await trip();
    const ref = pooled(plan)[0];
    await castVote({ planId: plan.id, osmRef: ref, value: "want" });

    const ballot = await tripBallot({ planId: plan.id });

    const entry = ballot.entries.find((e) => e.osmRef === ref)!;
    expect(entry.wants).toEqual(["Anna"]);
    expect(entry.myVote).toBe("want");
  });

  it("refuses a vote on something that is not on this leg", async () => {
    const plan = await trip();

    await expect(castVote({ planId: plan.id, osmRef: "node:999999", value: "want" }))
      .rejects.toThrow(/nicht zur Wahl/);
  });

  it("refuses an answer it does not know", async () => {
    const plan = await trip();

    await expect(castVote({ planId: plan.id, osmRef: pooled(plan)[0], value: "vielleicht" }))
      .rejects.toThrow(/value must be one of/);
  });
});

describe("a vote reaches the plan", () => {
  it("but not before somebody asks for it", async () => {
    // Thirty swipes must not be thirty different trips (§6.1).
    const plan = await trip();
    const wanted = pooled(plan)[0];

    await castVote({ planId: plan.id, osmRef: wanted, value: "want", heart: true });

    const { plan: untouched } = await import("./plans")
      .then((m) => m.getTripPlan({ planId: plan.id }));
    expect(plannedRefs(untouched)).toEqual(plannedRefs(plan));
  });

  it("pulls a heart wish out of the pool and onto a day", async () => {
    const plan = await trip();
    const wanted = pooled(plan).at(-1)!;

    await castVote({ planId: plan.id, osmRef: wanted, value: "want", heart: true });
    const { plan: after } = await applyVotesToPlan({ planId: plan.id });

    expect(plannedRefs(after)).toContain(wanted);
  });

  it("lifts a spot out of the pool on an ordinary 'will ich'", async () => {
    // Not only the heart wish: a plain want is worth something too.
    const plan = await trip();
    const wanted = pooled(plan).at(-1)!;

    await castVote({ planId: plan.id, osmRef: wanted, value: "want" });
    const { plan: after } = await applyVotesToPlan({ planId: plan.id });

    expect(plannedRefs(after)).toContain(wanted);
  });

  it("says why, in the words somebody used", async () => {
    // §3.8: every proposal carries its reason, and a vote is one of
    // them — "Anna: lieber nicht" next to "Sehenswürdigkeit".
    const plan = await trip();
    const unwanted = pooled(plan)[0];

    await castVote({ planId: plan.id, osmRef: unwanted, value: "rather-not" });
    const { plan: after } = await applyVotesToPlan({ planId: plan.id });

    const candidate = after.legs[0].pool.find((c) => c.osmRef === unwanted);
    expect(candidate?.reasons.join(" ")).toContain("Anna: lieber nicht");
  });

  it("pushes off the day what several people would rather not do", async () => {
    // One "lieber nicht" is a strong minus and not a veto (§6.1), so
    // this takes a group saying it — which is exactly the point.
    const plan = await trip();
    const unwanted = plannedRefs(plan)[0];
    const voices = await Promise.all([1, 2].map(async (n) => {
      const [row] = await db
        .insert(tripPlanTravellers)
        .values({ plan_id: plan.id, label: `Kind ${n}`, added_by: annaId })
        .returning({ id: tripPlanTravellers.id });
      return row.id;
    }));

    await castVote({ planId: plan.id, osmRef: unwanted, value: "rather-not" });
    for (const id of voices) {
      await castVote({
        planId: plan.id, osmRef: unwanted, value: "rather-not", forTravellerId: id,
      });
    }
    const { plan: after } = await applyVotesToPlan({ planId: plan.id });

    expect(plannedRefs(after)).not.toContain(unwanted);
  });

  it("leaves a spot nobody rated where it was", async () => {
    const plan = await trip();
    const untouched = pooled(plan)[1];
    await castVote({ planId: plan.id, osmRef: pooled(plan)[0], value: "want" });

    const { plan: after } = await applyVotesToPlan({ planId: plan.id });

    expect([...plannedRefs(after), ...pooled(after)]).toContain(untouched);
  });
});

describe("the quota is per leg, not per swipe", () => {
  it("refuses one setting too many, and says how to free one", async () => {
    const plan = await trip(3);
    const refs = pooled(plan);
    await castVote({ planId: plan.id, osmRef: refs[0], value: "want", heart: true });
    await castVote({ planId: plan.id, osmRef: refs[1], value: "want", heart: true });

    await expect(castVote({ planId: plan.id, osmRef: refs[2], value: "want", heart: true }))
      .rejects.toThrow(/Herzenswünsche vorgesehen/);
  });

  it("gives one back when a setting is taken off", async () => {
    const plan = await trip(3);
    const refs = pooled(plan);
    await castVote({ planId: plan.id, osmRef: refs[0], value: "want", heart: true });
    await castVote({ planId: plan.id, osmRef: refs[1], value: "want", heart: true });

    const back = await castVote({ planId: plan.id, osmRef: refs[0], value: "want" });

    expect(back.heartsLeft).toBe(1);
  });

  it("counts each voice's settings separately", async () => {
    const plan = await trip(3);
    const refs = pooled(plan);
    const [child] = await db
      .insert(tripPlanTravellers)
      .values({ plan_id: plan.id, label: "Kind A", added_by: annaId })
      .returning({ id: tripPlanTravellers.id });
    await castVote({ planId: plan.id, osmRef: refs[0], value: "want", heart: true });
    await castVote({ planId: plan.id, osmRef: refs[1], value: "want", heart: true });

    // Anna's own two are gone; the child's are the child's.
    const forChild = await castVote({
      planId: plan.id, osmRef: refs[2], value: "want", heart: true, forTravellerId: child.id,
    });

    expect(forChild.heart).toBe(true);
  });
});

describe("a voice held for somebody else", () => {
  it("counts as theirs, not as the holder's", async () => {
    const plan = await trip();
    const [child] = await db
      .insert(tripPlanTravellers)
      .values({ plan_id: plan.id, label: "Kind A", added_by: annaId })
      .returning({ id: tripPlanTravellers.id });

    await castVote({
      planId: plan.id, osmRef: pooled(plan)[0], value: "want", forTravellerId: child.id,
    });

    const ballot = await tripBallot({ planId: plan.id });
    const entry = ballot.entries.find((e) => e.osmRef === pooled(plan)[0])!;
    expect(entry.wants).toEqual(["Kind A"]);
    // Anna herself has still not said anything about it.
    expect(entry.myVote).toBeNull();
  });

  it("records who cast it", async () => {
    const plan = await trip();
    const [child] = await db
      .insert(tripPlanTravellers)
      .values({ plan_id: plan.id, label: "Kind A", added_by: annaId })
      .returning({ id: tripPlanTravellers.id });

    await castVote({
      planId: plan.id, osmRef: pooled(plan)[0], value: "want", forTravellerId: child.id,
    });

    const [row] = await db.select().from(tripPlanVotes)
      .where(eq(tripPlanVotes.traveller_id, child.id));
    expect(row.cast_by).toBe(annaId);
    expect(row.user_id).toBeNull();
  });

  it("does not vote for somebody on another trip", async () => {
    const plan = await trip();
    const other = await trip();
    const [stranger] = await db
      .insert(tripPlanTravellers)
      .values({ plan_id: other.id, label: "Kind B", added_by: annaId })
      .returning({ id: tripPlanTravellers.id });

    await expect(castVote({
      planId: plan.id, osmRef: pooled(plan)[0], value: "want", forTravellerId: stranger.id,
    })).rejects.toThrow(/fährt bei dieser Reise nicht mit/);
  });
});

describe("who may rate", () => {
  it("everybody on the trip, not only the organiser (§6.2)", async () => {
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: papaId });
    const ref = pooled(plan)[0];

    actAs(papaId);
    await castVote({ planId: plan.id, osmRef: ref, value: "want" });

    const ballot = await tripBallot({ planId: plan.id });
    expect(ballot.entries.find((e) => e.osmRef === ref)!.wants).toEqual(["Papa"]);
  });

  it("nobody who is not on it", async () => {
    const plan = await trip();
    actAs(papaId);

    await expect(castVote({ planId: plan.id, osmRef: "way:1", value: "want" }))
      .rejects.toThrow(/plan not found/);
  });
});

describe("the fairness account", () => {
  it("names who gave way, in a sentence", async () => {
    const plan = await trip();
    // Something that stays in the pool: a wish deferred.
    await castVote({ planId: plan.id, osmRef: pooled(plan).at(-1)!, value: "want" });

    const fairness = await tripFairness({ planId: plan.id });

    expect(fairness.rows[0]).toMatchObject({ name: "Anna", granted: 0, deferred: 1 });
    expect(fairness.sentence).toContain("Anna");
  });

  it("says so plainly when nobody is owed anything", async () => {
    const plan = await trip();
    await castVote({ planId: plan.id, osmRef: plannedRefs(plan)[0], value: "want" });

    const fairness = await tripFairness({ planId: plan.id });

    expect(fairness.sentence).toBe("Bisher ist niemand zu kurz gekommen.");
  });
});

describe("the evening before can finally answer its fourth question", () => {
  it("names who has not voted rather than counting them (§8.6)", async () => {
    const plan = await trip();
    await db.insert(tripPlanShares).values({ plan_id: plan.id, user_id: papaId });
    await castVote({ planId: plan.id, osmRef: pooled(plan)[0], value: "want" });

    const readiness = await tripReadiness({ planId: plan.id });

    const votes = readiness.checks.find((check) => check.id === "votes")!;
    expect(votes.state).toBe("attention");
    expect(votes.sentence).toContain("Papa");
  });

  it("treats a trip nobody voted on as one person planning, not as a warning", async () => {
    const plan = await trip();

    const readiness = await tripReadiness({ planId: plan.id });

    expect(readiness.checks.find((check) => check.id === "votes")!.state).toBe("unknown");
  });
});
