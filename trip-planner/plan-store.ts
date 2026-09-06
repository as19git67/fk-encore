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

import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { visibleToUser } from "./plan-access";
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
  /**
   * What this leg was searched with (migration 0165). Null means the
   * planner default — which is also what legs written before that
   * migration were planned with, so reading null and applying the
   * default reproduces them exactly.
   */
  radiusM: number | null;
  dayStartMinutes: number | null;
  days: StoredDay[];
  /** This leg's pool — redistribution never reaches across legs. */
  pool: StoredCandidate[];
}

/**
 * A pool entry as it comes back out of the database.
 *
 * More than the scoring produced, because the two things §9.2 calls
 * decisive about a find — *why* somebody saved it and where from — are
 * written by `addFind` and were being dropped on the way back: the
 * screen that shows the pool could only ever show a score. "Beste
 * Pastéis laut Blog" matters more than the name when you are choosing
 * what to do with an afternoon.
 */
export interface StoredCandidate extends ScoredCandidate {
  /** search | manual — found by the planner, or brought in by a person. */
  origin: string;
  /** Why it was saved, in the words of whoever saved it (§9.2). */
  note: string | null;
  /** Where it came from, kept as provenance (§9.2). */
  sourceUrl: string | null;
  /**
   * True when no OSM entry could be matched: opening hours, category
   * and dwell time are guesses at best, and the app says so rather than
   * presenting them as data (§10.4).
   */
  unmatched: boolean;
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
  /**
   * What this leg was searched with, kept so a re-plan can reproduce it
   * (migration 0165). Null or absent means the planner default.
   */
  radiusM?: number | null;
  dayStartMinutes?: number | null;
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
    await insertLeg(plan.id, position, legInput, db);
  }

  return plan.id;
}

/**
 * Write one leg — its row, its days and its pool.
 *
 * Shared by creating a trip and adding a city to one later (§4.2).
 * Nothing about a leg added on Tuesday should differ from a leg named
 * at the start, and one copy of this is how it stays that way.
 */
export async function insertLeg(
  planId: number,
  position: number,
  legInput: CreateLegInput,
  db: Db = dbDefault,
): Promise<number> {
  const [leg] = await db
    .insert(tripPlanLegs)
    .values({
      plan_id: planId,
      position,
      title: legInput.title ?? null,
      anchor_lat: legInput.anchor.lat,
      anchor_lon: legInput.anchor.lon,
      anchor_radius_m: legInput.anchorRadiusM ?? null,
      mode: legInput.mode ?? "foot",
      region_db: legInput.regionDb,
      start_date: legInput.startDate ?? null,
      radius_m: legInput.radiusM ?? null,
      day_starts_at: legInput.dayStartMinutes ?? null,
    })
    .returning({ id: tripPlanLegs.id });

  await insertDays(leg.id, legInput.days, db);

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
  return leg.id;
}

/**
 * Make room at `position` by pushing every leg from there on one along.
 *
 * Two statements rather than one per leg: `position` is unique per plan
 * only by convention, but doing it in descending order would still be
 * a window in which two legs share a number. A single `UPDATE … SET
 * position = position + 1` has no such window.
 */
export async function shiftLegsFrom(
  planId: number,
  position: number,
  db: Db = dbDefault,
): Promise<void> {
  await db
    .update(tripPlanLegs)
    .set({ position: sql`${tripPlanLegs.position} + 1` })
    .where(and(eq(tripPlanLegs.plan_id, planId), gte(tripPlanLegs.position, position)));
}

/**
 * Remove a leg and close the gap it leaves.
 *
 * Days, blocks, stops, fixpoints and the pool go with it by cascade.
 * The renumbering matters more than it looks: `position` is what every
 * endpoint addresses a leg by, so a hole in the sequence would make
 * "leg 2" mean different things before and after.
 */
export async function removeLeg(
  planId: number,
  legId: number,
  db: Db = dbDefault,
): Promise<boolean> {
  const [gone] = await db
    .delete(tripPlanLegs)
    .where(and(eq(tripPlanLegs.id, legId), eq(tripPlanLegs.plan_id, planId)))
    .returning({ position: tripPlanLegs.position });
  if (!gone) return false;
  await db
    .update(tripPlanLegs)
    .set({ position: sql`${tripPlanLegs.position} - 1` })
    .where(and(eq(tripPlanLegs.plan_id, planId), gt(tripPlanLegs.position, gone.position)));
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
  return true;
}

/** What a leg edit may move. Every field is optional. */
export interface LegPlaceUpdate {
  title?: string | null;
  anchor?: { lat: number; lon: number };
  anchorRadiusM?: number | null;
  radiusM?: number | null;
  regionDb?: string;
  dayStartMinutes?: number | null;
}

/**
 * Move a leg's place: where it is based, what it is called, how far the
 * planner may look.
 *
 * Separate from `updateLegFrames` (the mode and the dates) because the
 * two have different consequences — an anchor is what every day of the
 * leg starts and ends at, so moving it needs the days planned again,
 * and a date does not.
 */
export async function updateLegPlace(
  planId: number,
  legId: number,
  update: LegPlaceUpdate,
  db: Db = dbDefault,
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (update.title !== undefined) values.title = update.title;
  if (update.anchor !== undefined) {
    values.anchor_lat = update.anchor.lat;
    values.anchor_lon = update.anchor.lon;
  }
  if (update.anchorRadiusM !== undefined) values.anchor_radius_m = update.anchorRadiusM;
  if (update.radiusM !== undefined) values.radius_m = update.radiusM;
  if (update.regionDb !== undefined) values.region_db = update.regionDb;
  if (update.dayStartMinutes !== undefined) values.day_starts_at = update.dayStartMinutes;
  if (Object.keys(values).length === 0) return;
  await db
    .update(tripPlanLegs)
    .set(values)
    .where(and(eq(tripPlanLegs.id, legId), eq(tripPlanLegs.plan_id, planId)));
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
}

/**
 * Write a leg's days, with their fixpoints, blocks and stops.
 *
 * Shared by creating a plan and re-planning one: the two write exactly
 * the same rows, and a second copy of this loop is a second place for
 * a column to be forgotten.
 */
async function insertDays(
  legId: number,
  days: readonly CreateDayInput[],
  db: Db,
): Promise<void> {
  for (const [dayIndex, dayInput] of days.entries()) {
    const [day] = await db
      .insert(tripPlanDays)
      .values({ leg_id: legId, day_index: dayIndex, detailed: dayInput.detailed ?? true })
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
    // Trips you created and trips you were invited to (§6.2).
    .where(visibleToUser(ownerId))
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
  const owned = await stopBelongsToPlan(planId, ownerId, stopId, db);
  if (!owned) return false;

  await db.update(tripPlanStops).set({ status }).where(eq(tripPlanStops.id, stopId));
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
  return true;
}

/**
 * Pin a stop, or release it (§8.4). A pinned stop is a fixed point:
 * redistribution keeps it where it is, whatever else moves (§5).
 */
export async function setStopPinned(
  planId: number,
  ownerId: number,
  stopId: number,
  pinned: boolean,
  db: Db = dbDefault,
): Promise<boolean> {
  const owned = await stopBelongsToPlan(planId, ownerId, stopId, db);
  if (!owned) return false;
  await db.update(tripPlanStops).set({ pinned }).where(eq(tripPlanStops.id, stopId));
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
  return true;
}

/**
 * One statement rather than a load-then-check, so a stop id from
 * another user's plan simply matches nothing.
 */
async function stopBelongsToPlan(
  planId: number,
  ownerId: number,
  stopId: number,
  db: Db,
): Promise<boolean> {
  const [row] = await db
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
        visibleToUser(ownerId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Write back the days a move touched (§8.4).
 *
 * Both days are rewritten wholesale for the same reason a
 * redistribution is: a day holds a handful of rows, and a rewrite
 * cannot leave the positions inconsistent the way a partial update can.
 * The pool is untouched — a move rearranges what is planned, it does
 * not plan or unplan anything.
 */
export async function saveMovedDays(
  planId: number,
  days: ReadonlyArray<{ day: StoredDay; blocks: readonly CurrentBlock[] }>,
  db: Db = dbDefault,
): Promise<void> {
  for (const { day, blocks } of days) {
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
          note: stop.note ?? null,
          source_url: stop.sourceUrl ?? null,
        });
      }
    }
  }

  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
}

export async function loadPlan(
  planId: number,
  ownerId: number,
  db: Db = dbDefault,
): Promise<StoredPlan | null> {
  const [plan] = await db
    .select()
    .from(tripPlans)
    .where(and(eq(tripPlans.id, planId), visibleToUser(ownerId)))
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
      note: row.note,
      sourceUrl: row.source_url,
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

  const poolByLeg = new Map<number, StoredCandidate[]>();
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
      origin: row.origin,
      note: row.note,
      sourceUrl: row.source_url,
      unmatched: row.unmatched,
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
      radiusM: l.radius_m,
      dayStartMinutes: l.day_starts_at,
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

/**
 * Re-plan a trip in place: new days, new pool, same legs.
 *
 * The legs keep their rows on purpose. They carry the frame the
 * traveller set — anchor, dates, mode, search radius — which a settings
 * change does not touch, and they are what the manual pool entries hang
 * off. Deleting and re-creating them would throw away everybody's own
 * finds (§9.2) to change the pace, which is not a trade anyone offered.
 *
 * For the same reason the pool is replaced only where it came from the
 * search: rows whose `origin` is not `search` were put there by a
 * person and survive.
 */
export async function replanPlan(
  planId: number,
  constraints: Record<string, unknown>,
  perLeg: ReadonlyArray<{ legId: number; days: readonly CreateDayInput[]; pool: readonly ScoredCandidate[] }>,
  db: Db = dbDefault,
): Promise<void> {
  await db.update(tripPlans).set({ constraints }).where(eq(tripPlans.id, planId));

  for (const leg of perLeg) {
    await db.delete(tripPlanDays).where(eq(tripPlanDays.leg_id, leg.legId));
    await insertDays(leg.legId, leg.days, db);

    await db
      .delete(tripPlanPool)
      .where(and(eq(tripPlanPool.leg_id, leg.legId), eq(tripPlanPool.origin, "search")));

    // What a person put there survives, and (leg_id, osm_ref) is
    // unique — so a search result for a place somebody already added by
    // hand is dropped rather than inserted on top of their note.
    const kept = await db
      .select({ osmRef: tripPlanPool.osm_ref })
      .from(tripPlanPool)
      .where(eq(tripPlanPool.leg_id, leg.legId));
    const keptRefs = new Set(kept.map((r) => r.osmRef));
    const fresh = leg.pool.filter((c) => !keptRefs.has(c.osmRef));

    if (fresh.length > 0) {
      await db.insert(tripPlanPool).values(
        fresh.map((c) => ({
          leg_id: leg.legId,
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
}

/**
 * Rename a trip. Separate from re-planning: a name changes nothing.
 *
 * Owner-scoped rather than participant-scoped — the name is part of the
 * frame, which §6.2 reserves for the organiser. The caller has already
 * been through `requireOrganiser`; this is the second lock on the same
 * door, because a store function that trusts its caller is one refactor
 * away from being called by somebody who did not check.
 */
export async function renamePlan(
  planId: number,
  ownerId: number,
  title: string | null,
  db: Db = dbDefault,
): Promise<void> {
  await db
    .update(tripPlans)
    .set({ title })
    .where(and(eq(tripPlans.id, planId), eq(tripPlans.owner_id, ownerId)));
}

/**
 * What one leg's frame says, as far as a settings change may move it.
 *
 * Not a general leg editor: only the two things the settings screen
 * offers. The anchor, the days and the search radius are the frame the
 * traveller set when the trip was made, and moving them is a different
 * gesture with different consequences.
 */
export interface LegFrameUpdate {
  legId: number;
  mode?: TransportMode;
  /** ISO date, or null to take the dates off the trip again. */
  startDate?: string | null;
}

/**
 * Move the frame of one or more legs.
 *
 * Written as one statement per leg rather than a single bulk update
 * because the two fields are independent: a request that only sets the
 * dates must not reset a leg's mode to the default, and drizzle's
 * `set` writes exactly the keys it is given.
 */
export async function updateLegFrames(
  planId: number,
  updates: readonly LegFrameUpdate[],
  db: Db = dbDefault,
): Promise<void> {
  for (const update of updates) {
    const values: { mode?: string; start_date?: string | null } = {};
    if (update.mode !== undefined) values.mode = update.mode;
    if (update.startDate !== undefined) values.start_date = update.startDate;
    if (Object.keys(values).length === 0) continue;
    await db
      .update(tripPlanLegs)
      .set(values)
      .where(and(eq(tripPlanLegs.id, update.legId), eq(tripPlanLegs.plan_id, planId)));
  }
  await db
    .update(tripPlans)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(tripPlans.id, planId));
}

/**
 * Delete a trip and everything hanging off it.
 *
 * Every child table cascades from `trip_plans`, so one delete is the
 * whole thing — legs, days, blocks, stops, fixpoints, pool and the
 * share rows. Spelled out here rather than left implicit because a
 * missing `onDelete: "cascade"` on a table added later would turn this
 * into a foreign-key error at exactly the wrong moment.
 *
 * Answers false when the plan is not there, so the caller can say "not
 * found" rather than reporting a success that deleted nothing.
 */
export async function deletePlan(planId: number, db: Db = dbDefault): Promise<boolean> {
  const deleted = await db
    .delete(tripPlans)
    .where(eq(tripPlans.id, planId))
    .returning({ id: tripPlans.id });
  return deleted.length > 0;
}

/**
 * Drop one candidate from a leg's pool (§5).
 *
 * A plain delete: the pool is a suggestion list, and a suggestion
 * somebody has rejected has no business coming back on the next
 * re-plan. It will though, if it is still what the region search finds
 * — which is honest, since the leg really does still have that museum
 * in it, and the alternative is a hidden list of banished spots nobody
 * can see or undo.
 */
export async function removeFromPool(
  legId: number,
  osmRef: string,
  db: Db = dbDefault,
): Promise<boolean> {
  const deleted = await db
    .delete(tripPlanPool)
    .where(and(eq(tripPlanPool.leg_id, legId), eq(tripPlanPool.osm_ref, osmRef)))
    .returning({ id: tripPlanPool.id });
  return deleted.length > 0;
}

/** One pool entry, or undefined. */
export async function findInPool(
  legId: number,
  osmRef: string,
  db: Db = dbDefault,
): Promise<StoredCandidate | undefined> {
  const [row] = await db
    .select()
    .from(tripPlanPool)
    .where(and(eq(tripPlanPool.leg_id, legId), eq(tripPlanPool.osm_ref, osmRef)))
    .limit(1);
  if (!row) return undefined;
  return {
    osmRef: row.osm_ref,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    category: row.category,
    dwellMinutes: row.dwell_minutes,
    score: row.score,
    reasons: (row.reasons ?? []) as string[],
    origin: row.origin,
    note: row.note,
    sourceUrl: row.source_url,
    unmatched: row.unmatched,
  };
}
