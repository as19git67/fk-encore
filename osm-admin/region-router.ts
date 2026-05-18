/**
 * Region router — maps a GPS coordinate to the per-region Nominatim/
 * Overpass instance that should handle the request.
 *
 * Two responsibilities:
 *
 *   1. pickRegion(lat, lon): walk the `osm_region_imports` rows whose
 *      status is `ready_running` or `ready_stopped`, return the one
 *      whose bbox is the smallest match. A short-lived in-memory cache
 *      keyed on a Geohash-7 cell (~150 m × 150 m) keeps the round-trip
 *      free for repeated lookups in the same area.
 *
 *   2. ensureReady(slug): if the picked region is `ready_stopped`,
 *      call into the docker driver to start it again and flip the row
 *      back to `ready_running`. The cold-start path is the only place
 *      the router waits on Docker; the hot path is constant-time.
 *
 * The router itself does not forward HTTP traffic — see `proxy.ts` for
 * the thin endpoints that wrap a pickRegion + ensureReady + fetch.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getDockerDriver, type DockerDriver } from "./docker-driver";
import {
  nominatimDescriptor,
  overpassDescriptor,
  overpassHealthcheckUrl,
  slugToContainerSuffix,
} from "./importer";
import { containerName } from "./naming";
import { assertTransition, isRegionStatus, type RegionStatus } from "./state-machine";

/** Geohash precision: 7 chars ≈ 153 m × 153 m at the equator. */
const GEOHASH_PRECISION = 7;
const CACHE_TTL_MS = 60_000;

const HEALTHCHECK_MAX_ATTEMPTS = 60;
const HEALTHCHECK_INTERVAL_MS = 1_000;

export interface RegionMatch {
  slug: string;
  status: RegionStatus;
  nominatimHost: string;
  overpassHost: string;
  bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
}

export interface RouterDeps {
  db?: typeof dbDefault;
  driver?: DockerDriver;
  now?: () => Date;
  /** Geohash function — override in tests. */
  geohash?: (lat: number, lon: number, precision: number) => string;
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
 *
 * The function never mutates state. Cold-start of a stopped region is
 * a separate explicit call (`ensureReady`) so callers can decide
 * whether they want to pay the start-up latency on this request.
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
    // Cache may have negative entries (null) — still respect TTL.
    return cached.match;
  }

  const rows = await db
    .select()
    .from(osmRegionImports)
    .where(
      and(
        inArray(osmRegionImports.status, ["ready_running", "ready_stopped"]),
        sql`${osmRegionImports.bbox_min_lat} <= ${lat}`,
        sql`${osmRegionImports.bbox_max_lat} >= ${lat}`,
        sql`${osmRegionImports.bbox_min_lon} <= ${lon}`,
        sql`${osmRegionImports.bbox_max_lon} >= ${lon}`,
      ),
    );

  let best: typeof rows[number] | null = null;
  let bestArea = Infinity;
  for (const r of rows) {
    const area =
      (r.bbox_max_lat - r.bbox_min_lat) * (r.bbox_max_lon - r.bbox_min_lon);
    if (area < bestArea) {
      bestArea = area;
      best = r;
    }
  }

  let match: RegionMatch | null = null;
  if (best && isRegionStatus(best.status)) {
    const suffix = slugToContainerSuffix(best.slug);
    match = {
      slug: best.slug,
      status: best.status,
      nominatimHost: containerName("nominatim", suffix),
      overpassHost: containerName("overpass", suffix),
      bbox: {
        minLat: best.bbox_min_lat,
        minLon: best.bbox_min_lon,
        maxLat: best.bbox_max_lat,
        maxLon: best.bbox_max_lon,
      },
    };
  }

  cache.set(hash, { match, expiresAt: now().getTime() + CACHE_TTL_MS });
  return match;
}

/**
 * If the picked region is in `ready_stopped`, ask the driver to start
 * the two persistent containers and flip the row to `ready_running`.
 *
 * Idempotent — running regions return immediately. Throws if the
 * driver can't bring the containers up; the caller surfaces that as a
 * 503 to the upstream POI worker.
 */
export async function ensureReady(
  slug: string,
  deps: RouterDeps = {},
): Promise<void> {
  const db = deps.db ?? dbDefault;
  const driver = deps.driver ?? getDockerDriver();
  const now = deps.now ?? (() => new Date());

  const rows = await db
    .select()
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  const row = rows[0];
  if (!row) throw new Error(`unknown region: ${slug}`);
  if (!isRegionStatus(row.status)) {
    throw new Error(`region ${slug} has unrecognised status ${row.status}`);
  }
  if (row.status === "ready_running") return;
  if (row.status !== "ready_stopped") {
    throw new Error(
      `region ${slug} is in status ${row.status}; cannot ensure ready`,
    );
  }

  const suffix = slugToContainerSuffix(slug);
  // Bring up both containers; the driver's ensureRunning is idempotent
  // and does not block on health. We start with the same descriptors the
  // importer would use so a cold-start after idle-stop reattaches to
  // the existing named volumes and reuses the imported DB.
  await driver.ensureRunning(
    nominatimDescriptor(slug, suffix, row.geofabrik_url, process.env.NOMINATIM_IMAGE ?? "mediagis/nominatim:5.0"),
  );
  await driver.ensureRunning(
    overpassDescriptor(suffix, row.geofabrik_url, process.env.OVERPASS_IMAGE ?? "wiktorn/overpass-api:latest"),
  );

  // For a cold-start (volume already populated) the API is usually back
  // within 5–15 s. Budget 60 s so a flapping container still surfaces.
  const nomOk = await driver.waitHealthy(
    `http://${containerName("nominatim", suffix)}:8080/status`,
    { maxAttempts: HEALTHCHECK_MAX_ATTEMPTS, intervalMs: HEALTHCHECK_INTERVAL_MS },
  );
  const ovOk = await driver.waitHealthy(
    overpassHealthcheckUrl(suffix),
    { maxAttempts: HEALTHCHECK_MAX_ATTEMPTS, intervalMs: HEALTHCHECK_INTERVAL_MS },
  );
  if (!nomOk || !ovOk) {
    throw new Error(
      `${slug}: cold-start healthcheck failed (nominatim=${nomOk}, overpass=${ovOk})`,
    );
  }

  assertTransition("ready_stopped", "ready_running");
  await db
    .update(osmRegionImports)
    .set({
      status: "ready_running",
      updated_at: now().toISOString(),
      last_used_at: now().toISOString(),
    })
    .where(eq(osmRegionImports.slug, slug));

  // Invalidate every cache entry pointing at this slug so the next
  // pickRegion sees the fresh state.
  for (const [key, entry] of cache) {
    if (entry.match?.slug === slug) cache.delete(key);
  }
}

/**
 * Bump `last_used_at` to the current time. Called by the proxy after a
 * successful forward — the idle-stop sweeper uses this column to decide
 * which regions are safe to stop.
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
 * alphabet. Sufficient for our cache-key purposes; no external dep.
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

// Exported for tests that need to assert the healthcheck constants
// haven't drifted (the importer uses a longer budget; the router
// trusts that already-imported regions warm up much faster).
export const __TEST_HEALTHCHECK = {
  maxAttempts: HEALTHCHECK_MAX_ATTEMPTS,
  intervalMs: HEALTHCHECK_INTERVAL_MS,
};
