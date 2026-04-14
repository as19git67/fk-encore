/**
 * Startup housekeeping for the backup subsystem.
 *
 * Called once from db/database.ts after the main pool has been created and
 * migrations have run. Two responsibilities:
 *
 *   1. Defensive pg_backup_stop() — if the previous process crashed while
 *      holding pg_backup_start, the cluster would still be in backup mode
 *      and WAL would accumulate indefinitely. We issue a best-effort stop
 *      on every boot; if the cluster was not in backup mode, Postgres
 *      raises 55000 which we silently swallow.
 *
 *   2. Pending-restore check — if $BACKUP_DIR contains a file matching
 *      `restore-*.dump`, we:
 *        a. Write a safety dump of the current DB to
 *           $BACKUP_DIR/pre-restore-<ISO-timestamp>.dump so the operator
 *           can roll back the rollback.
 *        b. pg_restore from the file (--clean --if-exists overwrites).
 *        c. Rename the trigger file from `restore-*.dump` to
 *           `restored-*.dump` so the next boot does not redo the restore.
 *
 * In-memory backup-mode state is always reset to idle on boot because the
 * state lives in the old process and dies with it. Services (incl. scan
 * workers) therefore come up in normal mode regardless of what happened
 * before the restart.
 */

import fs from "fs";
import path from "path";
import log from "encore.dev/log";
import { getBackupPool } from "./pool";
import { pgDump, pgRestore } from "./pg-dump";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/mnt/backup";

export async function runStartupHousekeeping(): Promise<void> {
  await defensiveBackupStop();
  await runPendingRestore();
}

async function defensiveBackupStop(): Promise<void> {
  try {
    const pool = getBackupPool();
    await pool.query("SELECT pg_backup_stop()");
    log.warn("backup.startup.previous-backup-stopped", {
      detail: "pg_backup_stop succeeded — the cluster was left in backup mode by a previous process",
    });
  } catch (err: any) {
    // 55000 = object_not_in_prerequisite_state — expected when the
    // cluster is NOT in backup mode (the normal case).
    if (err?.code !== "55000") {
      log.warn("backup.startup.pg_backup_stop.error", { message: err?.message });
    }
  }
}

async function runPendingRestore(): Promise<void> {
  if (!fs.existsSync(BACKUP_DIR)) return;

  let entries: string[];
  try {
    entries = await fs.promises.readdir(BACKUP_DIR);
  } catch (err: any) {
    log.warn("backup.startup.readdir-failed", { dir: BACKUP_DIR, message: err?.message });
    return;
  }

  const candidates = entries.filter((f) => /^restore-.+\.dump$/.test(f)).sort();
  if (candidates.length === 0) return;

  if (candidates.length > 1) {
    log.warn("backup.startup.multiple-restore-files", {
      files: candidates,
      chosen: candidates[candidates.length - 1],
      detail: "using the lexicographically last file; rename the others to avoid ambiguity",
    });
  }

  const trigger = candidates[candidates.length - 1];
  const triggerPath = path.join(BACKUP_DIR, trigger);
  const safetyDump = path.join(
    BACKUP_DIR,
    `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`,
  );

  log.warn("backup.startup.restore-pending", { trigger: triggerPath, safetyDump });

  // 1. Safety dump of the current DB before we overwrite it.
  try {
    await pgDump(safetyDump);
    log.info("backup.startup.safety-dump.ok", { file: safetyDump });
  } catch (err: any) {
    log.error(err, "backup.startup.safety-dump.failed", {
      detail: "refusing to restore without a safety dump — rename the trigger file to unblock",
      trigger: triggerPath,
    });
    return;
  }

  // 2. Restore from the trigger file.
  try {
    await pgRestore(triggerPath);
    log.info("backup.startup.restore.ok", { from: triggerPath });
  } catch (err: any) {
    log.error(err, "backup.startup.restore.failed", {
      from: triggerPath,
      detail: "the safety dump is available at " + safetyDump,
    });
    return;
  }

  // 3. Mark the trigger file as processed so we do not redo the restore
  //    on the next boot. We rename rather than delete to give the operator
  //    a chance to audit what was applied.
  const restored = triggerPath.replace(/(^|\/)restore-/, "$1restored-");
  try {
    await fs.promises.rename(triggerPath, restored);
    log.info("backup.startup.restore.marker-renamed", { from: triggerPath, to: restored });
  } catch (err: any) {
    log.error(err, "backup.startup.restore.rename-failed", {
      from: triggerPath,
      detail: "manually rename the file to avoid a repeat restore on the next boot",
    });
  }
}
