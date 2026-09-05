/**
 * "Was ist hier in der Nähe?" — spontaneous, without a plan (§7.1).
 *
 * The point of this endpoint is what it draws on: **the same pool**.
 * The travellers already told the planner what they like, and the leg
 * already searched its region for it — asking a fresh, unfiltered
 * question here would hand back a different kind of answer than the
 * plan gives, and the two would quietly disagree about what is worth
 * seeing.
 *
 * So the pool comes first, ordered by distance from where the group is
 * standing, and the region search only fills in behind it. The result
 * says which is which, because "you had this on your list" is a
 * different sentence from "there is also this".
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan } from "./plan-store";
import { toCandidates } from "./candidates";
import { haversineMeters } from "./travel";

/** Walking distance from where you stand, not a search across town. */
const DEFAULT_RADIUS_M = 1_500;
const MAX_RADIUS_M = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SEARCH_LIMIT = 150;

export interface NearbyRequest {
  /** Where the group is standing. */
  position: { lat: number; lon: number };
  /**
   * The plan whose pool to draw on. Omit for a search with no plan
   * behind it — then everything comes back as `discovered`.
   */
  planId?: number;
  /** Which leg's pool. The first by default. */
  legIndex?: number;
  radiusM?: number;
  categories?: string[];
  limit?: number;
}

export interface NearbySpot {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  /** Metres as the crow flies from where the group is standing. */
  distanceM: number;
  category: string;
  dwellMinutes: number;
  /** Why it scored as it did — the same "Warum hier?" the plan shows. */
  reasons: string[];
  /**
   * True when this came from the leg's pool: something the travellers
   * already have on their list. False for a spot the region search
   * turned up now.
   */
  fromPool: boolean;
  /**
   * True when it is already planned into a day. Shown rather than
   * hidden: "das steht schon für Donnerstag" is useful to know while
   * standing in front of it.
   */
  alreadyPlanned: boolean;
}

export interface NearbyResponse {
  region: string | null;
  spots: NearbySpot[];
}

export const nearbySpots = api(
  { expose: true, method: "POST", path: "/trip-planner/nearby", auth: true },
  async (req: NearbyRequest): Promise<NearbyResponse> => {
    const userId = requireUser();
    const position = validatePosition(req.position);
    const radiusM = validateRadius(req.radiusM);
    const limit = validateLimit(req.limit);

    const seen = new Set<string>();
    const spots: NearbySpot[] = [];

    // The pool first: what the travellers already said they liked.
    if (req.planId !== undefined) {
      const plan = await loadPlan(req.planId, userId);
      if (!plan) throw APIError.notFound("plan not found");

      const legIndex = req.legIndex ?? 0;
      const leg = plan.legs.find((l) => l.position === legIndex);
      if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

      const planned = new Set(
        leg.days.flatMap((d) => d.blocks.flatMap((b) => b.stops.map((s) => s.osmRef))),
      );
      // A planned stop is also nearby-worthy, so both sources are
      // considered — the pool holds only what was *not* placed.
      const fromPlan = leg.days
        .flatMap((d) => d.blocks.flatMap((b) => b.stops))
        .map((s) => ({
          osmRef: s.osmRef,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          category: s.category,
          dwellMinutes: s.dwellMinutes,
          reasons: [] as string[],
        }));

      for (const candidate of [...leg.pool, ...fromPlan]) {
        const distanceM = Math.round(haversineMeters(position, candidate));
        if (distanceM > radiusM) continue;
        if (req.categories?.length && !req.categories.includes(candidate.category)) continue;
        if (seen.has(candidate.osmRef)) continue;
        seen.add(candidate.osmRef);
        spots.push({
          osmRef: candidate.osmRef,
          name: candidate.name,
          lat: candidate.lat,
          lon: candidate.lon,
          distanceM,
          category: candidate.category,
          dwellMinutes: candidate.dwellMinutes,
          reasons: candidate.reasons ?? [],
          fromPool: true,
          alreadyPlanned: planned.has(candidate.osmRef),
        });
      }
    }

    // Then whatever else is here. Only if there is room, so a full list
    // of things they already wanted is not diluted by a full list of
    // things they did not.
    const region = await pickRegion(position.lat, position.lon);
    if (region && spots.length < limit) {
      const page = await getGeoClient().searchPois(region.postgresDb, {
        center: { ...position, radiusM },
        categories: req.categories,
        limit: SEARCH_LIMIT,
      });
      // geo filters by radius and category too, but the guarantee is
      // made here as well — the pool branch above filters explicitly,
      // and a list where half the entries are checked and half are
      // taken on trust is one geo change away from being wrong.
      //
      // The category test is on the spot's whole list, not on the one
      // `toCandidates` picks: a place can satisfy "sight" and "museum"
      // at once, and filtering on the chosen one would drop it.
      const wanted = req.categories?.length ? new Set(req.categories) : null;
      const inRange = page.spots.filter(
        (spot) =>
          haversineMeters(position, spot) <= radiusM &&
          (!wanted || spot.categories.some((c) => wanted.has(c))),
      );

      for (const candidate of toCandidates(inRange)) {
        if (seen.has(candidate.osmRef)) continue;
        seen.add(candidate.osmRef);
        spots.push({
          osmRef: candidate.osmRef,
          name: candidate.name,
          lat: candidate.lat,
          lon: candidate.lon,
          distanceM: Math.round(haversineMeters(position, candidate)),
          category: candidate.category,
          dwellMinutes: candidate.dwellMinutes,
          reasons: candidate.reasons,
          fromPool: false,
          alreadyPlanned: false,
        });
      }
    }

    // Nearest first within each group, and the pool ahead of the rest:
    // "you had this on your list" outranks "there is also this",
    // however many metres separate them.
    spots.sort((a, b) => {
      if (a.fromPool !== b.fromPool) return a.fromPool ? -1 : 1;
      return a.distanceM - b.distanceM;
    });

    return { region: region?.postgresDb ?? null, spots: spots.slice(0, limit) };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePosition(position: NearbyRequest["position"]): { lat: number; lon: number } {
  if (!position || typeof position !== "object") {
    throw APIError.invalidArgument("position is required");
  }
  const { lat, lon } = position;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`position.lat out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`position.lon out of range: ${lon}`);
  }
  return { lat, lon };
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  if (radiusM > MAX_RADIUS_M) {
    throw APIError.invalidArgument(`radiusM may be at most ${MAX_RADIUS_M} m`);
  }
  return Math.round(radiusM);
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw APIError.invalidArgument("limit must be a positive number");
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}
