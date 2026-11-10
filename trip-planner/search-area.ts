/**
 * "In diesem Bereich suchen" (reise-planen-und-unterwegs.md, stage 4):
 * the part of the map somebody is looking at, sent instead of the
 * stay's own reach to the highlights and the name search.
 */

import { APIError } from "encore.dev/api";

export interface SearchArea {
  lat: number;
  lon: number;
  /** From the centre to the edge of what the map shows. */
  radiusM: number;
}

/** Below this a map is a street; the search still looks a little around it. */
export const MIN_AREA_RADIUS_M = 300;
/** A map zoomed out over a whole country asks the region for everything. */
export const MAX_AREA_RADIUS_M = 25_000;

/** The area as the search takes it, or null when none was sent. */
export function parseSearchArea(area: SearchArea | undefined | null): SearchArea | null {
  if (!area) return null;
  const { lat, lon, radiusM } = area;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument("area must have a valid lat and lon");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw APIError.invalidArgument("area.radiusM must be a positive number");
  }
  return { lat, lon, radiusM: Math.round(Math.min(MAX_AREA_RADIUS_M, Math.max(MIN_AREA_RADIUS_M, radiusM))) };
}
