/**
 * Apply replication diffs to an already-imported region (Epic #383).
 *
 * For Nominatim:
 *   `nominatim replication --once` (run inside the per-region
 *   container) pulls all diffs published since the last refresh from
 *   the Geofabrik URL the container was started with, applies them to
 *   the bundled postgres, and persists the new sequence ID. The
 *   command exits 0 even when no new diffs were available (warm path).
 *
 * For Overpass:
 *   wiktorn/overpass-api ships its own supervisord-managed update
 *   worker that picks up minutely diffs automatically. No manual exec
 *   is required — we just confirm the container is up.
 *
 * Both calls go through `DockerDriver.exec`/`inspect` so the
 * InMemoryDockerDriver can simulate them in tests.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";
import { getDockerDriver, type DockerDriver } from "./docker-driver";
import { slugToContainerSuffix } from "./importer";

export interface RefreshDeps {
  db?: typeof dbDefault;
  driver?: DockerDriver;
  now?: () => Date;
}

export interface RefreshResult {
  slug: string;
  /** True iff `nominatim replication --once` exited 0. */
  ok: boolean;
  /** New replication sequence id when the command surfaced one. */
  replicationSeq?: string;
  /** Diagnostic line (last stderr/stdout snippet) on failure. */
  detail?: string;
}

export async function refreshRegion(
  slug: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const db = deps.db ?? dbDefault;
  const driver = deps.driver ?? getDockerDriver();
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

  const suffix = slugToContainerSuffix(slug);
  const containerName = `nominatim-${suffix}`;

  // For a stopped region, the caller (admin UI) is expected to ensure
  // it's up first via the router's ensureReady. We don't auto-start
  // here so the refresh stays a focused operation.
  const info = await driver.inspect(containerName);
  if (info.state !== "running") {
    throw new Error(
      `nominatim-${suffix} is in state ${info.state}; start the region before refreshing`,
    );
  }

  const exec = await driver.exec(containerName, [
    "sudo",
    "-u",
    "nominatim",
    "nominatim",
    "replication",
    "--once",
  ]);

  if (exec.exitCode !== 0) {
    const last = (exec.stderr || exec.stdout).trim().split(/\n/).slice(-3).join(" | ");
    await db
      .update(osmRegionImports)
      .set({
        last_error: `replication exit=${exec.exitCode}: ${last}`,
        updated_at: now().toISOString(),
      })
      .where(eq(osmRegionImports.slug, slug));
    return { slug, ok: false, detail: last };
  }

  // Try to extract the new sequence id. Nominatim's `replication
  // --once` prints lines like "Updating to sequence 4775" or similar
  // — we tolerate format drift by capturing whatever digits come
  // last; nothing breaks when the regex misses.
  const seqMatch = (exec.stdout + "\n" + exec.stderr).match(/sequence\s+(\d+)/i);
  const replicationSeq = seqMatch?.[1];

  await db
    .update(osmRegionImports)
    .set({
      replication_seq: replicationSeq ?? row.replication_seq,
      last_error: null,
      last_used_at: now().toISOString(),
      updated_at: now().toISOString(),
    })
    .where(eq(osmRegionImports.slug, slug));

  return { slug, ok: true, replicationSeq };
}
