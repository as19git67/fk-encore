/**
 * Round-trip tests for plan persistence, against the real database.
 *
 * The interesting part is not that rows survive a write — it is that
 * the *order* does: legs within a trip, days within a leg, blocks within
 * a day and stops within a block are all meaningful, and a plan that
 * loads back scrambled would be worse than no plan at all.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { tripPlans, users } from "../db/schema";
import { createPlan, loadPlan, saveRedistribution } from "./plan-store";
import type { PlannedBlock } from "./solver";
import type { ScoredCandidate } from "./candidates";

const ANCHOR = { lat: 48.37, lon: 10.9 };

function north(metres: number) {
  return { lat: ANCHOR.lat + metres / 111_320, lon: ANCHOR.lon };
}

function stop(ref: string, metres: number) {
  const at = north(metres);
  return {
    osmRef: ref,
    name: ref,
    lat: at.lat,
    lon: at.lon,
    category: "sight",
    dwellMinutes: 30,
    score: 2,
    travelFromPrevious: { minutes: 5, distanceM: 390, travelClass: "short_walk" as const },
  };
}

function block(id: string, stops: ReturnType<typeof stop>[]): PlannedBlock {
  return {
    id,
    label: id,
    kind: "spots",
    budgetMinutes: 210,
    usedMinutes: stops.length * 35,
    stops,
  };
}

const POOL: ScoredCandidate[] = [
  {
    osmRef: "node:pooled",
    name: "Vorrat",
    ...north(700),
    category: "museum",
    dwellMinutes: 90,
    score: 3,
    reasons: ["hat einen Wikipedia-Artikel"],
  },
];

let ownerId = 0;

beforeEach(async () => {
  await db.delete(tripPlans);
  const [user] = await db
    .insert(users)
    .values({ email: `planner-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  ownerId = user.id;
});

describe("plan persistence", () => {
  it("round-trips a plan with its days, blocks, stops and pool", async () => {
    const planId = await createPlan({
      ownerId,
      title: "Beispieltag",
      constraints: { pace: "normal", maxWalkMinutes: 40 },
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [[block("morning", [stop("node:a", 200), stop("node:b", 400)])]],
          pool: POOL,
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe("Beispieltag");
    expect(plan?.legs).toHaveLength(1);
    const leg = plan!.legs[0];
    expect(leg.regionDb).toBe("nom_test");
    expect(leg.anchor.lat).toBeCloseTo(ANCHOR.lat, 6);
    // Defaults for a plan that never mentioned a leg: on foot, at an
    // address rather than a zone, undated.
    expect(leg.mode).toBe("foot");
    expect(leg.anchorRadiusM).toBeNull();
    expect(leg.startDate).toBeNull();
    expect(leg.days).toHaveLength(1);
    expect(leg.days[0].blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:a", "node:b"]);
    expect(leg.pool.map((c) => c.osmRef)).toEqual(["node:pooled"]);
    expect(leg.pool[0].reasons).toEqual(["hat einen Wikipedia-Artikel"]);
  });

  it("keeps day, block and stop order across a reload", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [
            [block("morning", [stop("node:d1a", 100)]), block("evening", [stop("node:d1b", 200)])],
            [block("morning", [stop("node:d2a", 300)])],
          ],
          pool: [],
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    const days = plan!.legs[0].days;
    expect(days.map((d) => d.dayIndex)).toEqual([0, 1]);
    expect(days[0].blocks.map((b) => b.id)).toEqual(["morning", "evening"]);
    expect(days[1].blocks[0].stops[0].osmRef).toBe("node:d2a");
  });

  it("does not hand a plan to another user", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [[block("morning", [stop("node:a", 200)])]],
          pool: [],
        },
      ],
    });
    const [other] = await db
      .insert(users)
      .values({ email: `other-${Date.now()}@test.invalid`, name: "Other", password_hash: "x" })
      .returning({ id: users.id });

    expect(await loadPlan(planId, other.id)).toBeNull();
  });

  it("computes used minutes from planned stops only", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [[block("morning", [stop("node:a", 200), stop("node:b", 400)])]],
          pool: [],
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    const day = plan!.legs[0].days[0];
    // 2 stops × (30 dwell + 5 travel)
    expect(day.blocks[0].usedMinutes).toBe(70);

    await saveRedistribution(
      plan!.id,
      plan!.legs[0].id,
      day,
      [
        {
          ...day.blocks[0],
          stops: [
            { ...day.blocks[0].stops[0], status: "done" },
            { ...day.blocks[0].stops[1], status: "planned" },
          ],
        },
      ],
      [],
    );

    const after = await loadPlan(plan!.id, ownerId);
    expect(after!.legs[0].days[0].blocks[0].usedMinutes).toBe(35);
  });

  it("replaces the day's stops and the pool on a redistribution", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [[block("morning", [stop("node:old", 200)])]],
          pool: POOL,
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    const day = plan!.legs[0].days[0];
    await saveRedistribution(
      plan!.id,
      plan!.legs[0].id,
      day,
      [
        {
          ...day.blocks[0],
          stops: [
            {
              ...stop("node:new", 500),
              status: "planned" as const,
              pinned: false,
            },
          ],
        },
      ],
      [
        {
          osmRef: "node:old",
          name: "node:old",
          ...north(200),
          category: "sight",
          dwellMinutes: 30,
          score: 2.5,
        },
      ],
    );

    const after = await loadPlan(plan!.id, ownerId);
    expect(after!.legs[0].days[0].blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:new"]);
    expect(after!.legs[0].pool.map((c) => c.osmRef)).toEqual(["node:old"]);
    expect(after!.legs[0].pool[0].score).toBeCloseTo(2.5, 5);
  });

  it("keeps each leg's days, pool and settings apart", async () => {
    // Two cities in one trip: separate anchors, separate regions,
    // separate ways of getting around, separate pools (§4.2).
    const OSAKA = { lat: 34.69, lon: 135.5 };
    const planId = await createPlan({
      ownerId,
      title: "Zwei Städte",
      constraints: {},
      legs: [
        {
          title: "Beispielstadt",
          anchor: ANCHOR,
          regionDb: "nom_bayern",
          mode: "foot",
          startDate: "2026-09-03",
          days: [[block("morning", [stop("node:a", 200)])]],
          pool: POOL,
        },
        {
          title: "Musterstadt",
          anchor: OSAKA,
          anchorRadiusM: 1_200,
          regionDb: "nom_kansai",
          mode: "transit",
          startDate: "2026-09-11",
          days: [
            [block("morning", [stop("node:b", 300)])],
            [block("morning", [stop("node:c", 400)])],
          ],
          pool: [],
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    expect(plan!.legs.map((l) => l.title)).toEqual(["Beispielstadt", "Musterstadt"]);
    expect(plan!.legs.map((l) => l.position)).toEqual([0, 1]);
    expect(plan!.legs.map((l) => l.regionDb)).toEqual(["nom_bayern", "nom_kansai"]);
    expect(plan!.legs.map((l) => l.days.length)).toEqual([1, 2]);
    expect(plan!.legs.map((l) => l.startDate)).toEqual(["2026-09-03", "2026-09-11"]);

    // Day numbering restarts per leg — day 1 of Osaka, not day 3 of the trip.
    expect(plan!.legs[1].days.map((d) => d.dayIndex)).toEqual([0, 1]);

    // The pool belongs to the leg it was searched for.
    expect(plan!.legs[0].pool.map((c) => c.osmRef)).toEqual(["node:pooled"]);
    expect(plan!.legs[1].pool).toEqual([]);

    // An anchor zone: a centroid with a tolerance, not an address.
    expect(plan!.legs[0].anchorRadiusM).toBeNull();
    expect(plan!.legs[1].anchorRadiusM).toBe(1_200);
    expect(plan!.legs[1].anchor.lon).toBeCloseTo(OSAKA.lon, 6);
  });

  it("reads a stop's travel class from its own leg's mode", async () => {
    // The class is derived on load, not stored — five minutes is a
    // short walk on foot and a short ride on the metro, and the two
    // legs of one trip must not borrow each other's wording.
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_bayern",
          mode: "foot",
          days: [[block("morning", [stop("node:a", 200)])]],
          pool: [],
        },
        {
          anchor: ANCHOR,
          regionDb: "nom_kansai",
          mode: "transit",
          days: [[block("morning", [stop("node:b", 200)])]],
          pool: [],
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    const classOf = (i: number) =>
      plan!.legs[i].days[0].blocks[0].stops[0].travelFromPrevious.travelClass;
    expect(classOf(0)).toBe("short_walk");
    expect(classOf(1)).toBe("short_ride");
  });

  it("empties only the redistributed leg's pool", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_bayern",
          days: [[block("morning", [stop("node:a", 200)])]],
          pool: POOL,
        },
        {
          anchor: ANCHOR,
          regionDb: "nom_kansai",
          days: [[block("morning", [stop("node:b", 300)])]],
          pool: POOL,
        },
      ],
    });

    const plan = await loadPlan(planId, ownerId);
    const second = plan!.legs[1];
    await saveRedistribution(plan!.id, second.id, second.days[0], [], []);

    const after = await loadPlan(plan!.id, ownerId);
    // The first leg is untouched: replanning Osaka does not clear Tokyo.
    expect(after!.legs[0].pool.map((c) => c.osmRef)).toEqual(["node:pooled"]);
    expect(after!.legs[1].pool).toEqual([]);
  });

  it("removes everything below it when a plan is deleted", async () => {
    const planId = await createPlan({
      ownerId,
      constraints: {},
      legs: [
        {
          anchor: ANCHOR,
          regionDb: "nom_test",
          days: [[block("morning", [stop("node:a", 200)])]],
          pool: POOL,
        },
      ],
    });

    await db.delete(tripPlans).where(eq(tripPlans.id, planId));
    expect(await loadPlan(planId, ownerId)).toBeNull();
  });
});
