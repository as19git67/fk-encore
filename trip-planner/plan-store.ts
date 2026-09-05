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

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import dbDefault from "../db/database";
import {
  tripPlanBlocks,
  tripPlanDays,
  tripPlanFixpoints,
  tripPlanLegs,
  tripPlanPool,
  tripPlanStops,
  tripPlans,
} from "../db/schema";
import type { Candidate, PlannedBlock } from "./solver";
import type { CurrentBlock, CurrentStop, StopStatus } from "./redistribute";
import type { ScoredCandidate } from "./candidates";
import { travelClassFor, type TransportMode } from "./travel";
import { DEFAULT_BUFFER_MINUTES, type Fixpoint, type FixpointKind } from "./fixpoints";

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
  /**
   * False while the day is still only at trip resolution (§4.3): it has
   * its frame — blocks with budgets, fixpoints — but no stops yet.
   */
  detailed: boolean;
  blocks: StoredBlock[];
  /** The hard times framing this day (§4.4), earliest binding first. */
  fixpoints: StoredFixpoint[];
}

export interface StoredFixpoint extends Fixpoint {
  rowId: number;
  kind: FixpointKind;
  /** Where it happens, when that is known. */
  lat: number | null;
  lon: number | null;
}

export interface StoredBlock extends CurrentBlock {
  /** Database id, distinct from the template id used by the solver. */
  rowId: number;
  /**
   * Where the block sits on the day's notional clock, in minutes past
   * midnight (§8.3). Null for plans written before the frame time was
   * kept — the time slider then has nothing to show for that day, which
   * is more honest than a guessed hour.
   */
  startMinutes: number | null;
  stops: StoredStop[];
}

export interface StoredStop extends CurrentStop {
  rowId: number;
}

/** A fixpoint as it arrives, before it has a row. */
export interface CreateFixpointInput extends Fixpoint {
  kind?: FixpointKind;
  lat?: number | null;
  lon?: number | null;
}

/** A block as it goes in, with the hour the frame gave it. */
export type CreateBlockInput = PlannedBlock & { startMinutes?: number };

export interface CreateDayInput {
  blocks: readonly CreateBlockInput[];
  fixpoints?: readonly CreateFixpointInput[];
  /** Defaults to true — a day written with stops is a detailed day. */
  detailed?: boolean;
}

export interface CreateLegInput {
  title?: string;
  anchor: { lat: number; lon: number };
  anchorRadiusM?: number | null;
  mode?: TransportMode;
  regionDb: string;
  startDate?: string | null;
  days: readonly CreateDayInput[];
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

    for (const [dayIndex, dayInput] of legInput.days.entries()) {
      const [day] = await db
        .insert(tripPlanDays)
        .values({ leg_id: leg.id, day_index: dayIndex, detailed: dayInput.detailed ?? true })
        .returning({ id: tripPlanDays.id });

      for (const fix of dayInput.fixpoints ?? []) {
        await db.insert(tripPlanFixpoints).values({
          day_id: day.id,
          kind: fix.kind ?? "appointment",
          label: fix.label,
          start_minutes: fix.startMinutes,
          duration_minutes: fix.durationMinutes ?? 0,
          travel_minutes: fix.travelMinutes ?? 0,
          buffer_minutes: fix.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
          lat: fix.lat ?? null,
          lon: fix.lon ?? null,
        });
      }

      for (const [blockPosition, block] of dayInput.blocks.entries()) {
        const [row] = await db
          .insert(tripPlanBlocks)
          .values({
            day_id: day.id,
            position: blockPosition,
            template_id: block.id,
            label: block.label,
            kind: block.kind,
            budget_minutes: block.budgetMinutes,
            start_minutes: block.startMinutes ?? null,
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

/** One row of the plan list: enough to choose, not the whole plan. */
export interface PlanSummary {
  id: number;
  title: string | null;
  /** The legs in order, so a list row can read "Beispielstadt → Musterstadt". */
  legTitles: (string | null)[];
  /** Days across the whole trip. */
  dayCount: number;
  /** The first leg's start date, when the trip has dates at all. */
  startDate: string | null;
  updatedAt: string;
}

/**
 * The user's plans, newest first.
 *
 * Deliberately a summary rather than a list of full plans: a
 * twenty-day trip carries hundreds of stops, and a chooser needs a
 * name, a length and a date.
 */
export async function listPlans(
  ownerId: number,
  db: Db = dbDefault,
): Promise<PlanSummary[]> {
  const planRows = await db
    .select()
    .from(tripPlans)
    .where(eq(tripPlans.owner_id, ownerId))
    .orderBy(desc(tripPlans.updated_at));
  if (planRows.length === 0) return [];

  const planIds = planRows.map((p) => p.id);
  const legRows = await db
    .select()
    .from(tripPlanLegs)
    .where(inArray(tripPlanLegs.plan_id, planIds))
    .orderBy(asc(tripPlanLegs.plan_id), asc(tripPlanLegs.position));

  const legIds = legRows.map((l) => l.id);
  const dayRows = legIds.length
    ? await db.select({ leg_id: tripPlanDays.leg_id }).from(tripPlanDays).where(inArray(tripPlanDays.leg_id, legIds))
    : [];

  const daysByLeg = new Map<number, number>();
  for (const row of dayRows) {
    daysByLeg.set(row.leg_id, (daysByLeg.get(row.leg_id) ?? 0) + 1);
  }

  const legsByPlan = new Map<number, typeof legRows>();
  for (const leg of legRows) {
    const list = legsByPlan.get(leg.plan_id) ?? [];
    list.push(leg);
    legsByPlan.set(leg.plan_id, list);
  }

  return planRows.map((plan) => {
    const legs = legsByPlan.get(plan.id) ?? [];
    return {
      id: plan.id,
      title: plan.title,
      legTitles: legs.map((l) => l.title),
      dayCount: legs.reduce((sum, l) => sum + (daysByLeg.get(l.id) ?? 0), 0),
      startDate: legs[0]?.start_date ?? null,
      updatedAt: plan.updated_at,
    };
  });
}

/**
 * Mark one stop done or skipped.
 *
 * Deliberately its own write rather than a redistribution: ticking a
 * spot off is not a request to replan the day, and making it one would
 * rearrange the afternoon under the traveller's thumb (§5, §8.5). The
 * status is what a later redistribution reads as "past".
 *
 * Scoped by plan and owner in one statement, so a stop id from another
 * user's plan simply matches nothing.
 */
export async function setStopStatus(
  planId: number,
  ownerId: number,
  stopId: number,
  status: StopStatus,
  db: Db = dbDefault,
): Promise<boolean> {
  const [stop] = await db
    .select({ id: tripPlanStops.id })
    .from(tripPlanStops)
    .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
    .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
    .innerJoin(tripPlanLegs, eq(tripPlanLegs.id, tripPlanDays.leg_id))
    .innerJoin(tripPlans, eq(tripPlans.id, tripPlanLegs.plan_id))
    .where(
      and(
        eq(tripPlanStops.id, stopId),
        eq(tripPlans.id, planId),
        eq(tripPlans.owner_id, ownerId),
      ),
    )
    .limit(1);
  if (!stop) return false;

  await db.update(tripPlanStops).set({ status }).where(eq(tripPlanStops.id, stopId));
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
  return true;
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

  const fixpointRows = dayIds.length
    ? await db
        .select()
        .from(tripPlanFixpoints)
        .where(inArray(tripPlanFixpoints.day_id, dayIds))
        .orderBy(asc(tripPlanFixpoints.day_id), asc(tripPlanFixpoints.start_minutes))
    : [];

  const fixpointsByDay = new Map<number, StoredFixpoint[]>();
  for (const row of fixpointRows) {
    const list = fixpointsByDay.get(row.day_id) ?? [];
    list.push({
      rowId: row.id,
      // The solver keys fixpoints by id; the row id is the only handle
      // that is stable across a reload.
      id: String(row.id),
      kind: row.kind as FixpointKind,
      label: row.label,
      startMinutes: row.start_minutes,
      durationMinutes: row.duration_minutes,
      travelMinutes: row.travel_minutes,
      bufferMinutes: row.buffer_minutes,
      lat: row.lat,
      lon: row.lon,
    });
    fixpointsByDay.set(row.day_id, list);
  }

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
      startMinutes: row.start_minutes,
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
    list.push({
      id: row.id,
      dayIndex: row.day_index,
      detailed: row.detailed,
      blocks: blocksByDay.get(row.id) ?? [],
      fixpoints: fixpointsByDay.get(row.id) ?? [],
    });
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
  await rewriteDay(planId, legId, day, blocks, pool, db);
}

/**
 * Fill in a day that was only at trip resolution: same write as a
 * redistribution, plus the flag that says the day now has stops (§4.3).
 */
export async function saveDayDetail(
  planId: number,
  legId: number,
  day: StoredDay,
  blocks: readonly CurrentBlock[],
  pool: readonly Candidate[],
  db: Db = dbDefault,
): Promise<void> {
  await rewriteDay(planId, legId, day, blocks, pool, db);
  await db.update(tripPlanDays).set({ detailed: true }).where(eq(tripPlanDays.id, day.id));
}

async function rewriteDay(
  planId: number,
  legId: number,
  day: StoredDay,
  blocks: readonly CurrentBlock[],
  pool: readonly Candidate[],
  db: Db,
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
