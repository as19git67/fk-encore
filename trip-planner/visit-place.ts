/**
 * Where a visited stop belongs (§6.4, §8.5).
 *
 * Out of the trial: the plan had the church in the afternoon, the
 * family walked past it at half past ten and went in, the geofence
 * ticked it off — and the day went on saying the church was an
 * afternoon thing. A tick the device observed carries the moment it
 * happened, so the stop can go where it actually took place: into the
 * block that covers the arrival, in the order the day was lived.
 *
 * Only the device's own observation moves anything. A tick by hand says
 * "seen", not "seen now": somebody ticking off the morning over dinner
 * would otherwise pull the whole morning into the evening.
 *
 * Pure: a day and a moment in, a place out. No clock, no database.
 */

import { addDays } from "./leg-dates";
import type { StopStatus } from "./redistribute";

export interface PlaceableStop {
  osmRef: string;
  status: StopStatus;
  doneAt?: string | null;
}

export interface PlaceableBlock {
  id: string;
  kind: string;
  startMinutes: number | null;
  budgetMinutes: number;
  stops: readonly PlaceableStop[];
  /** A split block (§6.5) has its stops in branches; nothing goes in. */
  branches?: readonly unknown[];
}

export interface PlaceableDay {
  dayIndex: number;
  detailed: boolean;
  blocks: readonly PlaceableBlock[];
}

export interface VisitPlacement {
  dayIndex: number;
  blockId: string;
  /** Where in the block, from zero, with the stop itself taken out. */
  position: number;
}

export interface PlaceVisitedStopRequest {
  days: readonly PlaceableDay[];
  /** The leg's first day. Without it there is no "which day was that". */
  startDate: string | null;
  osmRef: string;
  /** When the group got there, as an ISO timestamp. */
  arrivedAt: string;
  /** The device's offset from UTC at that moment, in minutes. */
  utcOffsetMinutes: number;
}

/** The wall clock at the destination: its date and minutes past midnight. */
export function localClock(at: Date, utcOffsetMinutes: number): { date: string; minutes: number } {
  const shifted = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * The block and position the visited stop belongs in, or null when it
 * is already there or nothing can be said.
 *
 * The block is the spots block covering the arrival. An arrival that
 * falls outside every spots block — in the lunch break, after the last
 * block ended — goes to the nearest one, the earlier on a tie: the
 * lunch-time visit to a church belongs with the morning that led to
 * it more than with nothing. Within the block, it follows the stops
 * ticked off before it, so the block reads in the order it was lived;
 * what is still open comes after.
 *
 * Null — leave it where it is — when the leg has no dates, when the
 * arrival is on no day of the leg or on one not yet planned, when no
 * block of that day carries an hour, and when the stop already stands
 * exactly there.
 */
export function placeVisitedStop(req: PlaceVisitedStopRequest): VisitPlacement | null {
  if (!req.startDate) return null;
  const arrived = new Date(req.arrivedAt);
  if (Number.isNaN(arrived.getTime())) return null;
  const clock = localClock(arrived, req.utcOffsetMinutes);

  const day = req.days.find((d) => addDays(req.startDate as string, d.dayIndex) === clock.date);
  if (!day || !day.detailed) return null;

  const block = nearestSpotsBlock(day.blocks, clock.minutes);
  if (!block) return null;

  const others = block.stops.filter((s) => s.osmRef !== req.osmRef);
  let position = 0;
  others.forEach((stop, index) => {
    if (stop.status !== "done") return;
    // A tick older than the column has no moment; it was earlier.
    if (!stop.doneAt || new Date(stop.doneAt).getTime() <= arrived.getTime()) {
      position = index + 1;
    }
  });

  const here = where(req.days, req.osmRef);
  if (here && here.dayIndex === day.dayIndex && here.blockId === block.id && here.position === position) {
    return null;
  }
  return { dayIndex: day.dayIndex, blockId: block.id, position };
}

function nearestSpotsBlock(blocks: readonly PlaceableBlock[], minutes: number): PlaceableBlock | null {
  let best: PlaceableBlock | null = null;
  let bestDistance = Infinity;
  for (const block of blocks) {
    if (block.kind !== "spots" || block.startMinutes === null) continue;
    if ((block.branches?.length ?? 0) > 0) continue;
    const start = block.startMinutes;
    const end = start + Math.max(block.budgetMinutes, 1);
    const distance = minutes < start ? start - minutes : minutes >= end ? minutes - end + 1 : 0;
    // Strictly less: on a tie the earlier block, which comes first.
    if (distance < bestDistance) {
      best = block;
      bestDistance = distance;
    }
  }
  return best;
}

function where(days: readonly PlaceableDay[], osmRef: string): VisitPlacement | null {
  for (const day of days) {
    for (const block of day.blocks) {
      const position = block.stops.findIndex((s) => s.osmRef === osmRef);
      if (position >= 0) return { dayIndex: day.dayIndex, blockId: block.id, position };
    }
  }
  return null;
}
