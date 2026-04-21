/**
 * One-shot boot-time migration that moves pre-0036 documents from the
 * legacy sha256-shard layout (`<YYYY>/<YYYY-MM>/<sha256>.pdf`) to the
 * speaking `<owner>/<category-path>/<year>/<name>__<hash8>.pdf` layout.
 *
 * Self-guarding: we detect legacy rows via a regex match on `disk_path`.
 * When no row matches, the migration is a no-op — so rerunning on every
 * boot costs at most one indexed query.
 *
 * Idempotent: `relocateDocument` handles "already at the right place"
 * correctly, so a partial run (e.g. server restart mid-migration) is
 * resumed cleanly on the next boot.
 *
 * Fire-and-forget: never blocks service boot. Failures are logged but
 * do not propagate — the worker pipeline is more important than a
 * background relocation.
 */

import { sql } from "drizzle-orm";
import { dbAll } from "../db/adapter";
import { relocateDocument } from "./relocate";

console.log("[boot] documents/layout-migrator.ts: all imports resolved");

/**
 * Postgres regex matching disk paths produced by the old
 * `getDocumentDiskPath(sha256, ext, when)` helper:
 *   …/YYYY/YYYY-MM/<64-hex-sha256>.<ext>
 *
 * The two nested date-like segments are the giveaway; the new layout
 * never produces that pattern because a user-login slug never looks
 * like `YYYY` followed by `YYYY-MM/<sha256>`.
 */
const LEGACY_PATH_RE = `/[0-9]{4}/[0-9]{4}-[0-9]{2}/[a-f0-9]{64}\\.[a-z0-9]+$`;

let inFlight: Promise<void> | null = null;

/**
 * Run the migration if there are any legacy-layout documents.
 * Calling this more than once in the same process returns the same
 * in-flight promise — callers don't need to deduplicate.
 */
export function migrateLegacyLayoutOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runMigration().catch((err) => {
    console.error("[documents] layout-migrator: run failed:", err);
  });
  return inFlight;
}

async function runMigration(): Promise<void> {
  const rows = await dbAll<{ id: number }>(
    sql`
      SELECT id
      FROM documents
      WHERE disk_path ~ ${LEGACY_PATH_RE}
      ORDER BY id ASC
    `,
  );

  if (rows.length === 0) {
    // Nothing to do — either a fresh install or a previously-completed
    // migration. Stay quiet to avoid noise on every restart.
    return;
  }

  console.log(
    `[documents] layout-migrator: relocating ${rows.length} legacy-layout document(s)`,
  );

  let relocated = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await relocateDocument(r.id);
      relocated += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[documents] layout-migrator: relocate(${r.id}) failed: ${(err as Error).message}`,
      );
    }
  }

  console.log(
    `[documents] layout-migrator: done — relocated=${relocated} failed=${failed}`,
  );
}
