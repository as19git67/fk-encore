/**
 * Region importer — single-tick worker that drives `importing` rows
 * toward `ready_running`.
 *
 * Architecture: a single long-lived geo service (see /geo) owns one
 * PostGIS database per region and runs the actual osm2pgsql work. The
 * importer here is a thin orchestrator that:
 *
 *   1. Picks the oldest `importing` row whose `updated_at` has expired
 *      its cooldown.
 *   2. HEAD-probes the PBF size and disk-prechecks the host volume.
 *   3. Asks the geo service for the current import status of the
 *      region's database. If none is known, kicks off a new import via
 *      `POST /import` (which queues an in-process background osm2pgsql
 *      run and returns immediately).
 *   4. On `running`, leaves the row as `importing` and bumps
 *      `updated_at` to schedule the next poll.
 *   5. On `ready`, transitions the row to `ready_running` and
 *      backfills POI detection for any photo inside the region's bbox.
 *   6. On `failed`, transitions to `failed` with the geo service's
 *      error detail.
 *
 * Why ticks: an import for a German Bundesland still takes 10–30 min;
 * the geo service runs it asynchronously and the tick polls.
 */

import { and, asc, eq, lt, or, isNull } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getGeoClient, type GeoClient } from "./geo-client";
import { probePbfSizeMb } from "./pbf-probe";
import { freeDiskMb as defaultFreeDiskMb } from "./disk-probe";
import { enqueuePoiDetectionForRegion } from "../photo/scan-queue";
import { ENABLE_POI_DETECTION } from "../photo/scan-config";
import { assertTransition, isRegionStatus, type RegionStatus } from "./state-machine";

/** Postgres footprint multiplier vs raw PBF size. Conservative side. */
const POSTGRES_EXPANSION_FACTOR = 10;
/** Minimum cooldown between consecutive ticks on the same row. */
const TICK_COOLDOWN_MS = 30_000;

export interface ImporterDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  /** Probe PBF size; override in tests to return a deterministic value. */
  probeSize?: (url: string) => Promise<number | null>;
  /** Free disk space in MB at the storage volume. Tests inject a value. */
  freeDiskMb?: () => Promise<number | null>;
  now?: () => Date;
  /**
   * Whether to backfill the poi_detection queue when a region
   * transitions to `ready_running`. Defaults to the module-load env
   * `ENABLE_POI_DETECTION`. Tests pass an explicit boolean since the
   * env-captured constant is fixed at import time.
   */
  poiDetectionEnabled?: boolean;
}

export interface TickOutcome {
  /** Slug picked this tick, or null if nothing to do. */
  slug: string | null;
  /** Resulting status — "noop" when no row was picked, "waiting" when
   *  the geo service is still importing (row stays `importing`). */
  result: RegionStatus | "noop" | "waiting";
  /** Optional human-readable detail. */
  detail?: string;
}

/**
 * Process at most one importing row. Safe to call on a timer.
 */
export async function tickImporter(deps: ImporterDeps = {}): Promise<TickOutcome> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();
  const probe = deps.probeSize ?? probePbfSizeMb;
  const freeDisk = deps.freeDiskMb ?? (() => defaultFreeDiskMb());
  const now = deps.now ?? (() => new Date());

  const cooldownCutoff = new Date(now().getTime() - TICK_COOLDOWN_MS).toISOString();

  const picked = await db
    .select()
    .from(osmRegionImports)
    .where(
      and(
        eq(osmRegionImports.status, "importing"),
        or(
          isNull(osmRegionImports.updated_at),
          lt(osmRegionImports.updated_at, cooldownCutoff),
        ),
      ),
    )
    .orderBy(asc(osmRegionImports.updated_at))
    .limit(1);
  const row = picked[0];
  if (!row) return { slug: null, result: "noop" };

  const slug = row.slug;

  try {
    // Step 1: probe size (only if we don't already have one cached).
    let sizeMb = row.pbf_size_mb ?? null;
    if (sizeMb === null) {
      sizeMb = await probe(row.geofabrik_url);
      if (sizeMb !== null) {
        await db
          .update(osmRegionImports)
          .set({ pbf_size_mb: sizeMb, updated_at: now().toISOString() })
          .where(eq(osmRegionImports.slug, slug));
      }
    }

    // Step 2: disk pre-check (best effort).
    const free = await freeDisk();
    if (free !== null && sizeMb !== null) {
      const need = sizeMb * POSTGRES_EXPANSION_FACTOR;
      if (free < need) {
        const detail = `free=${free}MB need=${need}MB (sizeMb × ${POSTGRES_EXPANSION_FACTOR})`;
        await transition(db, slug, "importing", "blocked_disk", detail, now);
        return { slug, result: "blocked_disk", detail };
      }
    }

    // Step 3: ask the geo service what state this database is in.
    const status = await geo.getImportStatus(row.postgres_db);

    if (!status) {
      // Nothing started yet — kick it off and return waiting.
      await geo.startImport({
        slug: row.slug,
        postgresDb: row.postgres_db,
        pbfUrl: row.geofabrik_url,
      });
      await db
        .update(osmRegionImports)
        .set({ updated_at: now().toISOString() })
        .where(eq(osmRegionImports.slug, slug));
      return { slug, result: "waiting", detail: "geo import queued" };
    }

    if (status.state === "running") {
      await db
        .update(osmRegionImports)
        .set({ updated_at: now().toISOString() })
        .where(eq(osmRegionImports.slug, slug));
      return { slug, result: "waiting", detail: `geo state=${status.state}` };
    }

    if (status.state === "failed") {
      await transition(
        db,
        slug,
        "importing",
        "failed",
        status.error ?? "geo import failed",
        now,
      );
      return { slug, result: "failed", detail: status.error };
    }

    // status.state === "ready"
    await transition(db, slug, "importing", "ready_running", null, now, {
      imported_at: status.importedAt ?? now().toISOString(),
      last_error: null,
    });

    // Step 4: backfill poi_detection.
    const poiEnabled = deps.poiDetectionEnabled ?? ENABLE_POI_DETECTION;
    if (poiEnabled) {
      const enqueued = await enqueuePoiDetectionForRegion({
        minLat: row.bbox_min_lat,
        minLon: row.bbox_min_lon,
        maxLat: row.bbox_max_lat,
        maxLon: row.bbox_max_lon,
      });
      if (enqueued > 0) {
        console.log(
          `[osm-admin] region ${slug} ready_running — backfilled ` +
            `poi_detection for ${enqueued} photo(s) in its bbox`,
        );
      }
    }

    return { slug, result: "ready_running" };
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    await transition(db, slug, "importing", "failed", detail, now);
    return { slug, result: "failed", detail };
  }
}

async function transition(
  db: typeof dbDefault,
  slug: string,
  from: RegionStatus,
  to: RegionStatus,
  errorDetail: string | null,
  now: () => Date,
  extra: Partial<{ imported_at: string; last_error: string | null }> = {},
): Promise<void> {
  if (isRegionStatus(from) && isRegionStatus(to)) assertTransition(from, to);
  await db
    .update(osmRegionImports)
    .set({
      status: to,
      updated_at: now().toISOString(),
      last_error: errorDetail,
      ...extra,
    })
    .where(eq(osmRegionImports.slug, slug));
}
