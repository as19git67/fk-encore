/**
 * Filesystem dropbox for finance imports.
 *
 * Background: HTTP-driven imports are limited by the gateway timeout
 * (~5 minutes). A real Finanzkraft migration with ~50k transactions
 * runs longer than that, so the upload-and-wait UI flow doesn't work
 * for the initial bulk-load.
 *
 * Pattern: drop a file matching `*.pending.json` into
 * `${FINANCE_IMPORT_DIR}`. A chokidar watcher picks the file up the
 * moment its size has been stable for `STABILITY_MS`, runs `runImport`
 * directly (no HTTP, no gateway timeout), and renames it:
 *
 *   - on success → `<base>.imported-<timestamp>.json`
 *   - on failure → `<base>.failed-<timestamp>.json`
 *                  + a sibling `<base>.failed-<timestamp>.error.txt`
 *                    with the validation-error list / exception message
 *
 * The `.pending.json` → `.imported-…json` / `.failed-…json` swap means
 * the watcher only reacts to new two-suffix `.pending.json` files. The
 * export cron writes to the same directory using a different name
 * pattern (`finance-export-YYYY-MM-DD.json`), so backups can sit next
 * to pending uploads without colliding.
 *
 * `wipe_first: true` is hardcoded so the dropbox is unambiguous: the
 * file *is* the desired finance state; everything previously stored
 * gets replaced.
 *
 * Why a chokidar watcher: Encore.ts CronJobs don't fire in self-host
 * docker (see lib/local-cron.ts). For a filesystem-event source we
 * don't need a polling tick at all — chokidar gives us live pickup
 * the moment a file lands. Same pattern as `documents/inbox-watcher.ts`.
 * The internal HTTP endpoint stays as a manual-trigger surface
 * (`curl POST /internal/finance/scan-pending-imports`).
 *
 * Singleton mutex: a 50k-tx import takes minutes, so a second drop
 * arriving mid-flight could fire `processPending()` again. A module-
 * level boolean guards against that — concurrent invocations see
 * `inFlight=true` and bail out.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, rename, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { api } from "encore.dev/api";
import log from "encore.dev/log";

import { runImport } from "./data-import";

console.log("[boot] finance/import-pending.ts: all imports resolved");

// -----------------------------------------------------------------------

export const FINANCE_IMPORT_DIR =
  process.env.FINANCE_IMPORT_DIR ?? "/data/finance-import";

const PENDING_SUFFIX = ".pending.json";

let inFlight = false;

interface ScanResult {
  scanned: number;
  imported: number;
  failed: number;
  skipped_locked: boolean;
}

/**
 * Singleton-mutex wrapper around `processPending()` shared by the API
 * endpoint, the CronJob, and the chokidar watcher. Pulled out so the
 * watcher can invoke it as a plain function without going through the
 * Encore RPC surface.
 */
async function runScan(): Promise<ScanResult> {
  if (inFlight) {
    log.info("scanPendingImports: previous tick still running, skipping");
    return { scanned: 0, imported: 0, failed: 0, skipped_locked: true };
  }
  inFlight = true;
  try {
    return await processPending();
  } finally {
    inFlight = false;
  }
}

export const scanPendingImports = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/finance/scan-pending-imports",
  },
  async (): Promise<ScanResult> => runScan(),
);

async function processPending(): Promise<ScanResult> {
  await mkdir(FINANCE_IMPORT_DIR, { recursive: true });

  let entries: string[];
  try {
    entries = await readdir(FINANCE_IMPORT_DIR);
  } catch (err) {
    log.error("scanPendingImports: cannot list import dir", {
      dir: FINANCE_IMPORT_DIR,
      err: (err as Error).message,
    });
    return { scanned: 0, imported: 0, failed: 0, skipped_locked: false };
  }

  // Match only `*.pending.json` and only regular files. Sort
  // lexicographically so the user can prefix with a timestamp to
  // control order within a batch (e.g. `2026-04-25-step1.pending.json`).
  const candidates: string[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(PENDING_SUFFIX)) continue;
    const abs = path.join(FINANCE_IMPORT_DIR, name);
    try {
      const s = await stat(abs);
      if (s.isFile()) candidates.push(name);
    } catch {
      // Vanished between readdir + stat — fine, skip.
    }
  }

  let imported = 0;
  let failed = 0;
  for (const name of candidates) {
    const abs = path.join(FINANCE_IMPORT_DIR, name);
    // Filename without the .pending.json suffix — the basis for the
    // rename target.
    const base = name.slice(0, -PENDING_SUFFIX.length);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      const raw = await readFile(abs, "utf8");
      const parsed = JSON.parse(raw);
      // wipe_first=true — the dropbox semantic is "this file IS the
      // finance state". The HTTP path uses the explicit checkbox.
      const result = await runImport({ export: parsed, wipe_first: true });
      const targetAbs = path.join(
        FINANCE_IMPORT_DIR,
        `${base}.imported-${ts}.json`,
      );
      await rename(abs, targetAbs);
      log.info("scanPendingImports: file imported", {
        file: name,
        counts: result.counts,
        skipped: result.skipped,
        errors: result.errors.length,
      });
      // Validation errors don't fail the import — they're per-row and
      // the rest still landed. Drop a sibling `.errors.json` so the
      // user can inspect without grepping server logs.
      if (result.errors.length > 0) {
        await writeFile(
          path.join(
            FINANCE_IMPORT_DIR,
            `${base}.imported-${ts}.errors.json`,
          ),
          JSON.stringify(result.errors, null, 2),
          "utf8",
        );
      }
      imported++;
    } catch (err) {
      const baseMessage = (err as Error).message ?? String(err);
      // EACCES on read is the most common operator footgun: file
      // dropped via host with non-apps ownership. Pull the actual
      // mode/owner so the .error.txt explains it without grepping
      // through container logs.
      let message = baseMessage;
      if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
        try {
          const s = await stat(abs);
          message =
            `${baseMessage}\n\n` +
            `File owner uid=${s.uid} gid=${s.gid} mode=${(s.mode & 0o777).toString(8)}.\n` +
            `Container runs as uid=568 gid=568 (apps user).\n` +
            `Fix on the host: chown 568:568 "${name}" && chmod g+r "${name}"\n` +
            `or copy with the apps user (sudo -u apps install -m 0640 ...).\n`;
        } catch {
          // stat failure is rare here; keep the original message.
        }
      }
      log.error("scanPendingImports: import failed", {
        file: name,
        err: baseMessage,
      });
      try {
        await rename(
          abs,
          path.join(FINANCE_IMPORT_DIR, `${base}.failed-${ts}.json`),
        );
        await writeFile(
          path.join(FINANCE_IMPORT_DIR, `${base}.failed-${ts}.error.txt`),
          // Trailing newline so `cat <file>` doesn't run the message
          // into the next shell prompt.
          message.endsWith("\n") ? message : `${message}\n`,
          "utf8",
        );
      } catch (renameErr) {
        log.error("scanPendingImports: cannot move failed file", {
          file: name,
          err: (renameErr as Error).message,
        });
      }
      failed++;
    }
  }

  return {
    scanned: candidates.length,
    imported,
    failed,
    skipped_locked: false,
  };
}

// -----------------------------------------------------------------------
// chokidar watcher (real-time pickup; primary trigger for the dropbox)
// -----------------------------------------------------------------------

let watcher: FSWatcher | null = null;

/**
 * `awaitWriteFinish` window. Operators copy export files into the
 * dropbox via `cp` / `rsync` / a docker volume mount; for a 50 MB JSON
 * the write takes a few hundred ms, so 5 s of stability is plenty
 * without making the user wait long after the copy.
 */
const STABILITY_MS = parseInt(
  process.env.FINANCE_IMPORT_STABILITY_MS ?? "5000",
  10,
);

/**
 * Polling escape hatch for filesystems where inotify doesn't fire
 * (some bind-mount / network setups). Disabled by default — the
 * documents-inbox and photo-library watchers run on inotify in this
 * deployment and work, so finance-import does the same. Set
 * `FINANCE_IMPORT_POLLING=true` if you ever land on a host where the
 * other two watchers also turn out to be flaky.
 */
const USE_POLLING = (process.env.FINANCE_IMPORT_POLLING ?? "false") === "true";
const POLL_INTERVAL_MS = parseInt(
  process.env.FINANCE_IMPORT_POLL_INTERVAL_MS ?? "2000",
  10,
);

function isPending(file: string): boolean {
  return file.endsWith(PENDING_SUFFIX);
}

/**
 * Boot the dropbox watcher. Idempotent — subsequent calls are no-ops.
 *
 * - mkdir -p the dropbox so a fresh container with an empty bind-mount
 *   doesn't make chokidar throw.
 * - Run one full scan immediately so files dropped while the container
 *   was down get picked up at boot, instead of waiting for the next
 *   filesystem event (which never arrives for stale files).
 * - Subscribe to chokidar `add` events for live pickup.
 */
export async function startFinanceImportWatcher(): Promise<void> {
  if (watcher) return;

  // Use plain console.log here too: if structured `log.info` ever gets
  // filtered or routed weirdly, we still see the boot trace in stdout.
  console.log(
    `[finance.import-watcher] starting, dir=${FINANCE_IMPORT_DIR} polling=${USE_POLLING} interval=${POLL_INTERVAL_MS}ms`,
  );

  try {
    await mkdir(FINANCE_IMPORT_DIR, { recursive: true });
  } catch (err) {
    console.error(
      `[finance.import-watcher] cannot create import dir ${FINANCE_IMPORT_DIR}: ${(err as Error).message}`,
    );
    log.error("startFinanceImportWatcher: cannot create import dir", {
      dir: FINANCE_IMPORT_DIR,
      err: (err as Error).message,
    });
    return;
  }

  if (!existsSync(FINANCE_IMPORT_DIR)) {
    console.warn(
      `[finance.import-watcher] dir missing after mkdir, skipping: ${FINANCE_IMPORT_DIR}`,
    );
    log.warn("startFinanceImportWatcher: dir missing after mkdir, skipping", {
      dir: FINANCE_IMPORT_DIR,
    });
    return;
  }

  // Boot scan: pick up `.pending.json` files that were dropped while
  // the container was offline. chokidar runs with `ignoreInitial: true`
  // below (default false would also work, but we want a single explicit
  // batched scan here instead of N independent add events at boot).
  try {
    const result = await runScan();
    console.log(
      `[finance.import-watcher] boot scan done: scanned=${result.scanned} imported=${result.imported} failed=${result.failed}`,
    );
    if (result.scanned > 0) {
      log.info("startFinanceImportWatcher: boot scan done", result);
    }
  } catch (err) {
    console.error(
      `[finance.import-watcher] boot scan failed: ${(err as Error).message}`,
    );
    log.error("startFinanceImportWatcher: boot scan failed", {
      err: (err as Error).message,
    });
  }

  watcher = chokidar.watch(FINANCE_IMPORT_DIR, {
    ignored: (p, stats) => {
      const base = path.basename(p);
      if (base.startsWith(".")) return true;
      if (stats?.isFile()) return !isPending(p);
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    usePolling: USE_POLLING,
    interval: POLL_INTERVAL_MS,
    binaryInterval: POLL_INTERVAL_MS,
    awaitWriteFinish: { stabilityThreshold: STABILITY_MS, pollInterval: 500 },
  });

  watcher.on("add", (file) => {
    console.log(
      `[finance.import-watcher] pending file detected: ${path.basename(file)}`,
    );
    log.info("financeImportWatcher: pending file detected", {
      file: path.basename(file),
    });
    // Same singleton-mutex path as the cron and HTTP endpoint —
    // runScan() handles whatever's in the dir, not a single file, so
    // concurrent adds collapse to one scan.
    runScan().catch((err) =>
      log.error("financeImportWatcher: scan failed", {
        err: (err as Error).message,
      }),
    );
  });
  watcher.on("error", (err) => {
    console.error(
      `[finance.import-watcher] chokidar error: ${(err as Error).message}`,
    );
    log.error("financeImportWatcher: chokidar error", {
      err: (err as Error).message,
    });
  });
  watcher.on("ready", () => {
    console.log("[finance.import-watcher] watcher ready");
  });

  console.log(
    `[finance.import-watcher] watching ${FINANCE_IMPORT_DIR} (stability=${STABILITY_MS}ms)`,
  );
  log.info("financeImportWatcher: watching", {
    dir: FINANCE_IMPORT_DIR,
    stability_ms: STABILITY_MS,
    polling: USE_POLLING,
  });
}

export async function stopFinanceImportWatcher(): Promise<void> {
  if (!watcher) return;
  await watcher.close();
  watcher = null;
}
