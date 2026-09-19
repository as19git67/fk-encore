/**
 * A spot with an extent — where the way is the point (§4.7).
 *
 * Every spot the planner knows is a point: you walk to it, you stay a
 * while, you walk on from where you stand. The Ponale road above Lake
 * Garda is not that. It starts at one end of a lake and finishes at a
 * different lake, takes as long as it takes, and the next walk of the
 * day starts where it *ends*, not where it began. A point cannot say
 * so, and a day that rewalks from its start charges the afternoon a
 * leg nobody makes.
 *
 * So a spot may carry an extent: the place it finishes and, where
 * known, how long and how steep it is. Everything else about it stays
 * a spot — it lives in the pool, is scored, hidden, voted on and
 * planned like any other — which is the whole design: one entity, one
 * optional shape, not a second kind of thing beside the first.
 *
 * What an extent changes, and where:
 *
 *   - the walk after it starts at its end (`leaveFrom`), in the solver
 *     and in every rewalk (move, redistribution, weather, light);
 *   - its duration is its own, not its category's — the note's dwell
 *     override (§9.2) or the duration the find was saved with.
 *
 * What it deliberately does not do yet (§4.7): span two blocks, absorb
 * the viewpoints along it, or come out of the region import. A route
 * enters as a find, by hand, with its two ends.
 *
 * Pure: coordinates in, coordinates out.
 */

import { haversineMeters, type Coordinate } from "./travel";

export interface SpotExtent {
  /** Where the spot finishes. Absent means a loop: back where it began. */
  end: Coordinate;
  /** How long the way is, in metres, where known. */
  lengthM?: number | null;
  /** How much of it goes uphill, in metres, where known. */
  ascentM?: number | null;
  /**
   * The way itself, coarsely (§4.7): the points a route actually runs
   * through, as the OSM relation has them, thinned to something a plan
   * can carry offline.
   *
   * Absent for a route somebody entered by hand, which knows only its
   * two ends. What it buys is the corridor: the line between the ends
   * cuts straight through the Ponale's switchbacks, and a viewpoint on
   * the third bend is only recognised as "on the way" against the real
   * shape (`on-the-way.ts`).
   *
   * Never `| null`: Encore's schema parser cannot intersect an
   * interface with null when one interface narrows another's array
   * field — see the note on `Candidate.extent` in solver.ts.
   */
  via?: Coordinate[];
}

/**
 * The farthest apart a spot's two ends may lie.
 *
 * A route is a thing you do in a block, not a transfer between legs: a
 * day's ride along a lake is under this, a drive across a country is
 * not, and the latter is a transfer (§4.2) wearing the wrong coat.
 */
export const MAX_EXTENT_M = 80_000;

/**
 * The most points a route's shape may carry.
 *
 * The same ceiling geo thins to: enough to follow a way's bends, few
 * enough that a fortnight of them still fits in an offline bundle.
 */
export const MAX_VIA_POINTS = 64;

/** The place the day goes on from after this stop. */
export function leaveFrom(stop: Coordinate & { extent?: SpotExtent | null }): Coordinate {
  const end = stop.extent?.end;
  return end ? { lat: end.lat, lon: end.lon } : { lat: stop.lat, lon: stop.lon };
}

/** What an extent looks like before it has been checked. */
export interface ExtentInput {
  end?: { lat: number; lon: number } | null;
  lengthM?: number | null;
  ascentM?: number | null;
  /** The way's own shape, where it came from an OSM relation (§4.7). */
  via?: readonly { lat: number; lon: number }[] | null;
}

/**
 * An extent from what a request carried, or null when it carried none.
 *
 * Throws a plain `Error` with the reason in the traveller's words; the
 * endpoint turns it into the right status. Length and ascent without
 * an end are refused rather than kept: a point with a length is a
 * contradiction, and storing one would be storing a question.
 */
export function extentOf(start: Coordinate, input: ExtentInput | undefined): SpotExtent | null {
  if (!input) return null;
  const { end, lengthM, ascentM } = input;
  if (end == null) {
    if (lengthM != null || ascentM != null) {
      throw new Error("Länge oder Anstieg ohne Endpunkt — eine Strecke braucht ihr Ende");
    }
    return null;
  }
  if (!isCoordinate(end)) throw new Error("der Endpunkt ist keine gültige Koordinate");

  const apart = haversineMeters(start, end);
  if (apart > MAX_EXTENT_M) {
    throw new Error(
      `Start und Ende liegen ${Math.round(apart / 1000)} km auseinander — das ist ein `
        + "Transfer, keine Strecke in einem Block",
    );
  }

  const extent: SpotExtent = { end: { lat: end.lat, lon: end.lon } };
  if (lengthM != null) {
    if (!isPositive(lengthM)) throw new Error("die Länge muss eine positive Zahl in Metern sein");
    // The way can be longer than the straight line, never shorter.
    if (lengthM < apart * 0.9) {
      throw new Error("die Länge ist kürzer als die Luftlinie zwischen Start und Ende");
    }
    extent.lengthM = Math.round(lengthM);
  }
  if (ascentM != null) {
    if (!(Number.isFinite(ascentM) && ascentM >= 0)) {
      throw new Error("der Anstieg muss eine Zahl in Metern sein, null oder mehr");
    }
    extent.ascentM = Math.round(ascentM);
  }
  // A shape of one point is not a way; anything that is not a run of
  // coordinates is dropped rather than half-kept, and the route falls
  // back on the line between its ends.
  const via = (input.via ?? []).filter(isCoordinate);
  if (via.length >= 2) {
    if (via.length > MAX_VIA_POINTS) {
      throw new Error(`der Verlauf hat mehr als ${MAX_VIA_POINTS} Punkte`);
    }
    extent.via = via.map((p) => ({ lat: p.lat, lon: p.lon }));
  }
  return extent;
}

/**
 * An extent as it comes back out of a JSON column: whatever was
 * stored, or undefined. Written by `extentOf`, so it is not re-validated —
 * only shaped, so a row from before the column existed reads as a
 * point.
 */
export function storedExtent(value: unknown): SpotExtent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SpotExtent>;
  if (!raw.end || !isCoordinate(raw.end)) return undefined;
  const extent: SpotExtent = { end: { lat: raw.end.lat, lon: raw.end.lon } };
  if (typeof raw.lengthM === "number") extent.lengthM = raw.lengthM;
  if (typeof raw.ascentM === "number") extent.ascentM = raw.ascentM;
  const via = Array.isArray(raw.via) ? raw.via.filter(isCoordinate) : [];
  if (via.length >= 2) extent.via = via.map((p) => ({ lat: p.lat, lon: p.lon }));
  return extent;
}

function isCoordinate(value: unknown): value is Coordinate {
  if (!value || typeof value !== "object") return false;
  const { lat, lon } = value as Partial<Coordinate>;
  return typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
