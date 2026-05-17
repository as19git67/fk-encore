/**
 * Bulk region-suggest for the existing photo library.
 *
 * Scans every photo with a GPS fix, maps each coordinate to its
 * smallest Geofabrik region, aggregates by region, and merges the
 * current `osm_region_imports` state into the result. The admin UI
 * uses this to show a single "import these regions and the rest of
 * the library is covered" list.
 *
 * Lookups are cached by Geohash-5 (~5 km cell) so 60 000 photos
 * typically resolve into a few thousand unique lookups against the
 * in-memory Geofabrik index — well under a second on a warm cache.
 */

import { inArray, isNotNull } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports, photos } from "../db/schema";
import {
  loadGeofabrikIndex,
  pickSmallestMatchingRegion,
  type GeofabrikIndex,
  type GeofabrikRegion,
  type LoadOptions,
} from "./geofabrik-index";
import { geohash7 } from "./region-router";
import { isRegionStatus, type RegionStatus } from "./state-machine";

/** Geohash precision used for the lookup cache. 5 ≈ 5 km × 5 km cells. */
const CACHE_GEOHASH_PRECISION = 5;

export interface BulkRegionSuggestion {
  slug: string;
  name: string;
  parent: string | null;
  pbfUrl: string;
  bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
  /** How many photos in the library fall inside this region. */
  photoCount: number;
  /** True when the region is already tracked in `osm_region_imports`. */
  existing: boolean;
  existingStatus: RegionStatus | null;
}

export interface BulkSuggestResult {
  /** Total photos with a GPS fix that participated in the analysis. */
  geotaggedPhotoCount: number;
  /** Photos whose GPS lies outside every Geofabrik polygon (oceans, …). */
  unmappedPhotoCount: number;
  /** Suggestions sorted by photoCount descending. */
  suggestions: BulkRegionSuggestion[];
}

export interface BulkSuggestDeps {
  db?: typeof dbDefault;
  loadIndex?: (opts?: LoadOptions) => Promise<GeofabrikIndex>;
}

export async function suggestRegionsFromPhotos(
  deps: BulkSuggestDeps = {},
): Promise<BulkSuggestResult> {
  const db = deps.db ?? dbDefault;
  const load = deps.loadIndex ?? loadGeofabrikIndex;

  const rows = await db
    .select({ latitude: photos.latitude, longitude: photos.longitude })
    .from(photos)
    .where(isNotNull(photos.latitude));

  if (rows.length === 0) {
    return { geotaggedPhotoCount: 0, unmappedPhotoCount: 0, suggestions: [] };
  }

  const index = await load();
  /** geohash cell → resolved region (or null = explicit "no match") */
  const cellCache = new Map<string, GeofabrikRegion | null>();
  /** region slug → accumulated count */
  const counts = new Map<string, { region: GeofabrikRegion; count: number }>();

  let unmapped = 0;

  for (const r of rows) {
    if (r.latitude === null || r.longitude === null) continue;
    const cell = geohash7(r.latitude, r.longitude, CACHE_GEOHASH_PRECISION);
    let region: GeofabrikRegion | null;
    if (cellCache.has(cell)) {
      region = cellCache.get(cell)!;
    } else {
      region = pickSmallestMatchingRegion(index, r.latitude, r.longitude);
      cellCache.set(cell, region);
    }
    if (!region) {
      unmapped++;
      continue;
    }
    const slot = counts.get(region.id);
    if (slot) {
      slot.count++;
    } else {
      counts.set(region.id, { region, count: 1 });
    }
  }

  // Merge in the existing osm_region_imports rows so the UI can show
  // which regions are already tracked (and skip the "Anlegen" button).
  const slugs = [...counts.keys()];
  const existingRows = slugs.length === 0
    ? []
    : await db
        .select({ slug: osmRegionImports.slug, status: osmRegionImports.status })
        .from(osmRegionImports)
        .where(inArray(osmRegionImports.slug, slugs));
  const existingBySlug = new Map(existingRows.map((e) => [e.slug, e.status]));

  const suggestions: BulkRegionSuggestion[] = [...counts.values()]
    .map(({ region, count }) => {
      const status = existingBySlug.get(region.id);
      const existing = status !== undefined;
      const existingStatus =
        status !== undefined && isRegionStatus(status) ? status : null;
      return {
        slug: region.id,
        name: region.name,
        parent: region.parent,
        pbfUrl: region.pbfUrl,
        bbox: {
          minLon: region.bbox[0],
          minLat: region.bbox[1],
          maxLon: region.bbox[2],
          maxLat: region.bbox[3],
        },
        photoCount: count,
        existing,
        existingStatus,
      };
    })
    .sort((a, b) => b.photoCount - a.photoCount);

  return {
    geotaggedPhotoCount: rows.length,
    unmappedPhotoCount: unmapped,
    suggestions,
  };
}

