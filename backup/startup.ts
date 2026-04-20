/**
 * Startup housekeeping for the backup subsystem.
 *
 * Called once from db/database.ts after the main pool has been created and
 * migrations have run. Three responsibilities:
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
 *   3. Seed host-side hook scripts into $BACKUP_DIR/host-scripts/ so the
 *      TrueNAS SCALE admin finds install-backup-hook.sh, fk-encore-backup.sh
 *      and the matching README on the backup dataset, without having to
 *      clone the fk-encore repo on the host. This is a selective copy:
 *      only the files shipped in the image are overwritten, so the token
 *      file that the installer generates next to the scripts (and any
 *      other operator-owned files) is preserved across container restarts.
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

/**
 * Directory inside the image where Dockerfile.runtime places the three
 * host-side files. If this path does not exist we assume we are not running
 * the production image (e.g. local dev via `encore run`) and skip seeding.
 */
const IMAGE_HOST_SCRIPTS_DIR = "/opt/fk-encore/host-scripts";

/**
 * Files that are considered "container-managed" in $BACKUP_DIR/host-scripts/.
 * Anything NOT in this list that happens to live in the target directory —
 * most importantly the `backup-token` file the installer writes — is left
 * untouched on every container start.
 */
const MANAGED_HOST_SCRIPTS = [
  "install-backup-hook.sh",
  "fk-encore-backup.sh",
  "format-backup-log.sh",
  "README.md",
] as const;

export async function runStartupHousekeeping(): Promise<void> {
  await seedHostScripts();
  await defensiveBackupStop();
  await runPendingRestore();
}

/**
 * Copy the host-side hook scripts shipped in the image onto the backup
 * volume. Safe to run on every container start: only the whitelisted files
 * are touched, so the operator's token file (and any other local files)
 * survive an image upgrade.
 *
 * Any error short of "source missing" is logged but does not block boot.
 */
async function seedHostScripts(): Promise<void> {
  if (!fs.existsSync(IMAGE_HOST_SCRIPTS_DIR)) {
    // Not a production image — nothing to seed. This is the normal case
    // when running from a local checkout.
    return;
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    log.warn("backup.startup.seed-host-scripts.no-backup-dir", {
      dir: BACKUP_DIR,
      detail: "BACKUP_DIR does not exist — host scripts will not be available on the backup volume",
    });
    return;
  }

  const targetDir = path.join(BACKUP_DIR, "host-scripts");
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
  } catch (err: any) {
    log.warn("backup.startup.seed-host-scripts.mkdir-failed", {
      dir: targetDir,
      message: err?.message,
    });
    return;
  }

  for (const name of MANAGED_HOST_SCRIPTS) {
    const src = path.join(IMAGE_HOST_SCRIPTS_DIR, name);
    const dst = path.join(targetDir, name);
    try {
      await fs.promises.copyFile(src, dst);
      // .sh files need to be executable by the host-side root user running
      // the cron job. Node's copyFile preserves mode on most platforms, but
      // be explicit about it.
      if (name.endsWith(".sh")) {
        await fs.promises.chmod(dst, 0o755);
      } else {
        await fs.promises.chmod(dst, 0o644);
      }
    } catch (err: any) {
      log.warn("backup.startup.seed-host-scripts.copy-failed", {
        src,
        dst,
        message: err?.message,
      });
    }
  }

  log.info("backup.startup.seed-host-scripts.ok", {
    dir: targetDir,
    files: [...MANAGED_HOST_SCRIPTS],
  });
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
