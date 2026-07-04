import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getGeoClient, type GeoClient } from "./geo-client";

const ADVISORY_LOCK_KEY = 622_2026;
const CLAIM_LEASE_MS = 35 * 60_000;
const HEALTHY_RECHECK_MS = 15 * 60_000;
const MAX_REGIONS_PER_PASS = 100;

export interface ReplicationHealingDeps {
  db?: typeof dbDefault;
  geo?: GeoClient;
  now?: () => Date;
}

export interface ReplicationHealingOutcome {
  result: "noop" | "locked" | "healthy" | "healed" | "failed";
  slug?: string;
  detail?: string;
}

export function replicationRetryDelayMs(failureCount: number): number {
  if (failureCount <= 1) return 5 * 60_000;
  if (failureCount === 2) return 15 * 60_000;
  if (failureCount === 3) return 60 * 60_000;
  return 24 * 60 * 60_000;
}

export function nextReplicationHealthCheck(after: Date): string {
  return new Date(after.getTime() + HEALTHY_RECHECK_MS).toISOString();
}

export function isTrustedGeofabrikUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:"
      && (url.hostname === "geofabrik.de" || url.hostname.endsWith(".geofabrik.de"))
      && url.pathname.endsWith("-latest.osm.pbf");
  } catch {
    return false;
  }
}

export async function runReplicationHealingPass(
  deps: ReplicationHealingDeps = {},
): Promise<ReplicationHealingOutcome[]> {
  const outcomes: ReplicationHealingOutcome[] = [];
  for (let i = 0; i < MAX_REGIONS_PER_PASS; i += 1) {
    const outcome = await tickReplicationHealing(deps);
    if (outcome.result === "noop" || outcome.result === "locked") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Claim and inspect at most one registered region. The short advisory lock
 * serializes claims across app replicas; the persisted lease prevents a
 * second replica from claiming the same region while the geo request runs.
 */
export async function tickReplicationHealing(
  deps: ReplicationHealingDeps = {},
): Promise<ReplicationHealingOutcome> {
  const db = deps.db ?? dbDefault;
  const geo = deps.geo ?? getGeoClient();
  const now = deps.now ?? (() => new Date());
  const attemptedAt = now();
  const attemptedIso = attemptedAt.toISOString();
  const leaseUntil = new Date(attemptedAt.getTime() + CLAIM_LEASE_MS).toISOString();

  const claim = await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
    `);
    if (lockResult.rows[0]?.locked !== true) return { locked: true as const };

    const rows = await tx
      .select()
      .from(osmRegionImports)
      .where(and(
        inArray(osmRegionImports.status, ["ready_running", "ready_stopped"]),
        or(
          isNull(osmRegionImports.replication_next_retry_at),
          lte(osmRegionImports.replication_next_retry_at, attemptedIso),
        ),
      ))
      .orderBy(asc(osmRegionImports.replication_last_attempt_at), asc(osmRegionImports.slug))
      .limit(1);
    const row = rows[0];
    if (!row) return { locked: false as const, row: null };

    await tx
      .update(osmRegionImports)
      .set({
        replication_last_attempt_at: attemptedIso,
        replication_next_retry_at: leaseUntil,
        updated_at: attemptedIso,
      })
      .where(eq(osmRegionImports.slug, row.slug));
    return { locked: false as const, row };
  });

  if (claim.locked) return { result: "locked" };
  const row = claim.row;
  if (!row) return { result: "noop" };

  try {
    if (!/^nom_[a-z0-9_]+$/.test(row.postgres_db)) {
      throw new Error(`unsafe postgres database name: ${row.postgres_db}`);
    }
    if (!isTrustedGeofabrikUrl(row.geofabrik_url)) {
      throw new Error(`untrusted Geofabrik PBF URL: ${row.geofabrik_url}`);
    }

    const status = await geo.getReplicationStatus(row.postgres_db);
    let sequence = status.sequence;
    let result: ReplicationHealingOutcome["result"] = "healthy";
    let detail = "replication already initialized";
    if (!status.initialized) {
      const refreshed = await geo.refresh(row.postgres_db, row.geofabrik_url);
      sequence = refreshed.sequence;
      result = "healed";
      detail = refreshed.appliedDiffs > 0
        ? `initialized and applied ${refreshed.appliedDiffs} diff(s)`
        : "replication initialized";
    }

    const succeeded = now();
    const succeededAt = succeeded.toISOString();
    const nextCheckAt = nextReplicationHealthCheck(succeeded);
    await db
      .update(osmRegionImports)
      .set({
        replication_seq: sequence === null ? row.replication_seq : String(sequence),
        replication_last_success_at: succeededAt,
        replication_failure_count: 0,
        replication_next_retry_at: nextCheckAt,
        last_error: null,
        updated_at: succeededAt,
      })
      .where(eq(osmRegionImports.slug, row.slug));
    return { result, slug: row.slug, detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failureCount = row.replication_failure_count + 1;
    const retryAt = new Date(
      attemptedAt.getTime() + replicationRetryDelayMs(failureCount),
    ).toISOString();
    await db
      .update(osmRegionImports)
      .set({
        replication_failure_count: failureCount,
        replication_next_retry_at: retryAt,
        last_error: `replication healing: ${detail}`,
        updated_at: now().toISOString(),
      })
      .where(eq(osmRegionImports.slug, row.slug));
    return { result: "failed", slug: row.slug, detail };
  }
}
