/**
 * Round-trip tests for plan persistence, against the real database.
 *
 * The interesting part is not that rows survive a write — it is that
 * the *order* does: blocks within a day and stops within a block are
 * meaningful, and a plan that loads back scrambled would be worse than
 * no plan at all.
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
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: { pace: "normal", maxWalkMinutes: 40 },
      days: [[block("morning", [stop("node:a", 200), stop("node:b", 400)])]],
      pool: POOL,
    });

    const plan = await loadPlan(planId, ownerId);
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe("Beispieltag");
    expect(plan?.regionDb).toBe("nom_test");
    expect(plan?.anchor.lat).toBeCloseTo(ANCHOR.lat, 6);
    expect(plan?.days).toHaveLength(1);
    expect(plan?.days[0].blocks[0].stops.map((s) => s.osmRef)).toEqual([
      "node:a",
      "node:b",
    ]);
    expect(plan?.pool.map((c) => c.osmRef)).toEqual(["node:pooled"]);
    expect(plan?.pool[0].reasons).toEqual(["hat einen Wikipedia-Artikel"]);
  });

  it("keeps day, block and stop order across a reload", async () => {
    const planId = await createPlan({
      ownerId,
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: {},
      days: [
        [block("morning", [stop("node:d1a", 100)]), block("evening", [stop("node:d1b", 200)])],
        [block("morning", [stop("node:d2a", 300)])],
      ],
      pool: [],
    });

    const plan = await loadPlan(planId, ownerId);
    expect(plan?.days.map((d) => d.dayIndex)).toEqual([0, 1]);
    expect(plan?.days[0].blocks.map((b) => b.id)).toEqual(["morning", "evening"]);
    expect(plan?.days[1].blocks[0].stops[0].osmRef).toBe("node:d2a");
  });

  it("does not hand a plan to another user", async () => {
    const planId = await createPlan({
      ownerId,
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: {},
      days: [[block("morning", [stop("node:a", 200)])]],
      pool: [],
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
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: {},
      days: [[block("morning", [stop("node:a", 200), stop("node:b", 400)])]],
      pool: [],
    });

    const plan = await loadPlan(planId, ownerId);
    const day = plan!.days[0];
    // 2 stops × (30 dwell + 5 travel)
    expect(day.blocks[0].usedMinutes).toBe(70);

    await saveRedistribution(
      plan!.id,
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
    expect(after!.days[0].blocks[0].usedMinutes).toBe(35);
  });

  it("replaces the day's stops and the pool on a redistribution", async () => {
    const planId = await createPlan({
      ownerId,
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: {},
      days: [[block("morning", [stop("node:old", 200)])]],
      pool: POOL,
    });

    const plan = await loadPlan(planId, ownerId);
    const day = plan!.days[0];
    await saveRedistribution(
      plan!.id,
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
    expect(after!.days[0].blocks[0].stops.map((s) => s.osmRef)).toEqual(["node:new"]);
    expect(after!.pool.map((c) => c.osmRef)).toEqual(["node:old"]);
    expect(after!.pool[0].score).toBeCloseTo(2.5, 5);
  });

  it("removes everything below it when a plan is deleted", async () => {
    const planId = await createPlan({
      ownerId,
      anchor: ANCHOR,
      regionDb: "nom_test",
      constraints: {},
      days: [[block("morning", [stop("node:a", 200)])]],
      pool: POOL,
    });

    await db.delete(tripPlans).where(eq(tripPlans.id, planId));
    expect(await loadPlan(planId, ownerId)).toBeNull();
  });
});
