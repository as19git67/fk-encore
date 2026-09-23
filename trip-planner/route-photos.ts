/**
 * Pictures along a way (§4.7).
 *
 * Tour portals show what their users photographed on a walk. The
 * planner has no users taking pictures, but Wikimedia Commons has
 * millions of photographs that say where they were taken, and Wikidata
 * names the best one of many places a way passes. This puts the two
 * together for one way, on the stretch near the leg:
 *
 *   1. geo names the things beside the way that have a Wikidata item,
 *      and hands back a few points along it (`geo/src/route-along.ts`);
 *   2. the items' chosen images come first — a summit's picture is the
 *      best picture of that part of the walk;
 *   3. then photographs taken near the points, which is where pictures
 *      of the way itself come from.
 *
 * Honest about its limits: a well-known way gets a full strip, a
 * nameless forest path often gets nothing — and the app then shows
 * nothing, not an apology (§15.3).
 *
 * Kept for a day per way and stretch: the pictures of a mountain do
 * not change between two people opening the same route, and Wikimedia
 * asks clients not to ask twice.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import log from "encore.dev/log";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoClient } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { loadPlan } from "./plan-store";
import { relationId } from "./route-export";
import {
  type CommonsClient,
  type CommonsPhoto,
  getCommonsClient,
} from "./commons-client";

/** A strip, not a gallery. */
export const MAX_ROUTE_PHOTOS = 12;
/** How far from a point along the way a photograph may have been taken. */
export const NEARBY_RADIUS_M = 300;
/** Per point: a handful, so one busy village does not fill the strip. */
const NEARBY_PER_POINT = 4;
const DEFAULT_RADIUS_M = 20_000;
const MAX_RADIUS_M = 50_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

export interface RoutePhotosRequest {
  planId: number;
  /** As the search answered it: "relation:123". */
  osmRef: string;
  legIndex?: number;
  /** How far around the leg the stretch reaches. Defaults to 20 km. */
  radiusM?: number;
}

/** One picture, with what the licence asks to be said about it. */
export interface RoutePhoto {
  thumbUrl: string;
  thumbWidth: number;
  thumbHeight: number;
  /** The file's page on Commons. */
  pageUrl: string;
  /** What it shows, where that is known — the summit's name. */
  caption: string | null;
  author: string | null;
  license: string | null;
}

export interface RoutePhotosResponse {
  photos: RoutePhoto[];
}

export interface RoutePhotosDeps {
  geo?: GeoClient;
  commons?: CommonsClient;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  photos: RoutePhoto[];
}

const cache = new Map<string, CacheEntry>();

export function clearRoutePhotoCache(): void {
  cache.clear();
}

/**
 * The pictures of one way of one plan.
 *
 * Looked up through the plan, like the export: a plan the caller may
 * see, a leg it has, a region that covers it.
 */
export async function routePhotos(
  userId: number,
  req: RoutePhotosRequest,
  deps: RoutePhotosDeps = {},
): Promise<RoutePhotosResponse> {
  const geo = deps.geo ?? getGeoClient();
  const commons = deps.commons ?? getCommonsClient();
  const now = deps.now ?? Date.now;

  const osmId = relationId(req.osmRef);
  if (osmId === null) throw APIError.invalidArgument(`kein Streckenverweis: ${req.osmRef}`);

  const plan = await loadPlan(req.planId, userId);
  if (!plan) throw APIError.notFound("plan not found");
  const legIndex = req.legIndex ?? 0;
  const leg = plan.legs.find((l) => l.position === legIndex);
  if (!leg) throw APIError.notFound(`leg ${legIndex} not found in this plan`);

  const radiusM = validateRadius(req.radiusM);
  const region = await pickRegion(leg.anchor.lat, leg.anchor.lon);
  if (!region) return { photos: [] };

  // Rounded so two legs a street apart share an entry.
  const key = [
    region.postgresDb,
    osmId,
    radiusM,
    leg.anchor.lat.toFixed(2),
    leg.anchor.lon.toFixed(2),
  ].join("/");
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return { photos: hit.photos };

  let along;
  try {
    along = await geo.routeAlong(region.postgresDb, osmId, {
      center: { lat: leg.anchor.lat, lon: leg.anchor.lon },
      radiusM,
    });
  } catch (err) {
    log.warn("route photos: geo unreachable", { region: region.postgresDb, error: String(err) });
    return { photos: [] };
  }
  if (!along) throw APIError.notFound("diese Strecke ist in der Region nicht mehr vorhanden");

  let photos: RoutePhoto[];
  try {
    photos = await gather(commons, along.subjects, along.samples);
  } catch (err) {
    // No pictures is an answer the screen already handles; a failed
    // screen over a missing strip of photos would not be.
    log.warn("route photos: commons unreachable", { error: String(err) });
    return { photos: [] };
  }

  remember(key, { at: now(), photos });
  return { photos };
}

/** The items' chosen images first, then what was taken along the way. */
async function gather(
  commons: CommonsClient,
  subjects: readonly { wikidata: string; name: string | null }[],
  samples: readonly { lat: number; lon: number }[],
): Promise<RoutePhoto[]> {
  const out: RoutePhoto[] = [];
  const seen = new Set<string>();
  const add = (photo: CommonsPhoto, caption: string | null) => {
    const key = photo.title.replace(/_/g, " ");
    if (seen.has(key) || out.length >= MAX_ROUTE_PHOTOS) return;
    seen.add(key);
    out.push({
      thumbUrl: photo.thumbUrl,
      thumbWidth: photo.thumbWidth,
      thumbHeight: photo.thumbHeight,
      pageUrl: photo.pageUrl,
      caption,
      author: photo.author,
      license: photo.license,
    });
  };

  if (subjects.length > 0) {
    const images = await commons.imagesOf(subjects.map((s) => s.wikidata));
    const titles = subjects
      .map((s) => images.get(s.wikidata))
      .filter((t): t is string => t !== undefined);
    const captionOf = new Map<string, string | null>();
    for (const s of subjects) {
      const title = images.get(s.wikidata);
      if (title && !captionOf.has(norm(title))) captionOf.set(norm(title), s.name);
    }
    for (const photo of await commons.files(titles)) {
      add(photo, captionOf.get(norm(photo.title)) ?? null);
    }
  }

  // All points at once: six requests one after another would be the
  // slowest part of opening the screen.
  const nearby = await Promise.all(
    samples.map((p) => commons.nearby(p, NEARBY_RADIUS_M, NEARBY_PER_POINT)),
  );
  // Round-robin rather than point by point, so the strip walks the way
  // instead of showing four pictures of its first car park.
  for (let round = 0; round < NEARBY_PER_POINT; round += 1) {
    for (const list of nearby) {
      const photo = list[round];
      if (photo) add(photo, null);
    }
  }
  return out;
}

function norm(title: string): string {
  return title.replace(/_/g, " ");
}

function remember(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX) {
    // The oldest insertion goes: Map iterates in insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

function validateRadius(radiusM: number | undefined): number {
  if (radiusM === undefined) return DEFAULT_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("radiusM must be a positive number");
  }
  return Math.min(Math.round(radiusM), MAX_RADIUS_M);
}

export const nearbyRoutePhotos = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/routes/photos", auth: true },
  async (req: RoutePhotosRequest): Promise<RoutePhotosResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("not logged in");
    requirePermission(auth, "photos.view");
    return routePhotos(parseInt(auth.userID, 10), req);
  },
);
