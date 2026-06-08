/**
 * Bulk region-suggest for the existing photo library.
 *
 * Scans every photo with a GPS fix, maps each coordinate to its
 * smallest Geofabrik region, aggregates by region, and merges the
 * current `osm_region_imports` state into the result. The admin UI
 * uses this to show a single "import these regions and the rest of
 * the library is covered" list.
 *
 * Coverage-aware: a photo that already falls inside a tracked region
 * (in any non-failed state) is attributed to that existing region
 * instead of generating a new, finer suggestion. This stops the list
 * from proposing redundant sub-regions whose data is already on disk —
 * e.g. once "europe" or "…/bayern" is imported, the photos beneath it
 * no longer surface "…/bayern/schwaben" as a separate import.
 *
 * Lookups are cached by Geohash-5 (~5 km cell) so 60 000 photos
 * typically resolve into a few thousand unique lookups against the
 * in-memory Geofabrik index — well under a second on a warm cache.
 */

import { isNotNull } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports, photos } from "../db/schema";
import {
  findContainingRegions,
  loadGeofabrikIndex,
  pickSmallestRegion,
  type GeofabrikIndex,
  type GeofabrikRegion,
  type LoadOptions,
} from "./geofabrik-index";
import { geohash7 } from "./region-router";
import { isRegionStatus, type RegionStatus } from "./state-machine";

/** Geohash precision used for the lookup cache. 5 ≈ 5 km × 5 km cells. */
const CACHE_GEOHASH_PRECISION = 5;

/**
 * Tracked-region statuses that count as "covering" a coordinate: the
 * region's data is on disk or on its way there. `failed` and
 * `blocked_disk` are excluded — those regions provide no coverage, so
 * photos beneath them should still produce a (re-)import suggestion.
 */
const COVERING_STATUSES: readonly RegionStatus[] = [
  "pending_approval",
  "importing",
  "ready_running",
  "ready_stopped",
];

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
  /**
   * True when this entry only exists because its photos are already
   * covered by this (tracked, non-failed) region — i.e. no new import
   * is needed. New regions worth importing have `coveredByExisting:
   * false` and `existing: false`.
   */
  coveredByExisting: boolean;
}

/**
 * A tracked region whose entire photo footprint is already served by
 * smaller imported sub-regions — no POI data from this region is
 * exclusively needed.
 *
 * Whether deleting it actually saves disk depends on the PBF sizes:
 * keeping one larger extract can be cheaper than several overlapping
 * sub-regions. `recommendation` weighs that:
 *   - "delete_parent": the sub-regions together are ≤ the parent, so
 *     dropping the parent frees space.
 *   - "keep_parent": the sub-regions together cost MORE than the parent
 *     — the single larger extract is the space-efficient choice, so
 *     keep it (and consider dropping the redundant sub-regions instead).
 *   - "unknown": at least one PBF size is missing, no verdict possible.
 */
export interface RedundantRegion {
  slug: string;
  status: RegionStatus;
  /** Tracked child-region slugs that collectively cover this region's photos. */
  coveringChildren: string[];
  /** PBF download size of the larger (redundant) region in MB, if known. */
  parentSizeMb: number | null;
  /** Summed PBF size of the covering sub-regions in MB, if all are known. */
  childrenSizeMb: number | null;
  /** Disk-aware verdict; see interface docs. */
  recommendation: "delete_parent" | "keep_parent" | "unknown";
}

export interface BulkSuggestResult {
  /** Total photos with a GPS fix that participated in the analysis. */
  geotaggedPhotoCount: number;
  /** Photos whose GPS lies outside every Geofabrik polygon (oceans, …). */
  unmappedPhotoCount: number;
  /** Photos already covered by an existing (non-failed) tracked region. */
  coveredPhotoCount: number;
  /** Suggestions sorted by photoCount descending. */
  suggestions: BulkRegionSuggestion[];
  /**
   * Tracked covering regions that are fully superseded by imported
   * sub-regions: every photo in their territory is attributed to a
   * smaller child region instead. These are safe to delete.
   */
  redundantRegions: RedundantRegion[];
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
    return {
      geotaggedPhotoCount: 0,
      unmappedPhotoCount: 0,
      coveredPhotoCount: 0,
      suggestions: [],
      redundantRegions: [],
    };
  }

  const index = await load();

  // All tracked regions up front — both to flag "existing" suggestions
  // and to suppress redundant sub-region proposals for areas an
  // imported (or in-progress) region already covers.
  const trackedRows = await db
    .select({
      slug: osmRegionImports.slug,
      status: osmRegionImports.status,
      pbfSizeMb: osmRegionImports.pbf_size_mb,
    })
    .from(osmRegionImports);
  const statusBySlug = new Map(trackedRows.map((t) => [t.slug, t.status]));
  // Slug → PBF download size (MB). Drives the disk-aware delete/keep
  // verdict for redundant regions.
  const sizeBySlug = new Map(trackedRows.map((t) => [t.slug, t.pbfSizeMb]));
  const coveringSlugs = new Set(
    trackedRows
      .filter(
        (t) =>
          isRegionStatus(t.status) &&
          COVERING_STATUSES.includes(t.status as RegionStatus),
      )
      .map((t) => t.slug),
  );

  interface Resolved {
    region: GeofabrikRegion;
    /** Already covered by a tracked, non-failed region. */
    covered: boolean;
  }

  /** geohash cell → resolved region (or null = explicit "no match") */
  const cellCache = new Map<string, Resolved | null>();
  /** region slug → accumulated count + coverage flag */
  const counts = new Map<string, { region: GeofabrikRegion; count: number; covered: boolean }>();

  let unmapped = 0;
  let covered = 0;

  for (const r of rows) {
    if (r.latitude === null || r.longitude === null) continue;
    const cell = geohash7(r.latitude, r.longitude, CACHE_GEOHASH_PRECISION);
    let resolved: Resolved | null;
    if (cellCache.has(cell)) {
      resolved = cellCache.get(cell)!;
    } else {
      resolved = resolveCell(index, r.latitude, r.longitude, coveringSlugs);
      cellCache.set(cell, resolved);
    }
    if (!resolved) {
      unmapped++;
      continue;
    }
    if (resolved.covered) covered++;
    const slot = counts.get(resolved.region.id);
    if (slot) {
      slot.count++;
    } else {
      counts.set(resolved.region.id, {
        region: resolved.region,
        count: 1,
        covered: resolved.covered,
      });
    }
  }

  const suggestions: BulkRegionSuggestion[] = [...counts.values()]
    .map(({ region, count, covered: isCovered }) => {
      const status = statusBySlug.get(region.id);
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
        coveredByExisting: isCovered,
      };
    })
    .sort((a, b) => b.photoCount - a.photoCount);

  // Covered child slugs: regions in counts that are themselves covered by a
  // tracked parent. These are the "winners" that stole attribution from their
  // ancestors — used to detect which ancestors became fully redundant.
  const coveredChildSlugs = new Set(
    [...counts.entries()]
      .filter(([, v]) => v.covered)
      .map(([slug]) => slug),
  );

  // A tracked covering region is redundant when:
  //   1. It has NO directly-attributed photos (all were taken over by children)
  //   2. At least one covered descendant slug proves photos actually exist there
  const redundantRegions: RedundantRegion[] = [];
  for (const slug of coveringSlugs) {
    if (counts.has(slug)) continue; // still serving photos directly → not redundant
    const coveringChildren = [...coveredChildSlugs].filter((child) =>
      child.startsWith(slug + "/"),
    );
    if (coveringChildren.length === 0) continue; // no photos in territory at all
    const rawStatus = statusBySlug.get(slug);
    if (!rawStatus || !isRegionStatus(rawStatus)) continue;

    // Disk-aware verdict: compare the parent's PBF size against the sum
    // of its covering sub-regions. Only emit a delete/keep verdict when
    // every size is known; a single missing value makes the comparison
    // meaningless, so we fall back to "unknown".
    const parentSizeMb = sizeBySlug.get(slug) ?? null;
    const childSizes = coveringChildren.map((c) => sizeBySlug.get(c) ?? null);
    const allChildSizesKnown = childSizes.every((s) => s !== null);
    const childrenSizeMb = allChildSizesKnown
      ? childSizes.reduce((sum, s) => sum + (s as number), 0)
      : null;
    let recommendation: RedundantRegion["recommendation"] = "unknown";
    if (parentSizeMb !== null && childrenSizeMb !== null) {
      recommendation =
        childrenSizeMb <= parentSizeMb ? "delete_parent" : "keep_parent";
    }

    redundantRegions.push({
      slug,
      status: rawStatus as RegionStatus,
      coveringChildren,
      parentSizeMb,
      childrenSizeMb,
      recommendation,
    });
  }

  return {
    geotaggedPhotoCount: rows.length,
    unmappedPhotoCount: unmapped,
    coveredPhotoCount: covered,
    suggestions,
    redundantRegions,
  };
}

/**
 * Resolve a coordinate to the region we want to attribute it to:
 *   - If a tracked, non-failed region already contains the point, use
 *     the smallest such region (the photo is already covered — no new
 *     import needed).
 *   - Otherwise fall back to the smallest Geofabrik region overall
 *     (the genuine new-import suggestion).
 * Returns null when no region polygon contains the point.
 */
function resolveCell(
  index: GeofabrikIndex,
  lat: number,
  lon: number,
  coveringSlugs: Set<string>,
): { region: GeofabrikRegion; covered: boolean } | null {
  const containing = findContainingRegions(index, lat, lon);
  if (containing.length === 0) return null;

  if (coveringSlugs.size > 0) {
    const coveringHere = containing.filter((r) => coveringSlugs.has(r.id));
    const coveringPick = pickSmallestRegion(coveringHere);
    if (coveringPick) return { region: coveringPick, covered: true };
  }

  const region = pickSmallestRegion(containing);
  return region ? { region, covered: false } : null;
}

