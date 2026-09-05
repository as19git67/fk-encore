/**
 * The food list you get on the spot (§10.3, stage 2).
 *
 * The concept is unusually explicit about what this must *not* be, and
 * every one of those is a decision this endpoint makes:
 *
 *   - **Not a ranking.** Open data knows that a restaurant exists, not
 *     whether it is any good (§10.1). Sorting by anything but distance
 *     would dress a guess as a judgement, so the order is nearest
 *     first and nothing else.
 *   - **Not a choice made for you.** The planner never picks a venue;
 *     the midday block is time plus an area (§10.3, stage 1). This
 *     endpoint is asked, it does not volunteer.
 *   - **Not an inference from silence.** A missing `diet:vegetarian`
 *     means nobody has tagged it, not "no meat-free food". Filters
 *     therefore keep what is unknown unless the caller says otherwise,
 *     and every attribute is passed through as OSM has it.
 *
 * What it adds over calling the geo search directly is the vocabulary
 * of eating out: the filters are attributes of a meal, and the response
 * carries the ways to reach the place that a map app does not need — a
 * phone number to book a table, a website to check the hours (§9.1).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";

/** Walking distance for a meal, not a search across town. */
const DEFAULT_RADIUS_M = 1_000;
const MAX_RADIUS_M = 5_000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** What §10.3 counts as somewhere to eat: a meal, or a short break. */
const FOOD_CATEGORIES = ["food", "cafe"] as const;

/**
 * OSM diet values that mean "yes, there is something for you". `only`
 * is a stronger yes, `limited` a weaker one — and a weaker yes is still
 * a yes for someone deciding where to eat.
 */
const DIET_AFFIRMATIVE = new Set(["yes", "only", "limited"]);

export interface NearbyFoodRequest {
  /** Where the group is standing. */
  position: { lat: number; lon: number };
  /** Search radius in metres. Defaults to 1 km. */
  radiusM?: number;
  /** Only cafés, or only proper meals. Both by default. */
  categories?: string[];
  /** Keep only places tagged as having vegetarian food. */
  vegetarian?: boolean;
  /** Keep only places tagged as having vegan food. */
  vegan?: boolean;
  /** Keep only places with seating outside. */
  outdoorSeating?: boolean;
  /** Keep only places tagged step-free. */
  wheelchair?: boolean;
  limit?: number;
}

export interface FoodPlace {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  /** Metres as the crow flies. The only thing this list is ordered by. */
  distanceM: number;
  /** The matched OSM tag, e.g. `amenity=restaurant`. */
  kind: string | null;
  categories: string[];
  /**
   * Straight from OSM and unverified. Absent means **unknown**, not
   * "no": the app must not render a missing tag as a red cross (§10.1).
   */
  cuisine: string | null;
  openingHours: string | null;
  dietVegetarian: string | null;
  dietVegan: string | null;
  outdoorSeating: string | null;
  wheelchair: string | null;
  /** Reaching them without a map app (§9.1). */
  phone: string | null;
  website: string | null;
}

export interface NearbyFoodResponse {
  region: string;
  /** Nearest first. Never sorted by anything we cannot know. */
  places: FoodPlace[];
  /** How many the search found before the filters were applied. */
  consideredCount: number;
}

export const nearbyFood = api(
  { expose: true, method: "POST", path: "/trip-planner/food", auth: true },
  async (req: NearbyFoodRequest): Promise<NearbyFoodResponse> => {
    requireUser();
    const position = validatePosition(req.position);
    const radiusM = validateRadius(req.radiusM);
    const limit = validateLimit(req.limit);
    const categories = validateCategories(req.categories);

    const region = await pickRegion(position.lat, position.lon);
    if (!region) {
      throw APIError.failedPrecondition(
        "no imported OSM region covers this location — import it in the region admin first",
      );
    }

    // The geo search already returns nearest first with a centre, which
    // is the whole ordering this list is allowed to have.
    const page = await getGeoClient().searchPois(region.postgresDb, {
      center: { ...position, radiusM },
      categories,
      // Ask for more than the page: the filters below thin the list, and
      // a caller who asked for vegan places should not get three of them
      // because the nearest thirty happened to be steakhouses.
      limit: Math.min(MAX_LIMIT * 4, limit * 4),
    });

    const filtered = page.spots.filter((spot) => matches(spot, req));

    return {
      region: region.postgresDb,
      places: filtered.slice(0, limit).map(toFoodPlace),
      consideredCount: page.spots.length,
    };
  },
);

/**
 * A filter keeps what is unknown out only when the traveller asked for
 * that attribute — and even then, a missing tag excludes rather than
 * admits. That asymmetry is deliberate: "show me vegan places" is a
 * request for places that *say* they are vegan, while an unfiltered
 * list must not quietly drop everything nobody has tagged.
 */
function matches(spot: GeoPoiSearchSpot, req: NearbyFoodRequest): boolean {
  if (req.vegetarian && !DIET_AFFIRMATIVE.has(spot.dietVegetarian ?? "")) return false;
  if (req.vegan && !DIET_AFFIRMATIVE.has(spot.dietVegan ?? "")) return false;
  if (req.outdoorSeating && spot.outdoorSeating !== "yes") return false;
  // `limited` on wheelchair means a step or a narrow door — a real
  // answer for someone deciding, but not what "step-free" was asked for.
  if (req.wheelchair && spot.wheelchair !== "yes") return false;
  return true;
}

function toFoodPlace(spot: GeoPoiSearchSpot): FoodPlace {
  return {
    osmRef: spot.osmRef,
    name: spot.name ?? spot.nameDe ?? spot.nameEn,
    lat: spot.lat,
    lon: spot.lon,
    distanceM: Math.round(spot.distanceM ?? 0),
    kind: spot.kind,
    categories: spot.categories,
    cuisine: spot.cuisine,
    openingHours: spot.openingHours,
    dietVegetarian: spot.dietVegetarian,
    dietVegan: spot.dietVegan,
    outdoorSeating: spot.outdoorSeating,
    wheelchair: spot.wheelchair,
    phone: spot.phone,
    website: spot.website,
  };
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePosition(position: NearbyFoodRequest["position"]): { lat: number; lon: number } {
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

function validateCategories(categories: string[] | undefined): string[] {
  if (categories === undefined) return [...FOOD_CATEGORIES];
  const unknown = categories.filter((c) => !FOOD_CATEGORIES.includes(c as never));
  if (unknown.length > 0) {
    throw APIError.invalidArgument(
      `categories must be a subset of ${FOOD_CATEGORIES.join(", ")} — got ${unknown.join(", ")}`,
    );
  }
  return categories.length > 0 ? categories : [...FOOD_CATEGORIES];
}
