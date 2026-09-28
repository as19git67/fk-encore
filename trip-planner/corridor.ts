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
import { pickRegion } from "../osm-admin/region-router";
import { toCandidates, type ScoredCandidate } from "./candidates";

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

    const regions = await resolveRegions(from, to);
    const spots = await corridorCandidates(regions, from, to, {
      detourBudgetM,
      categories: req.categories,
      interests: req.interests,
      dwellMinutes: req.dwellMinutes,
    });

    return {
      region: regions[0],
      regions,
      from,
      to,
      detourBudgetM,
      directDistanceM: Math.round(directDistanceM),
      spots,
    };
  },
);

/**
 * The regions the corridor is searched in: the start's and, when it is
 * another one, the destination's (§22.7).
 *
 * A search runs against one database, so a journey from one imported
 * region into another is two searches whose results are merged. What
 * neither covers stays a hole — but both *ends* must be covered, or
 * the answer would be half a corridor that looks whole (§15.3).
 */
async function resolveRegions(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
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
  return [...new Set([fromRegion.postgresDb, toRegion.postgresDb])];
}

export interface CorridorSearchOptions {
  detourBudgetM: number;
  categories?: string[];
  interests?: string[];
  dwellMinutes?: Record<string, number>;
  /** Only what is worth a block — for a pool a day is built from. */
  requireProminence?: boolean;
}

/**
 * The scored spots within the detour budget, searched in each region
 * and merged: least detour first, each place once.
 *
 * Shared by the endpoint and by the transit leg (§22.7), whose pool is
 * exactly this — the places worth stopping at on the way.
 */
export async function corridorCandidates(
  regions: readonly string[],
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  opts: CorridorSearchOptions,
): Promise<CorridorSpot[]> {
  const pages = await Promise.all(regions.map((region) =>
    getGeoClient().searchPois(region, {
      corridor: { from, to, detourBudgetM: opts.detourBudgetM },
      categories: opts.categories,
      limit: CANDIDATE_LIMIT,
    })));
  // A place near a border can sit in both extracts; it is one place.
  const byRef = new Map<string, (typeof pages)[number]["spots"][number]>();
  for (const page of pages) {
    for (const spot of page.spots) if (!byRef.has(spot.osmRef)) byRef.set(spot.osmRef, spot);
  }
  const raw = [...byRef.values()];

  // The detour is what makes a corridor result different from a
  // radius result, so it has to survive scoring — `toCandidates` keys
  // on osmRef, which is stable, so a lookup restores it.
  const detourByRef = new Map(raw.map((s) => [s.osmRef, s.detourM ?? 0]));
  return toCandidates(raw, {
    interests: opts.interests,
    dwellMinutes: opts.dwellMinutes,
    requireProminence: opts.requireProminence,
  })
    .map((c) => ({ ...c, detourM: Math.round(detourByRef.get(c.osmRef) ?? 0) }))
    .sort((a, b) => a.detourM - b.detourM || (a.osmRef < b.osmRef ? -1 : 1));
}

/**
 * The regions that cover either end, for a caller that would rather
 * plan with half a corridor than refuse: a transit leg still happens
 * when only its destination is imported, it just has fewer stops.
 */
export async function regionsCovering(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<string[]> {
  const [fromRegion, toRegion] = await Promise.all([
    pickRegion(from.lat, from.lon),
    pickRegion(to.lat, to.lon),
  ]);
  return [...new Set([fromRegion?.postgresDb, toRegion?.postgresDb].filter((r): r is string => !!r))];
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
