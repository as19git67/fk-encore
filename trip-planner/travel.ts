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
 * How a leg reads on a block card. Minutes stay available for the
 * budget; the class is what the user sees (§4.1).
 */
export type TravelClass = "short_walk" | "long_walk";

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

/** Straight line × detour factor ÷ walking speed, rounded to a minute. */
export function walkingLeg(from: Coordinate, to: Coordinate): TravelLeg {
  const straight = haversineMeters(from, to);
  const distanceM = Math.round(straight * DETOUR_FACTOR);
  const minutes = Math.round(distanceM / WALKING_SPEED_M_PER_MIN);
  return { distanceM, minutes, travelClass: minutes < 10 ? "short_walk" : "long_walk" };
}
