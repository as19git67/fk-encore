/**
 * Trip planner — HTTP endpoint for a single planned day.
 *
 * Step 2 of docs/ios-urlaubsplanung.md §13: constraints in, blocks with
 * spots out. No language model, no persistence, no frontend — those are
 * later steps. Keeping it stateless here means the whole path is
 * deterministic and can be exercised in tests without a database.
 *
 * Permission: the planner reuses `photos.view`, the same way the feed
 * does — every family member who can see the household's photos may
 * plan a trip. The concept puts no role between contributing and
 * planning either; the organiser role only governs the trip skeleton
 * (§6.2), which this endpoint does not touch.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { DEFAULT_DAY, shapeDay, type BlockTemplate, type GroupProfile, type Pace } from "./blocks";
import { toCandidates, type ScoredCandidate } from "./candidates";
import { solveDay, type PlannedBlock } from "./solver";
import { DEFAULT_MAX_WALK_MINUTES } from "./travel";

/** Radius searched around the anchor when the caller names none. */
const DEFAULT_SEARCH_RADIUS_M = 2_500;
const MAX_SEARCH_RADIUS_M = 20_000;
/** Enough candidates for a day without dragging a whole city over the wire. */
const CANDIDATE_LIMIT = 150;

export interface PlanDayRequest {
  /** Where the day starts and ends — the leg's anchor (§4.2). */
  anchor: { lat: number; lon: number };
  /** Search radius around the anchor. Defaults to 2.5 km. */
  radiusM?: number;
  /** Geo categories to consider. Omitted = all the import carries. */
  categories?: string[];
  /** Categories the travellers care about; raises their score. */
  interests?: string[];
  pace?: Pace;
  group?: GroupProfile;
  /** Override the four-part default day (§4.1). */
  blocks?: BlockTemplate[];
  /** Refuse to propose a single walk longer than this. */
  maxWalkMinutes?: number;
  /** Per-category dwell overrides, in minutes. */
  dwellMinutes?: Record<string, number>;
}

export interface PlanDayResponse {
  /** The region database the candidates came from. */
  region: string;
  anchor: { lat: number; lon: number };
  blocks: PlannedBlock[];
  /** Scored but unplaced candidates — the pool for replanning (§5). */
  pool: ScoredCandidate[];
  /** How many candidates the search returned in total. */
  candidatesConsidered: number;
}

export const planDay = api(
  { expose: true, method: "POST", path: "/trip-planner/day", auth: true },
  async (req: PlanDayRequest): Promise<PlanDayResponse> => {
    requireUser();
    const anchor = validateAnchor(req.anchor);
    const radiusM = validateRadius(req.radiusM);

    const region = await pickRegion(anchor.lat, anchor.lon);
    if (!region) {
      // No imported region means no candidates at all. Say so plainly
      // rather than returning an empty plan that looks like "nothing to
      // see here" (§15.3).
      throw APIError.failedPrecondition(
        "no imported OSM region covers this location — import it in the region admin first",
      );
    }

    const page = await getGeoClient().searchPois(region.postgresDb, {
      center: { lat: anchor.lat, lon: anchor.lon, radiusM },
      categories: req.categories,
      limit: CANDIDATE_LIMIT,
    });

    const candidates = toCandidates(page.spots, {
      interests: req.interests,
      dwellMinutes: req.dwellMinutes,
    });

    const solved = solveDay({
      anchor,
      blocks: shapeDay(req.blocks ?? DEFAULT_DAY, req.pace ?? "normal", req.group),
      candidates,
      maxWalkMinutes: validateMaxWalk(req.maxWalkMinutes),
    });

    // Everything the solver did not place stays available for the pool,
    // with its scoring intact.
    const placed = new Set(solved.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
    const pool = candidates.filter((c) => !placed.has(c.osmRef));

    return {
      region: region.postgresDb,
      anchor,
      blocks: solved.blocks,
      pool,
      candidatesConsidered: candidates.length,
    };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validateAnchor(anchor: PlanDayRequest["anchor"]): { lat: number; lon: number } {
  if (!anchor || typeof anchor !== "object") {
    throw APIError.invalidArgument("anchor is required");
  }
  const { lat, lon } = anchor;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`anchor.lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`anchor.lon out of range: ${lon}`);
  }
  return { lat, lon };
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_SEARCH_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  if (radiusM > MAX_SEARCH_RADIUS_M) {
    throw APIError.invalidArgument(`radiusM may be at most ${MAX_SEARCH_RADIUS_M} m`);
  }
  return Math.round(radiusM);
}

function validateMaxWalk(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_MAX_WALK_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw APIError.invalidArgument("maxWalkMinutes must be a positive number");
  }
  return Math.round(minutes);
}
