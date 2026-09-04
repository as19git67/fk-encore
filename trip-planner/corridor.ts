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
  /** The region database the candidates came from. */
  region: string;
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

    const region = await resolveRegion(from, to);

    const page = await getGeoClient().searchPois(region, {
      corridor: { from, to, detourBudgetM },
      categories: req.categories,
      limit: CANDIDATE_LIMIT,
    });

    // The detour is what makes a corridor result different from a
    // radius result, so it has to survive scoring — `toCandidates`
    // keys on osmRef, which is stable, so a lookup restores it.
    const detourByRef = new Map(page.spots.map((s) => [s.osmRef, s.detourM ?? 0]));
    const spots = toCandidates(page.spots, {
      interests: req.interests,
      dwellMinutes: req.dwellMinutes,
    }).map((c) => ({ ...c, detourM: Math.round(detourByRef.get(c.osmRef) ?? 0) }));

    return {
      region,
      from,
      to,
      detourBudgetM,
      directDistanceM: Math.round(directDistanceM),
      spots,
    };
  },
);

/**
 * Both ends must sit in the same imported region, because a search runs
 * against one database. Stitching two regions together would mean
 * merging and re-sorting two pages, and would still leave a hole
 * wherever only one of them is imported — better to say plainly which
 * end is not covered than to return half a corridor that looks whole
 * (§15.3).
 */
async function resolveRegion(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<string> {
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
  if (fromRegion.postgresDb !== toRegion.postgresDb) {
    throw APIError.failedPrecondition(
      `the journey crosses region boundaries (${fromRegion.postgresDb} → ${toRegion.postgresDb}) — import a region that covers both ends`,
    );
  }
  return fromRegion.postgresDb;
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
