/**
 * Apply replication diffs to an already-imported region.
 *
 * Stub for now: the geo service does not yet ship an osm2pgsql --append
 * worker (see Phase 5 of the geo migration). The endpoint stays
 * available so the admin UI's "Refresh" button continues to work; it
 * just becomes a no-op that bumps last_used_at. Real replication wiring
 * lands when /geo grows a cron-driven replication subprocess.
 */

import { eq } from "drizzle-orm";
import dbDefault from "../db/database";
import { osmRegionImports } from "../db/schema";

export interface RefreshDeps {
  db?: typeof dbDefault;
  now?: () => Date;
}

export interface RefreshResult {
  slug: string;
  /** Always true at the moment; reserved for the Phase 5 replication. */
  ok: boolean;
  /** Reserved for the new sequence id once replication is implemented. */
  replicationSeq?: string;
  /** Diagnostic line on failure. */
  detail?: string;
}

export async function refreshRegion(
  slug: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const db = deps.db ?? dbDefault;
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

  await db
    .update(osmRegionImports)
    .set({
      last_used_at: now().toISOString(),
      updated_at: now().toISOString(),
    })
    .where(eq(osmRegionImports.slug, slug));

  return {
    slug,
    ok: true,
    detail: "replication not yet implemented in geo service",
  };
}
