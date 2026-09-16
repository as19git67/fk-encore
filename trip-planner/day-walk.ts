/**
 * Where a day starts and where it has to end (§4.4, §4.5).
 *
 * `solveDay` has known for a long time that a day is not necessarily a
 * loop around the quarters: it takes an `anchor`, a `start` and an
 * `end`, and the planner fills all three — the outing's destination for
 * a day trip, the station on the day you arrive, the platform on the
 * day you leave.
 *
 * Everything that touches a day **afterwards** knew only the anchor.
 * `recomputeDay` — the rewalk behind moving a spot, hiding one, putting
 * one back in the pool, the weather shuffle — took a single coordinate
 * and used it as both ends. On an ordinary day that is right and is why
 * it went unnoticed. On the days it is wrong it is wrong twice over:
 *
 *   - **A day trip.** The day was planned around Verona; a move rewalks
 *     it from the quarters, so the first leg is the hour-long drive and
 *     the last block pays for it again. The card then says the morning
 *     is over budget because somebody dragged a spot inside it.
 *   - **Arrival and departure.** The day planned from the station gets
 *     rewalked from a hotel nobody has reached yet; the day that ends at
 *     the platform gets a walk back to a hotel already checked out of.
 *
 * So the question "where does this day begin and end" gets one answer,
 * in one place, and both the solver and every rewalk ask it.
 *
 * Pure: coordinates in, coordinates out.
 */

import { dayEnds, type DayEnds } from "./day-ends";
import type { FixpointKind } from "./fixpoints";
import type { Coordinate } from "./travel";

/** The two ends of one day's route. */
export interface DayWalk {
  /** Where the first block sets off from. */
  start: Coordinate;
  /**
   * Where the last block with stops has to finish.
   *
   * Never null: a day always ends somewhere, and "nowhere" would be a
   * free evening the traveller does not have. After a departure it is
   * the platform rather than the quarters (§4.4).
   */
  end: Coordinate;
}

/**
 * The day's route frame, from the three things that can move it.
 *
 * The order is the order of authority: a fixpoint with a place beats
 * the day's own anchor, which beats the leg's. An arrival says where
 * you are standing when the day begins better than any anchor can, and
 * it says nothing at all about the evening — so the two ends are
 * decided separately and either may fall back on its own.
 */
export function dayWalkOf(
  legAnchor: Coordinate,
  dayAnchor: Coordinate | null | undefined,
  ends?: DayEnds | null,
): DayWalk {
  const base = placeOf(dayAnchor) ?? legAnchor;
  return {
    start: placeOf(ends?.start) ?? base,
    end: placeOf(ends?.end) ?? base,
  };
}

/** A day as the storage layer hands it over, and no more than that. */
export interface StoredDayShape {
  anchor?: { lat: number; lon: number } | null;
  fixpoints?: readonly StoredFixpointShape[];
  blocks?: readonly { startMinutes?: number | null }[];
}

export interface StoredFixpointShape {
  label: string;
  kind?: FixpointKind;
  startMinutes: number;
  durationMinutes?: number | null;
  lat?: number | null;
  lon?: number | null;
}

/**
 * The same rule, for a day that came out of the database.
 *
 * Every endpoint that rewalks a day has this shape in its hands and
 * nothing else, and each one deriving the ends itself is how they came
 * to disagree in the first place.
 */
export function dayWalkOfStored(legAnchor: Coordinate, day: StoredDayShape): DayWalk {
  return dayWalkOf(legAnchor, day.anchor, endsOfStored(day));
}

/**
 * `dayEnds` over stored rows: the located fixpoints, and the hours the
 * blocks are scheduled at.
 *
 * Kept next to the walk rather than at each call site because the two
 * mappings — a fixpoint's end is its start plus its duration, a block
 * without an hour takes no part — are exactly what a caller writing it
 * from memory gets subtly wrong.
 */
export function endsOfStored(day: StoredDayShape): DayEnds {
  return dayEnds(
    (day.fixpoints ?? []).map((f) => ({
      label: f.label,
      kind: f.kind ?? "appointment",
      startMinutes: f.startMinutes,
      endMinutes: f.startMinutes + (f.durationMinutes ?? 0),
      lat: f.lat,
      lon: f.lon,
    })),
    (day.blocks ?? []).flatMap((b) =>
      b.startMinutes === null || b.startMinutes === undefined
        ? []
        : [{ startMinutes: b.startMinutes }],
    ),
  );
}

function placeOf(
  candidate: { lat?: number | null; lon?: number | null } | null | undefined,
): Coordinate | null {
  if (!candidate) return null;
  const { lat, lon } = candidate;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}
