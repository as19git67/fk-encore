/**
 * Region orchestration for the geo service.
 *
 * Owns the business logic for the per-region lifecycle:
 *
 *   - suggestForCoord:  Given a photo's GPS, return the Geofabrik
 *                       extract that covers it (used by the photo POI
 *                       worker and by the admin UI).
 *
 *   - createPending:    Persist a new region row in `pending_approval`
 *                       (or `importing` when under the auto-approve
 *                       size threshold). Idempotent on slug.
 *
 *   - approve:          Move a `pending_approval` row to `importing`
 *                       so the importer worker can pick it up.
 *
 *   - remove:           Drop a region row and ask the geo service to
 *                       drop the corresponding PostGIS database.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getGeoClient, type GeoClient } from "./geo-client";
import {
  loadGeofabrikIndex,
  pickSmallestMatchingRegion,
  type GeofabrikIndex,
  type GeofabrikRegion,
  type LoadOptions,
} from "./geofabrik-index";
import {
  assertTransition,
  isRegionStatus,
  type RegionStatus,
} from "./state-machine";

/** Default PBF-size cutoff above which a region must be approved manually. */
export const DEFAULT_AUTO_APPROVE_MAX_PBF_MB = 1500;

export interface RegionDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  /** Override the Geofabrik index loader. Tests inject a synthetic one. */
  loadIndex?: (opts?: LoadOptions) => Promise<GeofabrikIndex>;
  /** PBF-size cutoff for auto-approve (MB). Defaults to 1500. */
  autoApproveMaxPbfMb?: number;
  now?: () => Date;
}

export interface RegionSuggestion {
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
  /** Best-effort size from the Geofabrik index (may be null — Geofabrik
   *  does not publish exact sizes in `index-v1.json`). */
  pbfSizeMb: number | null;
  /** True when the region is already known in `osm_region_imports`. */
  existing: boolean;
  /** Current status if `existing`; otherwise null. */
  existingStatus: RegionStatus | null;
  /** Would `createPending` auto-promote this region to `importing`? */
  autoApprove: boolean;
}

export async function suggestForCoord(
  lat: number,
  lon: number,
  deps: RegionDeps = {},
): Promise<RegionSuggestion | null> {
  const db = deps.db ?? dbDefault;
  const load = deps.loadIndex ?? loadGeofabrikIndex;
  const autoMax = deps.autoApproveMaxPbfMb ?? DEFAULT_AUTO_APPROVE_MAX_PBF_MB;

  const index = await load();
  const region = pickSmallestMatchingRegion(index, lat, lon);
  if (!region) return null;

  const existing = await db
    .select({ status: osmRegionImports.status })
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, region.id));
  const existingStatus = existing[0]?.status;
  const status =
    existingStatus && isRegionStatus(existingStatus) ? existingStatus : null;

  return regionToSuggestion(region, status, autoMax);
}

function regionToSuggestion(
  region: GeofabrikRegion,
  existingStatus: RegionStatus | null,
  autoApproveMaxPbfMb: number,
): RegionSuggestion {
  const pbfSizeMb: number | null = null;
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
    pbfSizeMb,
    existing: existingStatus !== null,
    existingStatus,
    autoApprove: pbfSizeMb !== null && pbfSizeMb <= autoApproveMaxPbfMb,
  };
}

export interface CreatePendingResult {
  slug: string;
  status: RegionStatus;
  created: boolean;
}

export async function createPending(
  slug: string,
  deps: RegionDeps = {},
): Promise<CreatePendingResult> {
  const db = deps.db ?? dbDefault;
  const load = deps.loadIndex ?? loadGeofabrikIndex;
  const autoMax = deps.autoApproveMaxPbfMb ?? DEFAULT_AUTO_APPROVE_MAX_PBF_MB;

  const existing = await db
    .select({ slug: osmRegionImports.slug, status: osmRegionImports.status })
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  if (existing.length > 0) {
    const status = isRegionStatus(existing[0].status)
      ? existing[0].status
      : "failed";
    return { slug, status, created: false };
  }

  const index = await load();
  const region = index.regions.find((r) => r.id === slug);
  if (!region) {
    throw new Error(`unknown Geofabrik region: ${slug}`);
  }

  const suggestion = regionToSuggestion(region, null, autoMax);
  const initialStatus: RegionStatus = suggestion.autoApprove
    ? "importing"
    : "pending_approval";

  await db.insert(osmRegionImports).values({
    slug: region.id,
    geofabrik_url: region.pbfUrl,
    pbf_size_mb: suggestion.pbfSizeMb,
    postgres_db: slugToPostgresDb(region.id),
    bbox_min_lat: region.bbox[1],
    bbox_min_lon: region.bbox[0],
    bbox_max_lat: region.bbox[3],
    bbox_max_lon: region.bbox[2],
    status: initialStatus,
  });

  return { slug: region.id, status: initialStatus, created: true };
}

export async function approve(
  slug: string,
  deps: RegionDeps = {},
): Promise<RegionStatus> {
  const db = deps.db ?? dbDefault;
  const now = deps.now ?? (() => new Date());

  const rows = await db
    .select({ status: osmRegionImports.status })
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  if (rows.length === 0) throw new Error(`unknown region: ${slug}`);
  const current = rows[0].status;
  if (!isRegionStatus(current)) {
    throw new Error(`region ${slug} has unrecognised status ${current}`);
  }
  if (current === "importing") return current;

  assertTransition(current, "importing");
  await db
    .update(osmRegionImports)
    .set({ status: "importing", updated_at: now().toISOString() })
    .where(eq(osmRegionImports.slug, slug));
  return "importing";
}

/**
 * Drop a region: ask the geo service to drop the PostGIS database,
 * then delete the DB row. The geo-side drop is best-effort tolerated
 * — a 404 (database doesn't exist there) is treated as success so the
 * admin can clean up stuck rows even after a manual purge.
 */
export async function remove(
  slug: string,
  deps: RegionDeps = {},
): Promise<boolean> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();

  const rows = await db
    .select({ postgres_db: osmRegionImports.postgres_db })
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  if (rows.length === 0) return false;

  try {
    await geo.dropRegion(rows[0].postgres_db);
  } catch (err) {
    // If the geo side fails we still drop the DB row — the admin can
    // re-import later and the geo service's /import endpoint is
    // idempotent against existing databases.
    console.warn(
      `[osm-admin] geo dropRegion failed for ${slug}:`,
      (err as Error).message ?? err,
    );
  }

  const result = await db
    .delete(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  return (result?.rowCount ?? 0) > 0;
}

/**
 * Map a Geofabrik hierarchical slug to a safe Postgres database name.
 * "europe/germany/bayern" → "nom_europe_germany_bayern".
 */
export function slugToPostgresDb(slug: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_");
  return `nom_${safe}`.replace(/_$/, "");
}
