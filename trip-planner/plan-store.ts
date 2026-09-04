/**
 * Persistence for plans.
 *
 * The shape mirrors what the solver produces — legs, days, blocks,
 * stops — plus the pool, which is the working set redistribution turns
 * on rather than a bin for leftovers (§5).
 *
 * The **leg** is the level between the trip and the day (§4.2): its own
 * period, anchor, way of getting around and region database, and
 * therefore its own pool. A one-city trip is simply a plan with one
 * leg, which is what every plan written before legs existed became.
 *
 * Everything here is plain reads and writes; all the decisions live in
 * the pure modules next door. That split is deliberate: a plan can be
 * recomputed offline on the device without a database in sight, and the
 * database never has an opinion about what belongs in a block.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import dbDefault from "../db/database";
import {
  tripPlanBlocks,
  tripPlanDays,
  tripPlanLegs,
  tripPlanPool,
  tripPlanStops,
  tripPlans,
} from "../db/schema";
import type { Candidate, PlannedBlock } from "./solver";
import type { CurrentBlock, CurrentStop, StopStatus } from "./redistribute";
import type { ScoredCandidate } from "./candidates";
import { travelClassFor, type TransportMode } from "./travel";

type Db = typeof dbDefault;

export interface StoredPlan {
  id: number;
  ownerId: number;
  title: string | null;
  constraints: Record<string, unknown>;
  legs: StoredLeg[];
}

export interface StoredLeg {
  id: number;
  position: number;
  title: string | null;
  anchor: { lat: number; lon: number };
  /**
   * Set when the anchor is a zone rather than an address (§4.2): the
   * anchor is its centroid and this is how far the real base may sit
   * from it. Null once a hotel is actually booked.
   */
  anchorRadiusM: number | null;
  mode: TransportMode;
  regionDb: string;
  /** ISO date of this leg's first day, or null when the trip has no dates. */
  startDate: string | null;
  days: StoredDay[];
  /** This leg's pool — redistribution never reaches across legs. */
  pool: ScoredCandidate[];
}

export interface StoredDay {
  id: number;
  dayIndex: number;
  blocks: StoredBlock[];
}

export interface StoredBlock extends CurrentBlock {
  /** Database id, distinct from the template id used by the solver. */
  rowId: number;
  stops: StoredStop[];
}

export interface StoredStop extends CurrentStop {
  rowId: number;
}

export interface CreateLegInput {
  title?: string;
  anchor: { lat: number; lon: number };
  anchorRadiusM?: number | null;
  mode?: TransportMode;
  regionDb: string;
  startDate?: string | null;
  days: readonly (readonly PlannedBlock[])[];
  pool: readonly ScoredCandidate[];
}

export interface CreatePlanInput {
  ownerId: number;
  title?: string;
  constraints: Record<string, unknown>;
  legs: readonly CreateLegInput[];
}

export async function createPlan(input: CreatePlanInput, db: Db = dbDefault): Promise<number> {
  const [plan] = await db
    .insert(tripPlans)
    .values({
      owner_id: input.ownerId,
      title: input.title ?? null,
      constraints: input.constraints,
    })
    .returning({ id: tripPlans.id });

  for (const [position, legInput] of input.legs.entries()) {
    const [leg] = await db
      .insert(tripPlanLegs)
      .values({
        plan_id: plan.id,
        position,
        title: legInput.title ?? null,
        anchor_lat: legInput.anchor.lat,
        anchor_lon: legInput.anchor.lon,
        anchor_radius_m: legInput.anchorRadiusM ?? null,
        mode: legInput.mode ?? "foot",
        region_db: legInput.regionDb,
        start_date: legInput.startDate ?? null,
      })
      .returning({ id: tripPlanLegs.id });

    for (const [dayIndex, blocks] of legInput.days.entries()) {
      const [day] = await db
        .insert(tripPlanDays)
        .values({ leg_id: leg.id, day_index: dayIndex })
        .returning({ id: tripPlanDays.id });

      for (const [blockPosition, block] of blocks.entries()) {
        const [row] = await db
          .insert(tripPlanBlocks)
          .values({
            day_id: day.id,
            position: blockPosition,
            template_id: block.id,
            label: block.label,
            kind: block.kind,
            budget_minutes: block.budgetMinutes,
          })
          .returning({ id: tripPlanBlocks.id });

        for (const [stopPosition, stop] of block.stops.entries()) {
          await db.insert(tripPlanStops).values({
            block_id: row.id,
            position: stopPosition,
            osm_ref: stop.osmRef,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon,
            category: stop.category,
            dwell_minutes: stop.dwellMinutes,
            travel_minutes: stop.travelFromPrevious.minutes,
            travel_distance_m: stop.travelFromPrevious.distanceM,
          });
        }
      }
    }

    if (legInput.pool.length > 0) {
      await db.insert(tripPlanPool).values(
        legInput.pool.map((c) => ({
          leg_id: leg.id,
          osm_ref: c.osmRef,
          name: c.name,
          lat: c.lat,
          lon: c.lon,
          category: c.category,
          dwell_minutes: c.dwellMinutes,
          score: c.score,
          reasons: c.reasons,
        })),
      );
    }
  }

  return plan.id;
}

export async function loadPlan(
  planId: number,
  ownerId: number,
  db: Db = dbDefault,
): Promise<StoredPlan | null> {
  const [plan] = await db
    .select()
    .from(tripPlans)
    .where(and(eq(tripPlans.id, planId), eq(tripPlans.owner_id, ownerId)))
    .limit(1);
  if (!plan) return null;

  const legRows = await db
    .select()
    .from(tripPlanLegs)
    .where(eq(tripPlanLegs.plan_id, planId))
    .orderBy(asc(tripPlanLegs.position));

  const legIds = legRows.map((l) => l.id);
  const dayRows = legIds.length
    ? await db
        .select()
        .from(tripPlanDays)
        .where(inArray(tripPlanDays.leg_id, legIds))
        .orderBy(asc(tripPlanDays.leg_id), asc(tripPlanDays.day_index))
    : [];

  const dayIds = dayRows.map((d) => d.id);
  const blockRows = dayIds.length
    ? await db
        .select()
        .from(tripPlanBlocks)
        .where(inArray(tripPlanBlocks.day_id, dayIds))
        .orderBy(asc(tripPlanBlocks.day_id), asc(tripPlanBlocks.position))
    : [];

  const blockIds = blockRows.map((b) => b.id);
  const stopRows = blockIds.length
    ? await db
        .select()
        .from(tripPlanStops)
        .where(inArray(tripPlanStops.block_id, blockIds))
        .orderBy(asc(tripPlanStops.block_id), asc(tripPlanStops.position))
    : [];

  const poolRows = legIds.length
    ? await db.select().from(tripPlanPool).where(inArray(tripPlanPool.leg_id, legIds))
    : [];

  // The travel class is derived rather than stored, and the mode it
  // depends on lives on the leg — so map each block back to its leg
  // before rebuilding a stop.
  const legByDay = new Map(dayRows.map((d) => [d.id, d.leg_id]));
  const legByBlock = new Map(blockRows.map((b) => [b.id, legByDay.get(b.day_id)!]));
  const modeByLeg = new Map(legRows.map((l) => [l.id, l.mode as TransportMode]));

  const stopsByBlock = new Map<number, StoredStop[]>();
  for (const row of stopRows) {
    const mode = modeByLeg.get(legByBlock.get(row.block_id)!) ?? "foot";
    const list = stopsByBlock.get(row.block_id) ?? [];
    list.push({
      rowId: row.id,
      osmRef: row.osm_ref,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      category: row.category,
      dwellMinutes: row.dwell_minutes,
      score: 0,
      travelFromPrevious: {
        minutes: row.travel_minutes,
        distanceM: row.travel_distance_m,
        travelClass: travelClassFor(row.travel_minutes, mode),
      },
      status: row.status as StopStatus,
      pinned: row.pinned,
    });
    stopsByBlock.set(row.block_id, list);
  }

  const blocksByDay = new Map<number, StoredBlock[]>();
  for (const row of blockRows) {
    const stops = stopsByBlock.get(row.id) ?? [];
    const list = blocksByDay.get(row.day_id) ?? [];
    list.push({
      rowId: row.id,
      id: row.template_id,
      label: row.label,
      kind: row.kind as CurrentBlock["kind"],
      budgetMinutes: row.budget_minutes,
      usedMinutes: stops
        .filter((s) => s.status === "planned")
        .reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0),
      stops,
    });
    blocksByDay.set(row.day_id, list);
  }

  const daysByLeg = new Map<number, StoredDay[]>();
  for (const row of dayRows) {
    const list = daysByLeg.get(row.leg_id) ?? [];
    list.push({ id: row.id, dayIndex: row.day_index, blocks: blocksByDay.get(row.id) ?? [] });
    daysByLeg.set(row.leg_id, list);
  }

  const poolByLeg = new Map<number, ScoredCandidate[]>();
  for (const row of poolRows) {
    const list = poolByLeg.get(row.leg_id) ?? [];
    list.push({
      osmRef: row.osm_ref,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      category: row.category,
      dwellMinutes: row.dwell_minutes,
      score: row.score,
      reasons: (row.reasons ?? []) as string[],
    });
    poolByLeg.set(row.leg_id, list);
  }

  return {
    id: plan.id,
    ownerId: plan.owner_id,
    title: plan.title,
    constraints: (plan.constraints ?? {}) as Record<string, unknown>,
    legs: legRows.map((l) => ({
      id: l.id,
      position: l.position,
      title: l.title,
      anchor: { lat: l.anchor_lat, lon: l.anchor_lon },
      anchorRadiusM: l.anchor_radius_m,
      mode: l.mode as TransportMode,
      regionDb: l.region_db,
      startDate: l.start_date,
      days: daysByLeg.get(l.id) ?? [],
      pool: poolByLeg.get(l.id) ?? [],
    })),
  };
}

/**
 * Replace one day's blocks and its leg's pool with the result of a
 * redistribution. Stops are rewritten wholesale rather than diffed:
 * a day holds a handful of rows, and a rewrite cannot leave the
 * positions inconsistent the way a partial update can.
 *
 * Scoped to the leg, because that is where redistribution is scoped:
 * what falls out in Tokyo does not slide to Osaka (§4.2).
 */
export async function saveRedistribution(
  planId: number,
  legId: number,
  day: StoredDay,
  blocks: readonly CurrentBlock[],
  pool: readonly Candidate[],
  db: Db = dbDefault,
): Promise<void> {
  const byTemplateId = new Map(day.blocks.map((b) => [b.id, b]));

  for (const block of blocks) {
    const stored = byTemplateId.get(block.id);
    if (!stored) continue;
    await db.delete(tripPlanStops).where(eq(tripPlanStops.block_id, stored.rowId));
    for (const [position, stop] of block.stops.entries()) {
      await db.insert(tripPlanStops).values({
        block_id: stored.rowId,
        position,
        osm_ref: stop.osmRef,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        category: stop.category,
        dwell_minutes: stop.dwellMinutes,
        travel_minutes: stop.travelFromPrevious.minutes,
        travel_distance_m: stop.travelFromPrevious.distanceM,
        status: stop.status,
        pinned: stop.pinned,
      });
    }
  }

  await db.delete(tripPlanPool).where(eq(tripPlanPool.leg_id, legId));
  if (pool.length > 0) {
    await db.insert(tripPlanPool).values(
      pool.map((c) => ({
        leg_id: legId,
        osm_ref: c.osmRef,
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        category: c.category,
        dwell_minutes: c.dwellMinutes,
        score: c.score,
        reasons: [],
      })),
    );
  }

  await db.update(tripPlans).set({ updated_at: new Date().toISOString() }).where(eq(tripPlans.id, planId));
}
