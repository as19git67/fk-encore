/**
 * A soft stop the day did not reach goes back to the open spots (stage 8
 * of `reise-planen-und-unterwegs.md`).
 *
 * "Tag füllen" puts open spots on a day as soft stops (`placed_by =
 * 'fill'`). That was a proposal for the day, not a decision for the
 * trip: once the day is over, a soft stop that was neither visited nor
 * skipped is an idea again, with its priority, ready for another day.
 * A firm stop, one a person put there, stays and is asked about in the
 * evening as before.
 *
 * The app does this by itself, so it says so: one journal entry
 * `return-open` per day, which "Änderungen" can take back. Taking it
 * back puts the spots on their day again as firm stops: whoever undoes
 * it means that day, and a soft stop would only go back again on the
 * next tick.
 */

import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { tripPlanBlocks, tripPlanDays, tripPlanLegs, tripPlanOps, tripPlanStops, tripPlanVisits } from "../db/schema";
import { dayWalkOfStored } from "./day-walk";
import { addDays } from "./leg-dates";
import { insertStop, MoveError, recomputeDay } from "./move";
import {
  findInPool,
  loadPlan,
  planOwner,
  removeFromPool,
  saveMovedDays,
  saveRedistribution,
  type StoredDay,
  type StoredLeg,
  type StoredStop,
} from "./plan-store";
import { localDateIn, zoneAt } from "./time-zone";
import { candidateOfStop } from "./to-pool";
import type { CurrentBlock } from "./redistribute";

/** The journal kind of soft stops given back after their day; undone by placing them again. */
export const RETURN_OPEN_OP = "return-open";
export const RETURN_OPEN_UNDO_OP = "return-open-undo";

/** One spot given back, as the journal keeps it. */
export interface ReturnedSpot {
  osmRef: string;
  name: string | null;
}

/** Is this day of the stay over where the stay is? A stay without dates never is. */
export function dayIsOver(startDate: string | null, dayIndex: number, today: string): boolean {
  if (startDate === null) return false;
  return addDays(startDate, dayIndex) < today;
}

/**
 * The soft stops of a day that go back: placed by "Tag füllen", still
 * planned, not the spot of a fixed time, and with no visit seen there
 * (a visit waiting for its question counts: the group may well have
 * been there).
 */
export function softStopsToReturn(day: StoredDay, visited: ReadonlySet<number>): StoredStop[] {
  const fixed = new Set(day.fixpoints.map((fix) => fix.spotRef).filter((ref): ref is string => !!ref));
  return day.blocks
    .flatMap((block) => block.stops)
    .filter((stop) =>
      stop.placedBy === "fill"
      && stop.status === "planned"
      && !fixed.has(stop.osmRef)
      && !visited.has(stop.rowId));
}

/** "Hafenmuseum und Altstadt", "A, B und C". */
export function namesSentence(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} und ${names[names.length - 1]}`;
}

/**
 * Give back what the days of this plan that are over did not reach.
 * Returns how many days were changed. Run by the cron; safe to run
 * twice, because a stop given back is no longer on its day.
 */
export async function returnOpenSpots(planId: number, now: Date = new Date()): Promise<number> {
  const ownerId = await planOwner(planId);
  if (ownerId === null) return 0;
  let changed = 0;
  // Reloaded after every day: each write replaces the stay's pool, and
  // the next day must build on the pool as it is now.
  for (;;) {
    const plan = await loadPlan(planId, ownerId);
    if (!plan) return changed;
    const found = await nextDayToReturn(plan.legs, now);
    if (!found) return changed;
    const { leg, day, stops } = found;

    const leaving = new Set(stops.map((stop) => stop.rowId));
    const blocks = day.blocks.map((block) => ({
      ...block,
      stops: block.stops.filter((stop) => !leaving.has(stop.rowId)).map((stop) => ({ ...stop })),
    }));
    recomputeDay(blocks, dayWalkOfStored(leg.anchor, day), leg.mode);
    const known = new Set(leg.pool.map((c) => c.osmRef));
    const pool = [...leg.pool, ...stops.filter((stop) => !known.has(stop.osmRef)).map(candidateOfStop)];
    await saveRedistribution(plan.id, leg.id, day, blocks, pool);

    const spots: ReturnedSpot[] = stops.map((stop) => ({ osmRef: stop.osmRef, name: stop.title ?? stop.name }));
    const names = spots.map((spot) => spot.name ?? "ein Spot");
    const sentence = `${namesSentence(names)} ${names.length === 1 ? "ist" : "sind"} wieder offen: `
      + `an Tag ${day.dayIndex + 1} nicht geschafft`;
    await db.insert(tripPlanOps).values({
      plan_id: plan.id,
      client_op_id: `return-open-${leg.id}-${day.dayIndex}-${crypto.randomUUID()}`,
      kind: RETURN_OPEN_OP,
      payload: { legIndex: leg.position, dayIndex: day.dayIndex, spots, sentence },
      // Nobody did this; the app did, and the journal says so by naming no one.
      actor_id: null,
    });
    changed += 1;
  }
}

async function nextDayToReturn(
  legs: readonly StoredLeg[],
  now: Date,
): Promise<{ leg: StoredLeg; day: StoredDay; stops: StoredStop[] } | null> {
  for (const leg of legs) {
    if (leg.kind !== "stay") continue;
    const today = localDateIn(zoneAt(leg.anchor), now);
    for (const day of leg.days) {
      if (!dayIsOver(leg.startDate, day.dayIndex, today)) continue;
      const soft = day.blocks.flatMap((block) => block.stops).filter((stop) => stop.placedBy === "fill");
      if (soft.length === 0) continue;
      const visited = await visitedStops(soft.map((stop) => stop.rowId));
      const stops = softStopsToReturn(day, visited);
      if (stops.length > 0) return { leg, day, stops };
    }
  }
  return null;
}

/** The stops among these with a visit seen there that nobody said no to. */
async function visitedStops(stopIds: readonly number[]): Promise<Set<number>> {
  if (stopIds.length === 0) return new Set();
  const rows = await db
    .select({ stopId: tripPlanVisits.stop_id })
    .from(tripPlanVisits)
    .where(and(inArray(tripPlanVisits.stop_id, [...stopIds]), eq(tripPlanVisits.dismissed, false)));
  return new Set(rows.map((row) => row.stopId).filter((id): id is number => id !== null));
}

/** The plans that have a soft stop still planned somewhere: the cron's work list. */
export async function plansWithSoftStops(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ planId: tripPlanLegs.plan_id })
    .from(tripPlanStops)
    .innerJoin(tripPlanBlocks, eq(tripPlanBlocks.id, tripPlanStops.block_id))
    .innerJoin(tripPlanDays, eq(tripPlanDays.id, tripPlanBlocks.day_id))
    .innerJoin(tripPlanLegs, eq(tripPlanLegs.id, tripPlanDays.leg_id))
    .where(and(eq(tripPlanStops.placed_by, "fill"), eq(tripPlanStops.status, "planned")));
  return rows.map((row) => row.planId);
}

/** The cron: every plan with soft stops, one after another. */
export async function tickReturnOpen(now: Date = new Date()): Promise<number> {
  let changed = 0;
  for (const planId of await plansWithSoftStops()) {
    changed += await returnOpenSpots(planId, now);
  }
  return changed;
}

/**
 * Put the spots of a `return-open` entry back on their day, as firm
 * stops, where they are still open. A spot placed elsewhere since, or
 * no longer an idea of the stay, is a later decision and stays.
 */
export async function placeReturnedAgain(
  planId: number,
  userId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const plan = await loadPlan(planId, userId);
  if (!plan) return;
  const leg = plan.legs.find((l) => l.position === payload.legIndex);
  const day = leg?.days.find((d) => d.dayIndex === payload.dayIndex);
  if (!leg || !day) return;
  const blockId = day.blocks.find((block) => block.kind === "spots")?.id ?? day.blocks[0]?.id;
  if (!blockId) return;
  const spots = Array.isArray(payload.spots) ? (payload.spots as ReturnedSpot[]) : [];

  let blocks: CurrentBlock[] = day.blocks;
  const placed: string[] = [];
  for (const spot of spots) {
    const candidate = await findInPool(leg.id, spot.osmRef);
    if (!candidate) continue;
    try {
      blocks = insertStop({
        blocks,
        stop: {
          osmRef: candidate.osmRef,
          name: candidate.name,
          localName: candidate.localName ?? null,
          wikipediaUrl: candidate.wikipediaUrl ?? null,
          facadeAzimuth: candidate.facadeAzimuth ?? null,
          kind: candidate.kind ?? null,
          extent: candidate.extent,
          lat: candidate.lat,
          lon: candidate.lon,
          category: candidate.category,
          dwellMinutes: candidate.dwellMinutes,
          score: candidate.score,
          travelFromPrevious: { minutes: 0, distanceM: 0, travelClass: "short_walk" },
          status: "planned",
          pinned: true,
          note: candidate.note,
          sourceUrl: candidate.sourceUrl,
          origin: candidate.origin,
          priority: candidate.priority,
          openingHours: candidate.openingHours ?? null,
          reasons: candidate.reasons,
          placedBy: "hand",
        },
        toBlockId: blockId,
        walk: dayWalkOfStored(leg.anchor, day),
        mode: leg.mode,
      }).blocks;
      placed.push(spot.osmRef);
    } catch (err) {
      if (err instanceof MoveError) continue;
      throw err;
    }
  }
  if (placed.length === 0) return;
  await saveMovedDays(plan.id, [{ day, blocks }]);
  for (const osmRef of placed) await removeFromPool(leg.id, osmRef);
}
