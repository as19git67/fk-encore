/**
 * Persisted plans and redistribution — HTTP endpoints.
 *
 * Step 3 of docs/ios-urlaubsplanung.md §13. Step 2 computed a day and
 * threw it away; here a plan is stored so the mechanic the concept
 * calls its core can work on it: "we are here, it is now", the pool,
 * and moving what no longer fits to a following day.
 *
 * The decisions stay in the pure modules (`solver.ts`,
 * `redistribute.ts`); these endpoints only load, call, and save.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { DEFAULT_DAY, shapeDay, type BlockTemplate, type GroupProfile, type Pace } from "./blocks";
import { toCandidates } from "./candidates";
import { redistribute, type CurrentBlock } from "./redistribute";
import { solveDay, type PlannedBlock } from "./solver";
import { DEFAULT_MAX_WALK_MINUTES } from "./travel";
import {
  createPlan,
  loadPlan,
  saveRedistribution,
  type StoredPlan,
} from "./plan-store";

const DEFAULT_SEARCH_RADIUS_M = 2_500;
const MAX_SEARCH_RADIUS_M = 20_000;
const CANDIDATE_LIMIT = 150;
const MAX_DAYS = 14;

export interface CreatePlanRequest {
  title?: string;
  anchor: { lat: number; lon: number };
  /** How many days to plan. One by default. */
  days?: number;
  radiusM?: number;
  categories?: string[];
  interests?: string[];
  pace?: Pace;
  group?: GroupProfile;
  blocks?: BlockTemplate[];
  maxWalkMinutes?: number;
  dwellMinutes?: Record<string, number>;
}

export interface PlanResponse {
  plan: StoredPlan;
}

export const createTripPlan = api(
  { expose: true, method: "POST", path: "/trip-planner/plans", auth: true },
  async (req: CreatePlanRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    const anchor = validateAnchor(req.anchor);
    const radiusM = validateRadius(req.radiusM);
    const dayCount = validateDays(req.days);
    const maxWalkMinutes = validateMaxWalk(req.maxWalkMinutes);

    const region = await pickRegion(anchor.lat, anchor.lon);
    if (!region) {
      throw APIError.failedPrecondition(
        "no imported OSM region covers this location — import it in the region admin first",
      );
    }

    const page = await getGeoClient().searchPois(region.postgresDb, {
      center: { lat: anchor.lat, lon: anchor.lon, radiusM },
      categories: req.categories,
      limit: CANDIDATE_LIMIT,
    });

    const scored = toCandidates(page.spots, {
      interests: req.interests,
      dwellMinutes: req.dwellMinutes,
    });

    // Days are solved one after another out of a shrinking pool, so the
    // same spot is never planned twice across the trip.
    const shape = shapeDay(req.blocks ?? DEFAULT_DAY, req.pace ?? "normal", req.group);
    let available = [...scored];
    const days: PlannedBlock[][] = [];
    for (let i = 0; i < dayCount; i += 1) {
      const solved = solveDay({ anchor, blocks: shape, candidates: available, maxWalkMinutes });
      days.push(solved.blocks);
      const placed = new Set(solved.blocks.flatMap((b) => b.stops.map((s) => s.osmRef)));
      available = available.filter((c) => !placed.has(c.osmRef));
    }

    const planId = await createPlan({
      ownerId: userId,
      title: req.title,
      anchor,
      regionDb: region.postgresDb,
      constraints: {
        radiusM,
        categories: req.categories ?? null,
        interests: req.interests ?? null,
        pace: req.pace ?? "normal",
        group: req.group ?? null,
        maxWalkMinutes,
      },
      days,
      pool: available,
    });

    const plan = await loadPlan(planId, userId);
    if (!plan) throw APIError.internal("plan vanished right after being written");
    return { plan };
  },
);

export const getTripPlan = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId", auth: true },
  async ({ planId }: { planId: number }): Promise<PlanResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    return { plan };
  },
);

export interface RedistributeRequestBody {
  planId: number;
  dayIndex: number;
  /** The block the group is standing in. */
  currentBlockId: string;
  /** Minutes left of that block. */
  remainingMinutes: number;
  position: { lat: number; lon: number };
  /** Stop row ids that have been visited. */
  visited?: number[];
  /** Stop row ids to skip. */
  skipped?: number[];
}

export interface RedistributeResponseBody {
  plan: StoredPlan;
  /** What lost its place — the sentence to show the user (§5). */
  displaced: { osmRef: string; name: string | null }[];
}

export const redistributeDay = api(
  {
    expose: true,
    method: "POST",
    path: "/trip-planner/plans/:planId/redistribute",
    auth: true,
  },
  async (req: RedistributeRequestBody): Promise<RedistributeResponseBody> => {
    const userId = requireUser();
    const position = validateAnchor(req.position);
    if (!Number.isFinite(req.remainingMinutes) || req.remainingMinutes < 0) {
      throw APIError.invalidArgument("remainingMinutes must be zero or positive");
    }

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const day = plan.days.find((d) => d.dayIndex === req.dayIndex);
    if (!day) throw APIError.notFound(`day ${req.dayIndex} not found in this plan`);

    const visited = new Set(req.visited ?? []);
    const skipped = new Set(req.skipped ?? []);
    const blocks: CurrentBlock[] = day.blocks.map((block) => ({
      ...block,
      stops: block.stops.map((stop) => ({
        ...stop,
        status: visited.has(stop.rowId)
          ? ("done" as const)
          : skipped.has(stop.rowId)
            ? ("skipped" as const)
            : stop.status,
      })),
    }));

    const maxWalkMinutes =
      typeof plan.constraints.maxWalkMinutes === "number"
        ? plan.constraints.maxWalkMinutes
        : DEFAULT_MAX_WALK_MINUTES;

    let result;
    try {
      result = redistribute({
        blocks,
        pool: plan.pool,
        position,
        anchor: plan.anchor,
        currentBlockId: req.currentBlockId,
        remainingMinutes: Math.round(req.remainingMinutes),
        maxWalkMinutes,
      });
    } catch (err) {
      throw APIError.invalidArgument((err as Error).message);
    }

    await saveRedistribution(plan.id, day, result.blocks, result.pool);

    const updated = await loadPlan(plan.id, userId);
    if (!updated) throw APIError.internal("plan vanished during redistribution");
    return {
      plan: updated,
      displaced: result.displaced.map((c) => ({ osmRef: c.osmRef, name: c.name })),
    };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validateAnchor(anchor: { lat: number; lon: number }): { lat: number; lon: number } {
  if (!anchor || typeof anchor !== "object") {
    throw APIError.invalidArgument("a coordinate is required");
  }
  const { lat, lon } = anchor;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
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

function validateDays(days: number | undefined): number {
  if (days === undefined) return 1;
  if (!Number.isFinite(days) || days < 1) {
    throw APIError.invalidArgument("days must be at least 1");
  }
  if (days > MAX_DAYS) {
    throw APIError.invalidArgument(`days may be at most ${MAX_DAYS}`);
  }
  return Math.floor(days);
}

function validateMaxWalk(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_MAX_WALK_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw APIError.invalidArgument("maxWalkMinutes must be a positive number");
  }
  return Math.round(minutes);
}
