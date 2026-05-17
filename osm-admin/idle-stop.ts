/**
 * Idle-stop sweeper for per-region Nominatim/Overpass containers
 * (Epic #383).
 *
 * Runs on a `lib/local-cron` schedule every 5 minutes. For each
 * region in `ready_running` whose `last_used_at` (or `updated_at`
 * fallback for never-used regions) is older than
 * `POI_REGION_IDLE_STOP_MINUTES` (default 30), stops both containers
 * via the docker driver and flips the row to `ready_stopped`.
 *
 * Cold-start of a stopped region is handled by `region-router`'s
 * `ensureReady`: the router brings the containers back up on the
 * first inbound /osm/reverse or /osm/overpass request. Cold-start
 * latency is dominated by Postgres warming ~5-15 s.
 */

import { and, eq, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getDockerDriver, type DockerDriver } from "./docker-driver";
import { slugToContainerSuffix } from "./importer";
import { containerName } from "./naming";
import { assertTransition } from "./state-machine";

const DEFAULT_IDLE_MINUTES = parseInt(
  process.env.POI_REGION_IDLE_STOP_MINUTES ?? "30",
  10,
);

export interface IdleStopDeps {
  db?: typeof dbDefault;
  driver?: DockerDriver;
  now?: () => Date;
  /** Override the idle threshold for tests. */
  idleStopMinutes?: number;
}

export interface IdleStopResult {
  /** Slugs successfully stopped this tick. */
  stopped: string[];
  /** Slugs we tried to stop but the docker driver threw. */
  failed: Array<{ slug: string; error: string }>;
}

/**
 * Stop every `ready_running` region that hasn't been touched in the
 * configured idle window. Safe to call on a timer; no-op when nothing
 * is stale.
 */
export async function tickIdleStop(
  deps: IdleStopDeps = {},
): Promise<IdleStopResult> {
  const db = deps.db ?? dbDefault;
  const driver = deps.driver ?? getDockerDriver();
  const now = deps.now ?? (() => new Date());
  const idleMin = deps.idleStopMinutes ?? DEFAULT_IDLE_MINUTES;

  const cutoff = new Date(
    now().getTime() - idleMin * 60_000,
  ).toISOString();

  // last_used_at is null for regions that have been imported but not
  // yet served a request. Fall back to updated_at (set when the row
  // last transitioned, including the importer's ready_running step).
  const candidates = await db
    .select()
    .from(osmRegionImports)
    .where(
      and(
        eq(osmRegionImports.status, "ready_running"),
        sql`COALESCE(${osmRegionImports.last_used_at}, ${osmRegionImports.updated_at}) < ${cutoff}`,
      ),
    );

  const stopped: string[] = [];
  const failed: Array<{ slug: string; error: string }> = [];

  for (const row of candidates) {
    const suffix = slugToContainerSuffix(row.slug);
    try {
      // Both stop() calls are idempotent against missing/already-
      // stopped containers, so a partial reboot state self-heals.
      await driver.stop(containerName("nominatim", suffix));
      await driver.stop(containerName("overpass", suffix));
      assertTransition("ready_running", "ready_stopped");
      await db
        .update(osmRegionImports)
        .set({
          status: "ready_stopped",
          updated_at: now().toISOString(),
        })
        .where(eq(osmRegionImports.slug, row.slug));
      stopped.push(row.slug);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      failed.push({ slug: row.slug, error: msg });
      console.error(
        `[osm-admin] failed to idle-stop ${row.slug}: ${msg}`,
      );
    }
  }
  return { stopped, failed };
}
