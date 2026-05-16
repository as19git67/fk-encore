/**
 * Thin HTTP proxy endpoints in front of the per-region Nominatim and
 * Overpass containers.
 *
 * Callers (the photo POI worker, the admin UI) only know about
 * `osm-admin`. Internally each request is routed to the right
 * `nominatim-<slug>` / `overpass-<slug>` instance via
 * `region-router.ts`, the container is started if it was sitting in
 * `ready_stopped`, the response is forwarded back, and the region's
 * `last_used_at` is bumped so the idle-stop sweeper (next slice) knows
 * the region is hot.
 *
 * Forwarding uses node `fetch` against the container's Docker-DNS
 * hostname — no port juggling. Both endpoints are guarded by
 * `osm.admin` for now; they'll be opened up (or made internal) once
 * the photo POI worker is in place.
 */

import { APIError, api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { ensureReady, markUsed, pickRegion } from "./region-router";

export interface ReverseGeocodeRequest {
  lat: number;
  lon: number;
  /** Comma-separated language preference, defaults to "de,en". */
  acceptLanguage?: string;
}

export interface ReverseGeocodeResponse {
  /** Region slug that actually handled the request, for diagnostics. */
  regionSlug: string;
  /** Raw Nominatim response body forwarded back to the caller. */
  result: Record<string, unknown>;
}

/**
 * Reverse-geocode a coordinate via the local Nominatim shard that
 * covers it. Returns Nominatim's JSON response untouched so the caller
 * can pick whichever fields it needs.
 */
export const reverseGeocode = api(
  { expose: true, auth: true, method: "POST", path: "/osm/reverse" },
  async (req: ReverseGeocodeRequest): Promise<ReverseGeocodeResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    validateLatLon(req.lat, req.lon);
    const match = await pickRegion(req.lat, req.lon);
    if (!match) {
      throw APIError.failedPrecondition(
        `no ready region covers (${req.lat}, ${req.lon}); import a region first`,
      );
    }
    if (match.status === "ready_stopped") await ensureReady(match.slug);

    const url = new URL(`http://${match.nominatimHost}:8080/reverse`);
    url.searchParams.set("lat", String(req.lat));
    url.searchParams.set("lon", String(req.lon));
    url.searchParams.set("format", "json");
    url.searchParams.set(
      "accept-language",
      req.acceptLanguage ?? "de,en",
    );
    const res = await fetch(url, {
      headers: { "User-Agent": "fk-encore-osm-admin/1.0" },
    });
    if (!res.ok) {
      throw APIError.unavailable(
        `nominatim ${match.slug}: HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as Record<string, unknown>;
    await markUsed(match.slug);
    return { regionSlug: match.slug, result: body };
  },
);

export interface OverpassQueryRequest {
  /** Pivot coordinate used to pick the right region shard. */
  lat: number;
  lon: number;
  /** OQL body, e.g. `[out:json];node[tourism=attraction](around:200,…);out;` */
  query: string;
}

export interface OverpassQueryResponse {
  regionSlug: string;
  result: Record<string, unknown>;
}

/**
 * Forward an Overpass OQL query to the regional shard that covers
 * `(lat, lon)`. The OQL body is passed through verbatim — callers are
 * expected to build it (POI Tag whitelist, around-radius, etc).
 */
export const overpassQuery = api(
  { expose: true, auth: true, method: "POST", path: "/osm/overpass" },
  async (req: OverpassQueryRequest): Promise<OverpassQueryResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    validateLatLon(req.lat, req.lon);
    if (!req.query || typeof req.query !== "string") {
      throw APIError.invalidArgument("query is required");
    }
    const match = await pickRegion(req.lat, req.lon);
    if (!match) {
      throw APIError.failedPrecondition(
        `no ready region covers (${req.lat}, ${req.lon}); import a region first`,
      );
    }
    if (match.status === "ready_stopped") await ensureReady(match.slug);

    const url = `http://${match.overpassHost}/api/interpreter`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "fk-encore-osm-admin/1.0",
      },
      body: req.query,
    });
    if (!res.ok) {
      throw APIError.unavailable(
        `overpass ${match.slug}: HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as Record<string, unknown>;
    await markUsed(match.slug);
    return { regionSlug: match.slug, result: body };
  },
);

function validateLatLon(lat: number, lon: number): void {
  if (typeof lat !== "number" || Number.isNaN(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (typeof lon !== "number" || Number.isNaN(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
}
