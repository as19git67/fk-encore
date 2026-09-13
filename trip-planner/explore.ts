/**
 * Looking around a place, with no trip behind it (§9.2, §20).
 *
 * Everything that searches the region databases today hangs off a
 * plan: `POST /plans/:planId/search` takes its centre from the leg's
 * anchor and its radius from the leg. That was never a data
 * requirement — a region is imported in the region admin, not by
 * creating a trip, and `planDay` says so itself when none covers a
 * coordinate. The trip supplied two numbers, and two numbers can come
 * from somewhere else.
 *
 * They come from the phone: either where it is standing, or a place
 * somebody named and picked out of Apple's geocoder. The coordinate
 * routes to a region (`pickRegion`), the region answers, and what is
 * found goes into the **idea pool** — which has needed no trip since it
 * existed (`addIdea` takes a coordinate and an owner, and no plan).
 *
 * That closes a loop that was only ever half built: things could be
 * collected months before a trip, but only by being shared in from
 * elsewhere. Now they can be looked for.
 *
 * Two things it refuses to do.
 *
 * It does not **import** a region. A missing one is said out loud and
 * left alone: an import is a background job measured in minutes to
 * hours (§13.0), and a search that silently starts one would answer a
 * tap with a wait nobody agreed to.
 *
 * It does not **hide what you have**. An entry already in the
 * collection is marked, exactly as the plan search marks what is
 * already in the pool: "das habt ihr schon" is an answer, a quietly
 * shorter list is not.
 */

import { api, APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { toCandidates } from "./candidates";
import { requireAccess } from "./ideas";
import { haversineMeters } from "./travel";
import { emptinessNote, keepsInterest, orderForBrowsing } from "./explore-filter";

/** Wide enough for "die Gegend", narrow enough to mean something. */
const DEFAULT_RADIUS_M = 5_000;
const MAX_RADIUS_M = 30_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
/**
 * How much the region search hands over before filtering.
 *
 * Interests are matched here rather than pushed into the query (see
 * `explore-filter.ts`), so the page has to be wide enough that a narrow
 * interest still finds its handful in it.
 */
const SEARCH_LIMIT = 200;
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 120;

export interface ExploreRequest {
  /** Where to look — from the phone, or from a place somebody picked. */
  position: { lat: number; lon: number };
  radiusM?: number;
  /**
   * A name filter, when somebody does know what they are looking for.
   * Omitted is the point of this endpoint: browsing, not searching.
   */
  query?: string;
  /** Interest ids from `GET /trip-planner/interests`. */
  interests?: string[];
  limit?: number;
  /**
   * Which collection to mark against. Your own unless a shared one is
   * named — and a collection you were never let into is not found
   * rather than refused.
   */
  ownerId?: number;
}

export interface ExploredSpot {
  osmRef: string;
  name: string | null;
  /** The name on the sign, when that is not the readable one (§10.4). */
  localName: string | null;
  lat: number;
  lon: number;
  /** Metres as the crow flies from where the search was centred. */
  distanceM: number;
  category: string;
  /** What the planner would allow for it, from its category. */
  dwellMinutes: number;
  /** Straight from OSM and unverified — absent means unknown, not "no". */
  openingHours: string | null;
  website: string | null;
  wikipediaUrl: string | null;
  /** Why it ranks where it does — the same "Warum hier?" the plan shows. */
  reasons: string[];
  /** Already in the collection this was marked against. */
  collected: boolean;
}

export interface ExploreResponse {
  /** The region database that answered, for the record. */
  region: string | null;
  /** No imported region covers this coordinate. Not an error (see above). */
  regionMissing: boolean;
  spots: ExploredSpot[];
  /** True when more matched than were returned. */
  hasMore: boolean;
  /**
   * Why the list is empty, when it is. Null when there is something to
   * look at — an empty list with no word about it is the failure this
   * whole screen exists to avoid.
   */
  note: string | null;
}

export const exploreArea = api(
  { expose: true, method: "POST", path: "/trip-planner/explore", auth: true },
  async (req: ExploreRequest): Promise<ExploreResponse> => {
    const userId = requireUser();
    const position = validatePosition(req.position);
    const radiusM = validateRadius(req.radiusM);
    const limit = validateLimit(req.limit);
    const query = validateQuery(req.query);
    const interests = (req.interests ?? []).filter((id) => typeof id === "string" && id !== "");
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);

    const region = await pickRegion(position.lat, position.lon);
    if (!region) {
      return {
        region: null,
        regionMissing: true,
        spots: [],
        hasMore: false,
        note: emptinessNote({ regionMissing: true, found: 0, kept: 0, filtered: false }),
      };
    }

    let page;
    try {
      page = await getGeoClient().searchPois(region.postgresDb, {
        center: { ...position, radiusM },
        name: query ?? undefined,
        // What the area is known for, not what happens to be nearest —
        // a page cut by distance and then ranked by prominence keeps
        // neither (see `GeoPoiSearchQuery.rank`).
        rank: "prominence",
        limit: SEARCH_LIMIT,
      });
    } catch {
      throw APIError.unavailable("die Region antwortet gerade nicht");
    }

    const collected = await collectedRefs(ownerId);
    // The facts the scoring drops on the way: `toCandidates` keeps what
    // ranking needs, and an opening time is not that — but it is the
    // first thing anybody asks of a list they might act on today.
    const bySpot = new Map(page.spots.map((spot) => [spot.osmRef, spot]));
    const candidates = toCandidates(page.spots, { interests });
    const matching = candidates.filter((candidate) =>
      keepsInterest({ kind: candidate.kind, category: candidate.category }, interests));

    const ordered = orderForBrowsing(matching.map((candidate) => ({
      ...candidate,
      distanceM: Math.round(haversineMeters(position, candidate)),
    })));

    const spots: ExploredSpot[] = ordered.slice(0, limit).map((candidate) => ({
      osmRef: candidate.osmRef,
      name: candidate.name,
      localName: candidate.localName ?? null,
      lat: candidate.lat,
      lon: candidate.lon,
      distanceM: candidate.distanceM,
      category: candidate.category,
      dwellMinutes: candidate.dwellMinutes,
      openingHours: bySpot.get(candidate.osmRef)?.openingHours ?? null,
      website: bySpot.get(candidate.osmRef)?.website ?? null,
      wikipediaUrl: candidate.wikipediaUrl ?? null,
      reasons: candidate.reasons,
      collected: collected.has(candidate.osmRef),
    }));

    return {
      region: region.postgresDb,
      regionMissing: false,
      spots,
      // Either the region had more than one page of them, or the
      // filter left more than fits — both mean "narrow it down".
      hasMore: page.hasMore || ordered.length > limit,
      note: emptinessNote({
        regionMissing: false,
        found: page.spots.length,
        kept: ordered.length,
        filtered: interests.length > 0 || query !== null,
      }),
    };
  },
);

/**
 * What is already in that collection, by OSM reference.
 *
 * By reference and not by distance: an entry that matched an OSM spot
 * carries its ref, and one that matched nothing carries a manual ref no
 * region search can produce. A "you have this already" mark that fired
 * on proximity would claim the museum for the bench outside it.
 */
async function collectedRefs(ownerId: number): Promise<Set<string>> {
  const rows = await db
    .select({ osmRef: ideaPool.osm_ref })
    .from(ideaPool)
    .where(eq(ideaPool.owner_id, ownerId));
  return new Set(rows.map((row) => row.osmRef));
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePosition(position: ExploreRequest["position"]): { lat: number; lon: number } {
  if (!position || typeof position !== "object") {
    throw APIError.invalidArgument("position is required");
  }
  const { lat, lon } = position;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument("lat must be between -90 and 90");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument("lon must be between -180 and 180");
  }
  return { lat, lon };
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be positive");
  }
  return Math.min(Math.round(radiusM), MAX_RADIUS_M);
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw APIError.invalidArgument("limit must be positive");
  }
  return Math.min(Math.round(limit), MAX_LIMIT);
}

/**
 * The name filter, or null for a browse.
 *
 * One character is not a search, it is half the region — the same floor
 * `search.ts` sets. Nothing typed at all is the ordinary case here and
 * means "everything".
 */
function validateQuery(query: string | undefined): string | null {
  if (query === undefined) return null;
  const trimmed = query.trim();
  if (trimmed === "") return null;
  if (trimmed.length < MIN_QUERY_CHARS) {
    throw APIError.invalidArgument(`bitte mindestens ${MIN_QUERY_CHARS} Zeichen suchen`);
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw APIError.invalidArgument(`die Suche ist auf ${MAX_QUERY_CHARS} Zeichen begrenzt`);
  }
  return trimmed;
}
