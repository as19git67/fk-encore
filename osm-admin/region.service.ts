/**
 * Region orchestration for self-hosted Nominatim/Overpass shards.
 *
 * This module owns the business logic for the per-region lifecycle:
 *
 *   - suggestForCoord:  Given a photo's GPS, return the Geofabrik
 *                       extract that covers it (used by the photo POI
 *                       worker and by the admin UI).
 *
 *   - createPending:    Persist a new region row in `pending_approval`
 *                       (or `importing` when under the auto-approve
 *                       size threshold). Idempotent on slug.
 *
 *   - approve:          Move a `pending_approval` row through
 *                       `importing` to `ready_running`. The actual
 *                       dockerode-driven container provisioning lands
 *                       in the next slice — for now the function only
 *                       persists the state transitions so the admin UI
 *                       can be wired against the final contract.
 *
 *   - remove:           Drop a region row. The real implementation
 *                       will tear down the associated containers and
 *                       volumes; until then it just deletes the row.
 *
 * Each entry point accepts an injectable dependency bag so tests can
 * replace the DB, geofabrik loader, and clock.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getDockerDriver, type DockerDriver } from "./docker-driver";
import {
  loadGeofabrikIndex,
  pickSmallestMatchingRegion,
  type GeofabrikIndex,
  type GeofabrikRegion,
  type LoadOptions,
} from "./geofabrik-index";
import { slugToContainerSuffix } from "./importer";
import {
  assertTransition,
  isRegionStatus,
  type RegionStatus,
} from "./state-machine";

/** Default PBF-size cutoff above which a region must be approved manually. */
export const DEFAULT_AUTO_APPROVE_MAX_PBF_MB = 1500;

export interface RegionDeps {
  db?: typeof dbDefault;
  driver?: DockerDriver;
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

/**
 * Look up the smallest Geofabrik region covering `(lat, lon)` and
 * report whether it's already tracked in the DB.
 *
 * Returns null when the point is outside every Geofabrik polygon
 * (e.g. open ocean) — the caller should surface that as "no region
 * available" so the photo can be tagged accordingly.
 */
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
    // Without a published size we conservatively require approval.
    // The importer (next slice) measures the PBF after HEAD and may
    // auto-promote at that point if it's under the threshold.
    autoApprove: pbfSizeMb !== null && pbfSizeMb <= autoApproveMaxPbfMb,
  };
}

export interface CreatePendingResult {
  slug: string;
  status: RegionStatus;
  created: boolean;
}

/**
 * Persist a new region row. Idempotent: when the slug already exists
 * the row is returned untouched.
 *
 * Status starts as `pending_approval` unless `autoApprove === true`,
 * in which case it skips straight to `importing` (the importer worker
 * will pick it up).
 */
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

/**
 * Approve a region that's sitting in `pending_approval`. Currently
 * just flips the state to `importing` so the upcoming importer worker
 * (dockerode-driven) can pick it up. The actual container provisioning
 * is intentionally not wired here yet — keeping the state-machine
 * contract real lets the admin UI be developed in parallel.
 *
 * Idempotent for already-importing rows; throws on illegal transitions.
 */
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
 * Drop a region: stop+remove the two per-region containers, remove
 * the two named Docker volumes, then delete the DB row.
 *
 * Each docker operation is tolerated independently — a stop on a
 * missing container is fine, a removeVolume against a volume in use
 * propagates the error so the admin can intervene. Container removal
 * happens before volume removal so Docker doesn't reject the volume
 * delete with "in use".
 *
 * The DB row is deleted only after the docker side succeeded; if the
 * driver throws, the row stays so the admin can retry.
 */
export async function remove(
  slug: string,
  deps: RegionDeps = {},
): Promise<boolean> {
  const db = deps.db ?? dbDefault;
  const driver = deps.driver ?? getDockerDriver();

  const suffix = slugToContainerSuffix(slug);
  const nominatim = `nominatim-${suffix}`;
  const overpass = `overpass-${suffix}`;
  const nominatimVolume = `fk-encore-osm-nominatim-${suffix}`;
  const overpassVolume = `fk-encore-osm-overpass-${suffix}`;

  await driver.stop(nominatim);
  await driver.stop(overpass);
  await driver.remove(nominatim);
  await driver.remove(overpass);
  await driver.removeVolume(nominatimVolume);
  await driver.removeVolume(overpassVolume);

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
