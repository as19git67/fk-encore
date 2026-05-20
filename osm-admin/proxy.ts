/**
 * Thin HTTP endpoint in front of the geo service's reverse-geocoder.
 *
 * Public callers (the admin UI, future internal services) hit
 * `/osm/reverse`; this handler picks the right per-region Postgres
 * database via `region-router` and forwards the query to the geo
 * container, returning the response under the Nominatim-compatible
 * shape that existing callers consume.
 */

import { APIError, api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "./geo-client";
import { markUsed, pickRegion } from "./region-router";

export interface ReverseGeocodeRequest {
  lat: number;
  lon: number;
  /** Reserved for future use; the geo service currently returns
   *  German/English address parts unconditionally. */
  acceptLanguage?: string;
}

export interface ReverseGeocodeResponse {
  /** Region slug that actually handled the request, for diagnostics. */
  regionSlug: string;
  /** Reverse-geocoded body in Nominatim-compatible shape. */
  result: Record<string, unknown>;
}

/**
 * Reverse-geocode a coordinate via the local geo service's PostGIS
 * database that covers it. Returns a Nominatim-shaped body so existing
 * callers (frontend, photo service) can consume it unchanged.
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

    let result;
    try {
      result = await getGeoClient().reverse(match.postgresDb, req.lat, req.lon);
    } catch (err) {
      throw APIError.unavailable(
        `geo ${match.slug}: ${(err as Error).message ?? String(err)}`,
      );
    }
    await markUsed(match.slug);
    return { regionSlug: match.slug, result: result as Record<string, unknown> };
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
