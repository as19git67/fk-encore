/**
 * Where a day actually begins and ends (§4.2, §4.4).
 *
 * The anchor is the accommodation, and for an ordinary day it is both:
 * you leave the hotel in the morning and come back to it at night. Two
 * days of a trip are not ordinary, and they are the two everybody
 * remembers.
 *
 * On the first day you arrive at a station or an airport, with luggage,
 * and the way from *there* is the way you walk. On the last day the
 * train leaves from the station, and the evening's route has to end at
 * the platform rather than at a hotel you already checked out of.
 * Planning both from the anchor puts a walk in the plan that nobody
 * makes and leaves out the one they do.
 *
 * A fixpoint could already carry a coordinate (§4.4) — the planner
 * stored it and then ignored it: `solveDay` has taken a `start` since
 * it was written, and nothing ever passed one. This module is the rule
 * that decides which fixpoint is which, kept pure so both the trip
 * planner and the single-day endpoints read the same one.
 *
 * Deliberately only the two ends. A fixpoint in the middle of the day
 * with a coordinate — the booked tour at two — would have to split a
 * block to move the route, and a block that is silently two blocks is
 * worse than a walk that is slightly long. It keeps costing its time,
 * as it always did.
 */

import type { FixpointKind } from "./fixpoints";
import type { Coordinate } from "./travel";

/** A fixpoint as this module needs it: resolved times, maybe a place. */
export interface LocatedFixpoint {
  label: string;
  kind: FixpointKind;
  /** Minutes since midnight where the fixpoint itself begins. */
  startMinutes: number;
  /** Where it lets go of the day again — its own end (`ResolvedFixpoint`). */
  endMinutes: number;
  lat?: number | null;
  lon?: number | null;
}

/** One end of a day, and what to call it. */
export interface DayEnd extends Coordinate {
  label: string;
}

export interface DayEnds {
  /** Where the first block sets off from, or null for "the anchor". */
  start: DayEnd | null;
  /** Where the last block has to finish, or null for "the anchor". */
  end: DayEnd | null;
}

const NOWHERE: DayEnds = { start: null, end: null };

/**
 * The day's two ends, out of its fixpoints.
 *
 * `blocks` are the day as scheduled — only their first start is read,
 * to tell "before the day" from "during it".
 */
export function dayEnds(
  fixpoints: readonly LocatedFixpoint[],
  blocks: readonly { startMinutes: number }[],
): DayEnds {
  const located = fixpoints.filter(hasPlace);
  if (located.length === 0) return NOWHERE;

  // A departure ends the day wherever it is: after the last train you
  // are gone, and the way back to the hotel is not a way anybody makes.
  // The earliest one wins — a second departure the same day is somebody
  // correcting themselves, and the earlier one is the one that catches.
  const departures = located
    .filter((f) => f.kind === "departure")
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const end = departures[0] ?? null;

  // The start is whatever finished *before* the day's first block —
  // the arrival, in practice. The latest such one, because that is the
  // place you are standing when the day begins. Departures are never
  // candidates: they are the far end of the same day.
  const firstBlockStart = blocks.length === 0
    ? null
    : Math.min(...blocks.map((b) => b.startMinutes));
  const start = firstBlockStart === null
    ? null
    : located
      .filter((f) => f.kind !== "departure" && f.endMinutes <= firstBlockStart)
      .sort((a, b) => b.endMinutes - a.endMinutes)[0] ?? null;

  return { start: toEnd(start), end: toEnd(end) };
}

function hasPlace(f: LocatedFixpoint): boolean {
  return typeof f.lat === "number" && typeof f.lon === "number"
    && Number.isFinite(f.lat) && Number.isFinite(f.lon);
}

function toEnd(f: LocatedFixpoint | null): DayEnd | null {
  if (f === null) return null;
  return { lat: f.lat as number, lon: f.lon as number, label: f.label };
}
