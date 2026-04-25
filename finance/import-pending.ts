/**
 * Filesystem dropbox for finance imports.
 *
 * Background: HTTP-driven imports are limited by the gateway timeout
 * (~5 minutes). A real Finanzkraft migration with ~50k transactions
 * runs longer than that, so the upload-and-wait UI flow doesn't work
 * for the initial bulk-load.
 *
 * Pattern: drop a file matching `*.pending.json` into
 * `${FINANCE_IMPORT_DIR}`, the cron picks it up within a few minutes,
 * runs `runImport` directly (no HTTP, no timeout), and renames it:
 *
 *   - on success → `<base>.imported-<timestamp>.json`
 *   - on failure → `<base>.failed-<timestamp>.json`
 *                  + a sibling `<base>.failed-<timestamp>.error.txt`
 *                    with the validation-error list / exception message
 *
 * The `.pending.json` → `.imported-…json` / `.failed-…json` swap means
 * a re-scan only sees the two-suffix `.pending.json` files. The export
 * cron writes to the same directory using a different name pattern
 * (`finance-export-YYYY-MM-DD.json`), so backups can sit next to
 * pending uploads without colliding.
 *
 * `wipe_first: true` is the default so the dropbox is unambiguous: the
 * file *is* the desired finance state; everything previously stored
 * gets replaced. If you want additive imports use the AdminImportView
 * UI instead.
 *
 * Singleton mutex: the cron runs every 5 min and a 50k-tx import takes
 * minutes, so two ticks could overlap. A module-level boolean guards
 * against that — concurrent ticks see `inFlight=true` and bail.
 */

import { readFile, readdir, rename, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { api } from "encore.dev/api";
import { CronJob } from "encore.dev/cron";
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

export const scanPendingImports = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/finance/scan-pending-imports",
  },
  async (): Promise<ScanResult> => {
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
  },
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
      const message = (err as Error).message ?? String(err);
      log.error("scanPendingImports: import failed", {
        file: name,
        err: message,
      });
      try {
        await rename(
          abs,
          path.join(FINANCE_IMPORT_DIR, `${base}.failed-${ts}.json`),
        );
        await writeFile(
          path.join(FINANCE_IMPORT_DIR, `${base}.failed-${ts}.error.txt`),
          message,
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

const _ = new CronJob("finance-import-pending-scan", {
  title: "Pick up dropped finance import files",
  every: "5m",
  endpoint: scanPendingImports,
});
