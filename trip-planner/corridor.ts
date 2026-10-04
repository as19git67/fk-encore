/**
 * Trip planner — what is worth a stop on the way from A to B.
 *
 * Part of step 6 of docs/ios-urlaubsplanung.md §13: the transfer
 * between two legs is a planning object of its own (§4.2), not dead
 * time. The question is not "what is near here?" but "what can we see
 * without a real detour?", and the answer is the set of spots that
 * lengthen the journey by at most a stated budget — geometrically an
 * ellipse with the two ends as its foci, evaluated in geo.
 *
 * Stateless like `/trip-planner/day`, and for the same reason: the
 * result is a scored pool, not a plan. What the travellers do with it —
 * pin one to a transfer day, drop the rest — belongs to the plan
 * endpoints once legs exist.
 *
 * Deliberately still routerless. The detour is measured as the crow
 * flies, which overstates what a road can reach and understates a
 * detour around a lake; the budget is coarse enough for that to be the
 * right trade for now (§4.2), and when a router arrives this stays the
 * cheap pre-filter in front of it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion, regionsIntersecting, type LatLonBox } from "../osm-admin/region-router";
import { toCandidates, type ScoredCandidate } from "./candidates";
import { measureDetours, pathsBox, roadsBetween, type RoadCorridor } from "./route-corridor";
import { getRouterClient } from "./router-client";
import type { TransportMode } from "./travel";

/** Enough of a detour to be worth it, small enough not to be a second trip. */
const DEFAULT_DETOUR_BUDGET_M = 5_000;
const MAX_DETOUR_BUDGET_M = 50_000;
/** A corridor is a transfer between legs, not a route across a continent. */
const MAX_CORRIDOR_LENGTH_M = 400_000;
const CANDIDATE_LIMIT = 150;

export interface CorridorRequest {
  /** Where the transfer starts — usually the leg you are leaving. */
  from: { lat: number; lon: number };
  /** Where it ends — the next leg's anchor. */
  to: { lat: number; lon: number };
  /**
   * How many extra metres of travel the stop may cost, there and back.
   * A spot 500 m off the road costs about 1000 m. Defaults to 5 km.
   */
  detourBudgetM?: number;
  /** Geo categories to consider. Omitted = all the import carries. */
  categories?: string[];
  /** Categories the travellers care about; raises their score. */
  interests?: string[];
  /** Per-category dwell overrides, in minutes. */
  dwellMinutes?: Record<string, number>;
  /**
   * How the journey travels. With a reachable router and a mode it can
   * route, the corridor follows the roads (§24, stage 2); otherwise,
   * or when absent, the ellipse around the straight line.
   */
  mode?: TransportMode;
}

export interface CorridorSpot extends ScoredCandidate {
  /** Extra metres of travel this stop costs, there and back. */
  detourM: number;
}

export interface CorridorResponse {
  /** The region database the candidates came from — the start's. */
  region: string;
  /**
   * Every region searched, start's first. Two when the journey crosses
   * from one imported region into another (§22.7): Augsburg–Prag lies
   * in two Geofabrik extracts, and each holds its own half.
   */
  regions: string[];
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  detourBudgetM: number;
  /** Direct distance as the crow flies, in metres. */
  directDistanceM: number;
  /** Scored candidates, least detour first. */
  spots: CorridorSpot[];
  /**
   * Where the corridor came from: `router` when it follows the roads
   * and the detours are driven ones, `estimate` when it is the ellipse
   * around the straight line (§15.3: say which).
   */
  source: "router" | "estimate";
}

export const planCorridor = api(
  { expose: true, method: "POST", path: "/trip-planner/corridor", auth: true },
  async (req: CorridorRequest): Promise<CorridorResponse> => {
    requireUser();
    const from = validatePoint(req.from, "from");
    const to = validatePoint(req.to, "to");
    const detourBudgetM = validateBudget(req.detourBudgetM);

    const directDistanceM = greatCircleMetres(from, to);
    if (directDistanceM > MAX_CORRIDOR_LENGTH_M) {
      throw APIError.invalidArgument(
        `a corridor may span at most ${MAX_CORRIDOR_LENGTH_M} m, got ${Math.round(directDistanceM)} m`,
      );
    }

    const roads = req.mode ? await roadsBetween(getRouterClient(), from, to, req.mode, detourBudgetM) : null;
    const regions = await resolveRegions(from, to, detourBudgetM, roads);
    const spots = await corridorCandidates(regions, from, to, {
      detourBudgetM,
      categories: req.categories,
      interests: req.interests,
      dwellMinutes: req.dwellMinutes,
      roads,
      mode: req.mode,
    });

    return {
      region: regions[0],
      regions,
      from,
      to,
      detourBudgetM,
      directDistanceM: Math.round(directDistanceM),
      spots,
      source: roads ? "router" : "estimate",
    };
  },
);

/**
 * The regions the corridor is searched in: the start's, the
 * destination's, and every one the corridor passes through (§22.7).
 *
 * A search runs against one database, so a journey across imported
 * regions is one search per region, merged. Both *ends* must be
 * covered, or the answer would be half a corridor that looks whole
 * (§15.3); what lies between is searched where it is imported and
 * stays a hole where it is not.
 */
async function resolveRegions(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  detourBudgetM: number,
  roads: RoadCorridor | null = null,
): Promise<string[]> {
  const [fromRegion, toRegion] = await Promise.all([
    pickRegion(from.lat, from.lon),
    pickRegion(to.lat, to.lon),
  ]);
  if (!fromRegion || !toRegion) {
    const missing = !fromRegion ? "start" : "destination";
    throw APIError.failedPrecondition(
      `no imported OSM region covers the ${missing} of this journey — import it in the region admin first`,
    );
  }
  return await withRegionsAlong([fromRegion.postgresDb, toRegion.postgresDb], from, to, detourBudgetM, roads);
}

/**
 * The end regions plus whatever the corridor crosses, each once, ends
 * first.
 *
 * The ends come from the exact lookup (polygon and data probe); the
 * middle from the rectangles alone. Nothing between the ends is
 * *asked* to contain a point — the ellipse is the question, and a
 * region whose rectangle it touches is worth one search.
 */
async function withRegionsAlong(
  ends: readonly string[],
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  detourBudgetM: number,
  roads: RoadCorridor | null = null,
): Promise<string[]> {
  // Along the roads when they are known: a motorway that swings round
  // a mountain crosses extracts the straight line never touches.
  const box = roads ? pathsBox(roads.paths, roads.widthM) : corridorBox(from, to, detourBudgetM);
  const along = await regionsIntersecting(box);
  return [...new Set([...ends, ...along.map((r) => r.postgresDb)])];
}

/**
 * The rectangle around the corridor ellipse, in degrees.
 *
 * The ellipse has the two ends as foci and a string of length
 * `direct + budget`; it reaches `budget / 2` past either end along the
 * line and half its minor axis, `√(budget · (2·direct + budget)) / 2`,
 * to either side — which is the larger of the two, so the box of the
 * ends grows by that much all round. Generous by a little at the ends;
 * a rectangle around an ellipse always is.
 */
export function corridorBox(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  detourBudgetM: number,
): LatLonBox {
  const directM = greatCircleMetres(from, to);
  const padM = Math.sqrt(detourBudgetM * (2 * directM + detourBudgetM)) / 2;
  const midLat = (from.lat + to.lat) / 2;
  const padLat = padM / METRES_PER_DEGREE;
  const padLon = padM / (METRES_PER_DEGREE * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return {
    minLat: Math.min(from.lat, to.lat) - padLat,
    maxLat: Math.max(from.lat, to.lat) + padLat,
    minLon: Math.min(from.lon, to.lon) - padLon,
    maxLon: Math.max(from.lon, to.lon) + padLon,
  };
}

/** One degree of latitude on the sphere PostGIS measures with. */
const METRES_PER_DEGREE = (2 * Math.PI * 6_371_008) / 360;

export interface CorridorSearchOptions {
  detourBudgetM: number;
  categories?: string[];
  interests?: string[];
  dwellMinutes?: Record<string, number>;
  /** Only what is worth a block — for a pool a day is built from. */
  requireProminence?: boolean;
  /**
   * The roads from the router (§24, stage 2). Given, the search runs
   * along each of them instead of the ellipse, and the detours are
   * measured at the router; absent, the ellipse as before.
   */
  roads?: RoadCorridor | null;
  /** Needed with `roads`, to measure the detours in the same mode. */
  mode?: TransportMode;
}

/**
 * The scored spots within the detour budget, searched in each region
 * and merged: least detour first, each place once.
 *
 * Shared by the endpoint and by the transit leg (§22.7), whose pool is
 * exactly this — the places worth stopping at on the way.
 *
 * Geo searches one ellipse of at most 400 km; a day's drive can be
 * longer (Köln–München is 450 km as the crow flies). So the journey is
 * cut into stretches the service takes, each searched in every region,
 * and a place found from two stretches keeps the smaller detour. Along
 * a straight line the stretch ellipses lie inside the whole one, so
 * nothing is found that the long ellipse would not have; near the cut
 * a place is measured against the stretch's ends, which overstates
 * its detour by a little — the ordering, not the membership.
 */
export async function corridorCandidates(
  regions: readonly string[],
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  opts: CorridorSearchOptions,
): Promise<CorridorSpot[]> {
  const roads = opts.roads ?? null;
  const pages = roads
    // One search per road and region: the way there, and the one or
    // two other ways the network offers, each half a budget wide.
    ? await Promise.all(roads.paths.flatMap((points) => regions.map((region) =>
      getGeoClient().searchPois(region, {
        path: { points, widthM: roads.widthM },
        categories: opts.categories,
        limit: CANDIDATE_LIMIT,
      }))))
    : await Promise.all(corridorStretches(from, to).flatMap((stretch) => regions.map((region) =>
      getGeoClient().searchPois(region, {
        corridor: { from: stretch.from, to: stretch.to, detourBudgetM: opts.detourBudgetM },
        categories: opts.categories,
        limit: CANDIDATE_LIMIT,
      }))));
  // A place near a border can sit in both extracts, and one near a cut
  // in both stretches; it is one place, at its smaller detour.
  const byRef = new Map<string, (typeof pages)[number]["spots"][number]>();
  for (const page of pages) {
    for (const spot of page.spots) {
      const seen = byRef.get(spot.osmRef);
      if (!seen || (spot.detourM ?? 0) < (seen.detourM ?? 0)) byRef.set(spot.osmRef, spot);
    }
  }
  const raw = [...byRef.values()];

  // The detour is what makes a corridor result different from a
  // radius result, so it has to survive scoring — `toCandidates` keys
  // on osmRef, which is stable, so a lookup restores it.
  const detourByRef = new Map(raw.map((s) => [s.osmRef, s.detourM ?? 0]));
  const scored = toCandidates(raw, {
    interests: opts.interests,
    dwellMinutes: opts.dwellMinutes,
    requireProminence: opts.requireProminence,
  })
    .map((c) => ({ ...c, detourM: Math.round(detourByRef.get(c.osmRef) ?? 0) }))
    .sort((a, b) => a.detourM - b.detourM || (a.osmRef < b.osmRef ? -1 : 1));
  if (!roads || !opts.mode) return scored;

  // The detour that orders the pool is the one the car drives: origin
  // to stop and stop to destination at the router, less the road. What
  // the router cannot measure keeps the distance off the road; what
  // costs more than the budget on the road is not a stop on the way.
  const driven = await measureDetours(getRouterClient(), from, to, opts.mode, scored, roads.directM);
  if (!driven) return scored;
  return scored
    .map((c) => ({ ...c, detourM: driven.get(c.osmRef) ?? c.detourM }))
    .filter((c) => c.detourM <= opts.detourBudgetM)
    .sort((a, b) => a.detourM - b.detourM || (a.osmRef < b.osmRef ? -1 : 1));
}

/**
 * Below what geo accepts for one ellipse (400 km), with room for the
 * straight-line cut measuring a touch differently from the sphere.
 */
const STRETCH_M = 350_000;

/**
 * The journey as stretches geo will search, in order, end to end.
 * One stretch for anything up to the limit — which is every transfer
 * between two cities and most days on the road.
 */
export function corridorStretches(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Array<{ from: { lat: number; lon: number }; to: { lat: number; lon: number } }> {
  const count = Math.max(1, Math.ceil(greatCircleMetres(from, to) / STRETCH_M));
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count;
    return { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t };
  });
  return points.slice(1).map((point, i) => ({ from: points[i], to: point }));
}

/**
 * The regions that cover either end and whatever lies between, for a
 * caller that would rather plan with part of a corridor than refuse:
 * a transit leg still happens when only its destination is imported,
 * it just has fewer stops.
 */
export async function regionsCovering(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  detourBudgetM: number,
  roads: RoadCorridor | null = null,
): Promise<string[]> {
  const [fromRegion, toRegion] = await Promise.all([
    pickRegion(from.lat, from.lon),
    pickRegion(to.lat, to.lon),
  ]);
  const ends = [fromRegion?.postgresDb, toRegion?.postgresDb].filter((r): r is string => !!r);
  return await withRegionsAlong(ends, from, to, detourBudgetM, roads);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePoint(
  point: { lat: number; lon: number } | undefined,
  label: string,
): { lat: number; lon: number } {
  if (!point || typeof point !== "object") {
    throw APIError.invalidArgument(`${label} is required`);
  }
  const { lat, lon } = point;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`${label}.lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`${label}.lon out of range: ${lon}`);
  }
  return { lat, lon };
}

function validateBudget(budget: number | undefined): number {
  if (budget === undefined) return DEFAULT_DETOUR_BUDGET_M;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw APIError.invalidArgument("detourBudgetM must be a positive number");
  }
  if (budget > MAX_DETOUR_BUDGET_M) {
    throw APIError.invalidArgument(`detourBudgetM may be at most ${MAX_DETOUR_BUDGET_M} m`);
  }
  return Math.round(budget);
}

/** Same sphere radius PostGIS measures the corridor with. */
const EARTH_RADIUS_M = 6_371_008;

function greatCircleMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
