/**
 * Travel-time estimation for the planner — deliberately coarse.
 *
 * The plan speaks in blocks, not clock times (see
 * docs/ios-urlaubsplanung.md §4.1), so a leg only has to be good enough
 * to charge against a block budget. That makes a straight-line estimate
 * with a detour factor sufficient for the first implementation steps,
 * and it keeps the planner free of a routing engine — which the concept
 * moves to a later refinement precisely because of this (§12).
 *
 * Everything here is pure and synchronous: no network, no database, no
 * clock. That is what lets the whole planner be tested deterministically
 * and re-run offline while travelling.
 */

/** Mean earth radius in metres (WGS-84 sphere approximation). */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Streets do not run in straight lines. 1.3 is the usual rule of thumb
 * for dense European city centres; open landscapes and rivers make it
 * worse, which is one reason the concept flags these estimates as
 * estimates (§14).
 */
export const DETOUR_FACTOR = 1.3;

/** 4.5 km/h — an unhurried pace with luggage, children or a camera. */
export const WALKING_SPEED_M_PER_MIN = 75;

/**
 * How the group gets around on this leg (§4.2). It belongs to the leg
 * rather than the trip: arriving by car does not mean driving around
 * the old town.
 */
export type TransportMode = "foot" | "bike" | "transit" | "car";

/**
 * Speeds in metres per minute while actually moving, deliberately
 * pessimistic. What happens before you move is the overhead below.
 *
 * Splitting the two matters more than the numbers themselves: a mode
 * with a large fixed cost loses to the bicycle over a few hundred
 * metres and beats it over a few kilometres, and a single average speed
 * cannot express that. Getting either too optimistic is worse than
 * getting both too coarse — an overfull block reads as a plan that
 * failed, and the concept treats a kept promise as the point (§14).
 */
export const SPEED_M_PER_MIN: Readonly<Record<TransportMode, number>> = {
  foot: WALKING_SPEED_M_PER_MIN,
  // ~12 km/h door to door: city cycling with junctions and locking up.
  bike: 200,
  // ~24 km/h while moving. The walk to the stop and the wait are the
  // overhead below, not a slower speed.
  transit: 400,
  // ~20 km/h through a city with lights and one-way streets.
  car: 330,
};

/**
 * The detour factor per mode. A pedestrian cuts through a passage a car
 * cannot, and transit follows lines rather than the direct way.
 */
export const DETOUR_FACTOR_BY_MODE: Readonly<Record<TransportMode, number>> = {
  foot: DETOUR_FACTOR,
  bike: DETOUR_FACTOR,
  transit: 1.5,
  car: 1.4,
};

/**
 * Below this, as the crow flies, nobody waits for a bus or fetches the
 * car — they walk. Charging a hop across the square seven minutes of
 * overhead would push real stops out of a block for nothing.
 */
const OVERHEAD_FLOOR_M = 200;

/** A fixed cost per hop that has nothing to do with distance. */
const OVERHEAD_MINUTES: Readonly<Record<TransportMode, number>> = {
  foot: 0,
  // Unlocking and locking up.
  bike: 2,
  // The walk to the stop and the wait for a departure.
  transit: 10,
  // Getting the car out, then finding a space and walking from it.
  car: 6,
};

/**
 * A single leg longer than this is almost certainly a planning mistake
 * rather than a walk anyone wants; the caller can lower it but not
 * silently plan a two-hour march.
 */
export const DEFAULT_MAX_WALK_MINUTES = 40;

export interface Coordinate {
  lat: number;
  lon: number;
}

/**
 * How a hop reads on a block card. Minutes stay available for the
 * budget; the class is what the user sees (§4.1).
 */
export type TravelClass = "short_walk" | "long_walk" | "short_ride" | "long_ride";

/** Under ten minutes reads as "just over there", above it as a journey. */
export function travelClassFor(minutes: number, mode: TransportMode): TravelClass {
  if (mode === "foot") return minutes < 10 ? "short_walk" : "long_walk";
  return minutes < 10 ? "short_ride" : "long_ride";
}

export interface TravelLeg {
  distanceM: number;
  minutes: number;
  travelClass: TravelClass;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Straight line × detour factor ÷ speed + overhead, rounded to a minute. */
export function travelLeg(
  from: Coordinate,
  to: Coordinate,
  mode: TransportMode = "foot",
): TravelLeg {
  const straight = haversineMeters(from, to);
  const distanceM = Math.round(straight * DETOUR_FACTOR_BY_MODE[mode]);
  const overhead = straight < OVERHEAD_FLOOR_M ? 0 : OVERHEAD_MINUTES[mode];
  const minutes = Math.round(distanceM / SPEED_M_PER_MIN[mode] + overhead);
  return { distanceM, minutes, travelClass: travelClassFor(minutes, mode) };
}

/** The pedestrian case, which is the default everywhere. */
export function walkingLeg(from: Coordinate, to: Coordinate): TravelLeg {
  return travelLeg(from, to, "foot");
}
