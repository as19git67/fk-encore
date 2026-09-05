/**
 * Bringing your own finds into the pool (§9.2).
 *
 * The planner proposes candidates, but your own research is the second
 * and at least as important source — and it must not be a break in the
 * flow: what you find belongs in the pool with **one** gesture, where it
 * competes with everything else.
 *
 * This module holds the two decisions that are pure, and they are the
 * two that go quietly wrong if nobody writes them down:
 *
 *   - **Which leg it belongs to.** By location, not by which leg you are
 *     looking at: a café in Osaka goes into the Osaka leg even while you
 *     are standing in Tokyo. In none of them, the caller has to ask —
 *     silently dropping it into the nearest leg would put a find on
 *     entirely the wrong week.
 *   - **Whether it is already there.** A second entry for the same place
 *     is how a pool goes to seed. Note, source and contributor move to
 *     the existing entry instead.
 *
 * Everything else about a find — matching an OSM entry, asking for a
 * duration — is I/O and lives in the endpoint.
 */

import { haversineMeters, type Coordinate } from "./travel";

/**
 * How far a find may sit from a leg's anchor and still belong to it.
 *
 * Generous on purpose: a day trip an hour out of the city is still that
 * city's leg, and the anchor is a hotel rather than a centroid of
 * everything planned. What this number really rules out is a find in a
 * different country, which is exactly the case where guessing is worse
 * than asking.
 */
export const MAX_LEG_DISTANCE_M = 150_000;

/**
 * Two spots this close with the same name are the same place. OSM
 * entries for one building can sit a few dozen metres apart — an
 * entrance node and the outline's centre — and a map app's coordinate
 * for it is rougher still.
 */
export const SAME_PLACE_METRES = 120;

export interface LegCandidate {
  position: number;
  title: string | null;
  anchor: Coordinate;
}

export interface LegChoice {
  /** The leg it belongs to, or null when the caller has to ask. */
  position: number | null;
  distanceM: number | null;
  /** Set when there is nothing to choose from. */
  reason?: "no-legs" | "too-far";
}

/**
 * Which leg a find belongs to, by where it is.
 *
 * The nearest anchor wins, and only if it is near enough at all. Two
 * legs in the same city both being "near" is not a problem worth
 * solving here: either answer is right, and the traveller can move it.
 */
export function chooseLeg(
  find: Coordinate,
  legs: readonly LegCandidate[],
): LegChoice {
  if (legs.length === 0) return { position: null, distanceM: null, reason: "no-legs" };

  let best: { position: number; distanceM: number } | null = null;
  for (const leg of legs) {
    const distanceM = haversineMeters(find, leg.anchor);
    if (best === null || distanceM < best.distanceM) {
      best = { position: leg.position, distanceM };
    }
  }

  if (!best || best.distanceM > MAX_LEG_DISTANCE_M) {
    return { position: null, distanceM: best?.distanceM ?? null, reason: "too-far" };
  }
  return { position: best.position, distanceM: best.distanceM };
}

export interface ExistingEntry {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
}

export interface IncomingFind {
  /** Set when an OSM entry was matched. */
  osmRef?: string | null;
  name?: string | null;
  lat: number;
  lon: number;
}

/**
 * Is this already in the pool, or already planned?
 *
 * Two tests, in order of how much they prove. An OSM reference is an
 * identity and settles it outright. Without one, a find is the same
 * place as an existing entry when it is close enough *and* named the
 * same — proximity alone would merge the two museums that share a
 * courtyard, and a name alone would merge every "Rathaus" in the leg.
 */
export function findDuplicate(
  find: IncomingFind,
  existing: readonly ExistingEntry[],
): ExistingEntry | null {
  if (find.osmRef) {
    const byRef = existing.find((e) => e.osmRef === find.osmRef);
    if (byRef) return byRef;
  }

  const name = normaliseName(find.name);
  if (!name) return null;

  for (const entry of existing) {
    if (normaliseName(entry.name) !== name) continue;
    if (haversineMeters(find, entry) <= SAME_PLACE_METRES) return entry;
  }
  return null;
}

/**
 * Names as people and OSM write them differ in case, spacing and the
 * odd article. Enough normalisation to catch that, and no more:
 * anything cleverer starts merging places that only sound alike.
 */
function normaliseName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name
    .toLocaleLowerCase("de")
    .replace(/\s+/g, " ")
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A reference for a find no OSM entry could be matched to.
 *
 * Its own namespace rather than a made-up node id: everything
 * downstream reads an `osmRef` as "this is what OpenStreetMap calls
 * it", and a fake one would be a claim the data does not support
 * (§15.3). The prefix says plainly that this came from a person.
 */
export function manualRef(seed: string): string {
  return `manual:${seed}`;
}

/** True for a reference this module invented rather than matched. */
export function isManualRef(osmRef: string): boolean {
  return osmRef.startsWith("manual:");
}
