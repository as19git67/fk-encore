/**
 * Apply replication diffs to an already-imported region.
 *
 * Delegates the work to the geo service's `POST /refresh` endpoint,
 * which runs `osm2pgsql-replication update` against the region's
 * PostGIS database and reports back how many diffs were applied. The
 * geo service additionally runs an hourly background loop that calls
 * the same code path, so this endpoint is mostly for ad-hoc admin UI
 * use; both paths are idempotent.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getGeoClient, type GeoClient } from "./geo-client";
import {
  nextReplicationHealthCheck,
  replicationRetryDelayMs,
} from "./replication-healer";

export interface RefreshDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  now?: () => Date;
}

export interface RefreshResult {
  slug: string;
  /** True iff the geo service returned 2xx. */
  ok: boolean;
  /** New replication sequence id when the command surfaced one. */
  replicationSeq?: string;
  /** Diagnostic line on failure. */
  detail?: string;
}

export async function refreshRegion(
  slug: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();
  const now = deps.now ?? (() => new Date());

  const rows = await db
    .select()
    .from(osmRegionImports)
    .where(eq(osmRegionImports.slug, slug));
  const row = rows[0];
  if (!row) throw new Error(`unknown region: ${slug}`);
  if (row.status !== "ready_running" && row.status !== "ready_stopped") {
    throw new Error(
      `region ${slug} is in status ${row.status}; can only refresh when ready_*`,
    );
  }

  try {
    // Forward the PBF URL so the geo service can auto-initialise
    // replication if this region's status table is missing (imported
    // but never `init`-ed — otherwise the update subprocess crashes).
    const result = await geo.refresh(row.postgres_db, row.geofabrik_url);
    const replicationSeq =
      result.sequence !== null && result.sequence !== undefined
        ? String(result.sequence)
        : row.replication_seq ?? undefined;
    const succeeded = now();
    const succeededAt = succeeded.toISOString();
    const nextCheckAt = nextReplicationHealthCheck(succeeded);
    await db
      .update(osmRegionImports)
      .set({
        replication_seq: replicationSeq ?? null,
        replication_last_attempt_at: succeededAt,
        replication_last_success_at: succeededAt,
        replication_failure_count: 0,
        replication_next_retry_at: nextCheckAt,
        last_error: null,
        last_used_at: succeededAt,
        updated_at: succeededAt,
      })
      .where(eq(osmRegionImports.slug, slug));
    return {
      slug,
      ok: true,
      replicationSeq,
      detail:
        result.appliedDiffs > 0
          ? `applied ${result.appliedDiffs} diff(s)`
          : "already up to date",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failedAt = now();
    const failureCount = row.replication_failure_count + 1;
    await db
      .update(osmRegionImports)
      .set({
        replication_last_attempt_at: failedAt.toISOString(),
        replication_failure_count: failureCount,
        replication_next_retry_at: new Date(
          failedAt.getTime() + replicationRetryDelayMs(failureCount),
        ).toISOString(),
        last_error: `replication: ${detail}`,
        updated_at: failedAt.toISOString(),
      })
      .where(eq(osmRegionImports.slug, slug));
    return { slug, ok: false, detail };
  }
}
