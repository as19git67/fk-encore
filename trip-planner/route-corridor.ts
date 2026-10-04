/**
 * The corridor along the roads (§24, stage 2).
 *
 * Until now the corridor was an ellipse with the two ends as foci: for
 * a day's drive it is a band a few kilometres wide around the straight
 * line, and the motorway is often not in it. So the candidates sat on
 * the line between the two cities and not on the way anybody drives.
 *
 * With a router the corridor follows the road: the route from A to B,
 * and the one or two alternatives the network offers, each widened by
 * half the detour budget (a stop `d` metres off the road costs about
 * `2d`). Geo searches along those lines; what comes back is then
 * measured properly — origin to stop, stop to destination, at the
 * router — so the detour that orders the pool is the one the car
 * drives, not the crow's.
 *
 * Without a router nothing here answers, and the ellipse serves as it
 * always has. Every function returns null or the estimate for that
 * case; none of them refuses.
 */

import type { LatLonBox } from "../osm-admin/region-router";
import { decodePolyline, thinPolyline } from "./polyline";
import type { RouterClient } from "./router-client";
import { haversineMeters, type Coordinate, type TransportMode } from "./travel";

/** How many other ways to ask for besides the best one. */
export const ALTERNATE_ROUTES = 2;
/** Points per road handed to geo: enough for the line, not the centimetres. */
export const MAX_PATH_POINTS = 400;
/** At most this many candidates measured at the router — the matrix cap. */
export const MAX_MEASURED = 120;

export interface RoadCorridor {
  /** Each road as a thinned line, best first. */
  paths: Coordinate[][];
  /** Half the detour budget: how far off the road a stop may lie. */
  widthM: number;
  /** The best road's length, in metres and minutes. */
  directM: number;
  directMinutes: number;
}

/**
 * The roads from here to there, as the router knows them, or null when
 * it does not (away, no tiles for this part of the world, a mode it
 * cannot route). A road that comes back without a shape is dropped.
 */
export async function roadsBetween(
  router: RouterClient,
  from: Coordinate,
  to: Coordinate,
  mode: TransportMode,
  detourBudgetM: number,
): Promise<RoadCorridor | null> {
  const routes = await router.routes(from, to, mode, ALTERNATE_ROUTES);
  if (!routes || routes.length === 0) return null;
  const paths = routes
    .map((r) => (r.shape ? decodePolyline(r.shape) : []))
    .filter((p) => p.length >= 2)
    .map((p) => thinPolyline(p, MAX_PATH_POINTS));
  if (paths.length === 0) return null;
  return {
    paths,
    widthM: Math.max(100, Math.round(detourBudgetM / 2)),
    directM: routes[0].distanceM,
    directMinutes: routes[0].minutes,
  };
}

/** The rectangle around every road, grown by the corridor's width. */
export function pathsBox(paths: readonly (readonly Coordinate[])[], widthM: number): LatLonBox {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  const midLat = (minLat + maxLat) / 2;
  const padLat = widthM / METRES_PER_DEGREE;
  const padLon = widthM / (METRES_PER_DEGREE * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLon: minLon - padLon, maxLon: maxLon + padLon };
}

const METRES_PER_DEGREE = (2 * Math.PI * 6_371_008) / 360;

export interface MeasuredDetour {
  osmRef: string;
  /** Metres the stop adds to the journey, driven; null where the router found no way. */
  detourM: number | null;
}

/**
 * The detour each candidate really costs: origin to stop plus stop to
 * destination, less the road itself — two matrix calls for the lot.
 * Candidates past `MAX_MEASURED` keep the estimate they came with; a
 * cell the router cannot fill does too. Null when the router is away.
 */
export async function measureDetours(
  router: RouterClient,
  from: Coordinate,
  to: Coordinate,
  mode: TransportMode,
  candidates: readonly { osmRef: string; lat: number; lon: number }[],
  directM: number,
): Promise<Map<string, number> | null> {
  const measured = candidates.slice(0, MAX_MEASURED);
  if (measured.length === 0) return new Map();
  const points = measured.map((c) => ({ lat: c.lat, lon: c.lon }));
  const [out, back] = await Promise.all([
    router.matrix([from], points, mode),
    router.matrix(points, [to], mode),
  ]);
  if (!out || !back) return null;
  const detours = new Map<string, number>();
  measured.forEach((c, i) => {
    const there = out[0]?.[i];
    const onward = back[i]?.[0];
    if (!there || !onward) return;
    detours.set(c.osmRef, Math.max(0, there.distanceM + onward.distanceM - directM));
  });
  return detours;
}

/** Straight-line distance for the estimate the ellipse used, kept for callers. */
export function crowDetour(from: Coordinate, to: Coordinate, at: Coordinate): number {
  return Math.max(0, haversineMeters(from, at) + haversineMeters(at, to) - haversineMeters(from, to));
}
