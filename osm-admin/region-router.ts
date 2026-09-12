/**
 * Region router — maps a GPS coordinate to the per-region PostGIS
 * database that should serve the request.
 *
 * Single responsibility:
 *
 *   pickRegion(lat, lon): walk the `osm_region_imports` rows whose
 *     status is `ready_running`, take the ones whose bbox contains the
 *     point, smallest first, and return the first that **actually holds
 *     data there**. A short-lived in-memory cache keyed on a Geohash-7
 *     cell (~150 m × 150 m) keeps the round-trip free for repeated
 *     lookups in the same area.
 *
 * The second half of that sentence was missing for a long time, and it
 * is the half that matters. A bounding box says "might contain", never
 * "does": a Geofabrik extract is cut along administrative borders and
 * its rectangle overlaps its neighbours generously. Italy's Nord-Ovest
 * — Piedmont, Liguria, Lombardy — has a rectangle reaching south past
 * Pisa and east past Florence, so a trip to either was routed to a
 * database whose data stops at the Tuscan border. It came back with no
 * spots and no explanation, while a village a few kilometres further
 * south fell outside the rectangle, asked for its own region and was
 * planned correctly.
 *
 * So the bbox stays what it is good at — a cheap, indexed way to
 * shortlist — and the data decides.
 *
 * Since the migration to the single-container geo service there is no
 * per-region cold-start anymore — the geo container is always up. The
 * old `ensureReady` cold-start path is therefore gone; status names
 * `ready_stopped` (left over from the per-region docker era) are
 * treated as a synonym for `ready_running` on read.
 */

import log from "encore.dev/log";
import { and, eq, inArray, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { isRegionStatus, type RegionStatus } from "./state-machine";
import { getGeoClient } from "./geo-client";

/** Geohash precision: 7 chars ≈ 153 m × 153 m at the equator. */
const GEOHASH_PRECISION = 7;
const CACHE_TTL_MS = 60_000;

export interface RegionMatch {
  slug: string;
  status: RegionStatus;
  /** Geo-service-side Postgres database name (e.g. `nom_europe_germany_bayern`). */
  postgresDb: string;
  bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
}

export interface RouterDeps {
  db?: typeof dbDefault;
  now?: () => Date;
  /** Geohash function — override in tests. */
  geohash?: (lat: number, lon: number, precision: number) => string;
  /**
   * Does that database hold anything near the point? Defaults to asking
   * the geo service; a test passes its own.
   */
  covers?: (postgresDb: string, lat: number, lon: number) => Promise<boolean>;
}

interface CacheEntry {
  match: RegionMatch | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: clear the in-memory cache. */
export function clearRouterCache(): void {
  cache.clear();
}

/**
 * Find the smallest known ready region that covers `(lat, lon)`.
 * Returns null when no region matches — the caller treats that as
 * "needs an import job" and enqueues a `region_import` request via the
 * existing region service.
 */
export async function pickRegion(
  lat: number,
  lon: number,
  deps: RouterDeps = {},
): Promise<RegionMatch | null> {
  const db = deps.db ?? dbDefault;
  const now = deps.now ?? (() => new Date());
  const hash = (deps.geohash ?? geohash7)(lat, lon, GEOHASH_PRECISION);

  const cached = cache.get(hash);
  if (cached && cached.expiresAt > now().getTime()) {
    return cached.match;
  }

  const rows = await db
    .select()
    .from(osmRegionImports)
    .where(
      and(
        // ready_stopped is a leftover state from the old docker-driven
        // setup; the geo service has no concept of stopping, so any row
        // sitting in ready_stopped is still serveable.
        inArray(osmRegionImports.status, ["ready_running", "ready_stopped"]),
        sql`${osmRegionImports.bbox_min_lat} <= ${lat}`,
        sql`${osmRegionImports.bbox_max_lat} >= ${lat}`,
        sql`${osmRegionImports.bbox_min_lon} <= ${lon}`,
        sql`${osmRegionImports.bbox_max_lon} >= ${lon}`,
      ),
    );

  // Smallest rectangle first: where two regions genuinely overlap, the
  // tighter one is the likelier home of the point.
  const candidates = rows
    .filter((r) => isRegionStatus(r.status))
    .sort((a, b) => bboxArea(a) - bboxArea(b));

  const covers = deps.covers ?? defaultCovers;
  let match: RegionMatch | null = null;
  for (const row of candidates) {
    // Every candidate is asked, the only one included: a single wrong
    // rectangle is exactly the case this exists for. Pisa had one
    // candidate, and taking it on trust is what produced an empty trip.
    let covered = false;
    try {
      covered = await covers(row.postgres_db, lat, lon);
    } catch (err) {
      // A probe that cannot run must not decide. Treat it as "no
      // opinion" and keep the candidate: an unreachable geo service is
      // a fault of its own, and turning it into "this region does not
      // cover Pisa" would send a good trip off to import a region it
      // already has.
      log.warn("coverage probe failed, keeping the bbox match", {
        postgresDb: row.postgres_db,
        reason: err instanceof Error ? err.message : String(err),
      });
      covered = true;
    }
    if (!covered) {
      log.info("region rejected: its bbox contains the point, its data does not", {
        postgresDb: row.postgres_db,
        slug: row.slug,
        lat,
        lon,
      });
      continue;
    }
    match = toMatch(row);
    break;
  }

  cache.set(hash, { match, expiresAt: now().getTime() + CACHE_TTL_MS });
  return match;
}

function bboxArea(r: {
  bbox_min_lat: number; bbox_min_lon: number; bbox_max_lat: number; bbox_max_lon: number;
}): number {
  return (r.bbox_max_lat - r.bbox_min_lat) * (r.bbox_max_lon - r.bbox_min_lon);
}

function toMatch(row: {
  slug: string; status: string; postgres_db: string;
  bbox_min_lat: number; bbox_min_lon: number; bbox_max_lat: number; bbox_max_lon: number;
}): RegionMatch | null {
  if (!isRegionStatus(row.status)) return null;
  return {
    slug: row.slug,
    status: row.status,
    postgresDb: row.postgres_db,
    bbox: {
      minLat: row.bbox_min_lat,
      minLon: row.bbox_min_lon,
      maxLat: row.bbox_max_lat,
      maxLon: row.bbox_max_lon,
    },
  };
}

async function defaultCovers(postgresDb: string, lat: number, lon: number): Promise<boolean> {
  return await getGeoClient().hasCoverage(postgresDb, lat, lon);
}

/**
 * Bump `last_used_at` to the current time. Called by the proxy after a
 * successful forward — useful for diagnostics / admin UI even though
 * the idle-stop sweeper that originally consumed it has been removed.
 */
export async function markUsed(
  slug: string,
  deps: RouterDeps = {},
): Promise<void> {
  const db = deps.db ?? dbDefault;
  const now = deps.now ?? (() => new Date());
  await db
    .update(osmRegionImports)
    .set({ last_used_at: now().toISOString() })
    .where(eq(osmRegionImports.slug, slug));
}

/**
 * Encode `(lat, lon)` into a Geohash of the requested precision.
 * Standard Geohash-32 algorithm — interleaved lon/lat bits, base-32
 * alphabet.
 */
export function geohash7(lat: number, lon: number, precision: number): string {
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let bit = 0;
  let ch = 0;
  let even = true;
  let out = "";
  while (out.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) {
        ch = (ch << 1) | 1;
        minLon = mid;
      } else {
        ch = ch << 1;
        maxLon = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        minLat = mid;
      } else {
        ch = ch << 1;
        maxLat = mid;
      }
    }
    even = !even;
    bit++;
    if (bit === 5) {
      out += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}
