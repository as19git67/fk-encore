/**
 * Searching for a place by name, inside the app (§9.2, case 4).
 *
 * The simplest of the four ways into the pool, and the concept is
 * explicit that it **must exist independently of everything else**:
 * no share sheet, no map app, no language model, no article. You know
 * what the place is called, you type it, you put it in the pool.
 *
 * That independence is worth stating because everything else in §9.2
 * has a way to fail that is not the user's fault. A shared link can be
 * in a format that changed last week; an article needs a model that may
 * be cold; a screenshot needs OCR. This needs a database that is
 * already there for planning anyway.
 *
 * It is a **list**, not a resolution. `resolve-place.ts` answers "which
 * one place did this article mean", and asks when it cannot tell; here
 * the whole point is to show what matches and let a person pick. The
 * two share the name filter and nothing else.
 *
 * Spots already in the plan are **marked, not hidden** — the same rule
 * `nearby.ts` follows. "Das habt ihr schon" is a useful answer to a
 * search; a silently shorter list is not.
 */

import { displayName } from "./readable-name";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { loadPlan, type StoredLeg } from "./plan-store";
import { RESOLUTION_RADIUS_M } from "./place-lookup";
import { DEFAULT_DWELL_MINUTES } from "./candidates";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Below this a query matches half the city and helps nobody. */
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 120;

export interface SearchPlacesRequest {
  planId: number;
  /** What the traveller typed. */
  query: string;
  /**
   * Which leg to search around. All of them by default — you look
   * things up for the trip, not for the screen you happen to be on.
   */
  legIndex?: number;
  categories?: string[];
  limit?: number;
}

export interface SearchedPlace {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  /** From the leg's anchor, so "how far out of the way is this". */
  distanceM: number | null;
  categories: string[];
  /** Which leg it turned up in. */
  legIndex: number;
  /** Straight from OSM and unverified — absent means unknown, not "no". */
  openingHours: string | null;
  phone: string | null;
  website: string | null;
  /** What the planner would allow for it, from its category. */
  dwellMinutes: number | null;
  /** Already a candidate for this leg. */
  inPool: boolean;
  /** Already planned into a day of it. */
  planned: boolean;
}

export interface SearchPlacesResponse {
  results: SearchedPlace[];
  /** True when more matched than were returned. */
  hasMore: boolean;
  /**
   * Legs whose region could not be searched. Named rather than silently
   * missing: "nothing found" and "one region was unreachable" are
   * different answers and the traveller should not have to guess which
   * they got.
   */
  unavailableLegs: number[];
}

export const searchPlaces = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/search", auth: true },
  async (req: SearchPlacesRequest): Promise<SearchPlacesResponse> => {
    const userId = requireUser();
    const query = typeof req.query === "string" ? req.query.trim() : "";
    if (query.length < MIN_QUERY_CHARS) {
      throw APIError.invalidArgument(`bitte mindestens ${MIN_QUERY_CHARS} Zeichen suchen`);
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw APIError.invalidArgument(`die Suche ist auf ${MAX_QUERY_CHARS} Zeichen begrenzt`);
    }
    const limit = clampLimit(req.limit);

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const legs = req.legIndex === undefined
      ? plan.legs
      : plan.legs.filter((leg) => leg.position === req.legIndex);
    if (legs.length === 0) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);

    const results: SearchedPlace[] = [];
    const unavailableLegs: number[] = [];
    let hasMore = false;

    for (const leg of legs) {
      let spots: GeoPoiSearchSpot[];
      let more = false;
      try {
        const page = await getGeoClient().searchPois(leg.regionDb, {
          center: { ...leg.anchor, radiusM: RESOLUTION_RADIUS_M },
          name: query,
          categories: req.categories?.length ? req.categories : undefined,
          // One over, so "there are more" is known without a second
          // query — the same trick the area search itself uses.
          limit: limit + 1,
        });
        spots = page.spots;
        more = page.hasMore;
      } catch {
        // One region being down must not lose the others, and must not
        // look like "nothing here either".
        unavailableLegs.push(leg.position);
        continue;
      }

      if (spots.length > limit) {
        more = true;
        spots = spots.slice(0, limit);
      }
      hasMore = hasMore || more;

      const inPool = new Set(leg.pool.map((c) => c.osmRef));
      const planned = plannedRefs(leg);
      for (const spot of spots) {
        results.push({
          osmRef: spot.osmRef,
          name: displayName(spot),
          lat: spot.lat,
          lon: spot.lon,
          distanceM: spot.distanceM,
          categories: spot.categories,
          legIndex: leg.position,
          openingHours: spot.openingHours,
          phone: spot.phone,
          website: spot.website,
          dwellMinutes: dwellFor(spot.categories),
          inPool: inPool.has(spot.osmRef),
          planned: planned.has(spot.osmRef),
        });
      }
    }

    // Nearest first across legs. Distance is measured from each leg's
    // own anchor, so this is "how far out of your way" rather than a
    // distance between two comparable points — which is the question a
    // traveller is actually asking.
    results.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    // Several legs can each return a full page, so the union may exceed
    // the limit even when no single region had more to give.
    const truncated = results.length > limit;
    return { results: results.slice(0, limit), hasMore: hasMore || truncated, unavailableLegs };
  },
);

function plannedRefs(leg: StoredLeg): Set<string> {
  const refs = new Set<string>();
  for (const day of leg.days) {
    for (const block of day.blocks) {
      for (const stop of block.stops) refs.add(stop.osmRef);
    }
  }
  return refs;
}

/**
 * What the planner would allow for a place of this kind.
 *
 * Null when no category has a default: the search says so rather than
 * offering a number, and the traveller supplies one when adding
 * (§9.2's one permitted question).
 */
function dwellFor(categories: readonly string[]): number | null {
  for (const category of categories) {
    const minutes = DEFAULT_DWELL_MINUTES[category];
    if (minutes !== undefined) return minutes;
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw APIError.invalidArgument("limit must be a positive number");
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
