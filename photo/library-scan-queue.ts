/**
 * Persistent scan queue for external photo libraries.
 *
 * One logical job per (library, active state): the partial unique index
 * `uq_active_library_scan` prevents two overlapping jobs for the same
 * library from being queued.
 */

import { eq, sql, and, inArray } from "drizzle-orm";
import db from "../db/database";
import { libraryScanQueue } from "../db/schema";
import type { ScanReport } from "./libraries.service";
import { notifyScanQueueChanged } from "./scan-queue-events";
import { abortAllLibraryScans } from "./library-scan-control";

console.log("[boot] photo/library-scan-queue.ts: all imports resolved");

export interface LibraryScanQueueStatus {
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export interface ActiveLibraryScan {
  status: "pending" | "processing" | "failed";
  reconcile: boolean;
  scanned: number | null;
  imported: number | null;
  errors: number | null;
  error_msg: string | null;
}

/**
 * Enqueue a scan for the given library. Returns the new job id, or null if
 * a scan for this library is already pending or processing (the partial
 * unique index makes the insert a no-op in that case).
 */
export async function enqueueLibraryScan(
  libraryId: number,
  reconcile: boolean = false,
): Promise<number | null> {
  const rows = await db
    .insert(libraryScanQueue)
    .values({ library_id: libraryId, reconcile })
    .onConflictDoNothing()
    .returning({ id: libraryScanQueue.id });
  if (rows[0]) notifyScanQueueChanged();
  return rows[0]?.id ?? null;
}

/**
 * Atomically claim the next pending library scan job. FOR UPDATE SKIP LOCKED
 * keeps multiple workers safe even though we currently only run one.
 */
export async function dequeueNextLibraryScan(): Promise<
  typeof libraryScanQueue.$inferSelect | undefined
> {
  const rows = await db.execute<typeof libraryScanQueue.$inferSelect>(sql`
    UPDATE library_scan_queue
    SET status = 'processing',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM library_scan_queue
      WHERE status = 'pending'
      ORDER BY enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  if (rows.rows[0]) notifyScanQueueChanged();
  return rows.rows[0];
}

export async function markLibraryScanDone(
  id: number,
  report: ScanReport,
  removed: number | null,
): Promise<void> {
  await db
    .update(libraryScanQueue)
    .set({
      status: "done",
      finished_at: sql`NOW()`,
      scanned: report.scanned,
      imported: report.imported,
      skipped_duplicate: report.skipped_duplicate,
      skipped_unsupported: report.skipped_unsupported,
      skipped_empty: report.skipped_empty,
      errors: report.errors,
      removed,
    })
    .where(eq(libraryScanQueue.id, id));
  notifyScanQueueChanged();
}

/**
 * Live progress write while the job is still 'processing'. Called from
 * scanLibrary every few hundred ms so the Datenverwaltung UI can show
 * current scanned/imported counts instead of just "1 läuft".
 */
export async function updateLibraryScanProgress(
  id: number,
  report: ScanReport,
): Promise<void> {
  await db
    .update(libraryScanQueue)
    .set({
      scanned: report.scanned,
      imported: report.imported,
      skipped_duplicate: report.skipped_duplicate,
      skipped_unsupported: report.skipped_unsupported,
      skipped_empty: report.skipped_empty,
      errors: report.errors,
    })
    .where(eq(libraryScanQueue.id, id));
  notifyScanQueueChanged();
}

export async function markLibraryScanFailed(id: number, error: string): Promise<void> {
  await db
    .update(libraryScanQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(libraryScanQueue.id, id));
  notifyScanQueueChanged();
}

/**
 * Aggregate counts across all libraries, mirroring the shape returned by
 * getQueueStatus() so the frontend can render it as another row in the
 * scan-worker status table.
 */
export async function getLibraryScanStatus(): Promise<LibraryScanQueueStatus> {
  const rows = await db.execute<{ status: string; count: string }>(sql`
    SELECT status, COUNT(*)::int as count
    FROM library_scan_queue
    GROUP BY status
  `);
  const status: LibraryScanQueueStatus = { pending: 0, processing: 0, failed: 0, done: 0 };
  for (const row of rows.rows) {
    const key = row.status as keyof LibraryScanQueueStatus;
    if (key in status) status[key] = Number(row.count);
  }
  return status;
}

/**
 * Reset failed library scans back to pending. Mirrors the per-photo
 * retry-failed action triggered from Datenverwaltung.
 *
 * The partial unique index `uq_active_library_scan` only allows one
 * pending/processing row per library, so a naive bulk UPDATE blows up with
 * "duplicate key value violates unique constraint" whenever a library has
 * more than one failed row, or has a fresh pending/processing row alongside
 * historical failures (issue #323). We therefore:
 *   1. Skip failures whose library already has an active sibling — that
 *      job is the canonical retry, the failed row is just history.
 *   2. For libraries with multiple failed rows, only flip the newest one
 *      back to pending; older ones stay as `failed` to preserve audit
 *      history.
 */
export async function requeueFailedLibraryScans(): Promise<number> {
  const res = await db.execute<{ id: number }>(sql`
    WITH candidates AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY library_id ORDER BY enqueued_at DESC, id DESC
             ) AS rn
      FROM library_scan_queue
      WHERE status = 'failed'
        AND library_id NOT IN (
          SELECT library_id FROM library_scan_queue
          WHERE status IN ('pending', 'processing')
        )
    )
    UPDATE library_scan_queue
    SET status = 'pending',
        error_msg = NULL,
        started_at = NULL,
        finished_at = NULL
    WHERE id IN (SELECT id FROM candidates WHERE rn = 1)
    RETURNING id
  `);
  const changed = res.rows.length;
  if (changed > 0) notifyScanQueueChanged();
  return changed;
}

/**
 * Cancel queued library scans:
 *   1. Drop all 'pending' rows (they never started).
 *   2. Signal any in-flight scans via the abort registry; the worker catches
 *      the resulting ScanCancelledError and marks the row failed, so the UI's
 *      `isActive` flips back to false instead of waiting forever.
 *
 * Note: a hung filesystem read inside a single importFile() call is not
 * interrupted — the abort is only checked between files.
 */
export async function cancelPendingLibraryScans(): Promise<number> {
  const res = await db
    .delete(libraryScanQueue)
    .where(eq(libraryScanQueue.status, "pending"));
  const deleted = (res as any).rowCount ?? 0;
  const aborted = abortAllLibraryScans();
  if (deleted > 0 || aborted > 0) notifyScanQueueChanged();
  return deleted + aborted;
}

/**
 * Reset jobs that were 'processing' when the server stopped — the worker
 * will pick them up again.
 */
export async function resetStuckLibraryScans(): Promise<void> {
  await db
    .update(libraryScanQueue)
    .set({ status: "pending", started_at: null })
    .where(eq(libraryScanQueue.status, "processing"));
  notifyScanQueueChanged();
}

/**
 * Return the most-relevant active scan per library. Priority: processing >
 * pending > failed. Only non-done rows are returned so libraries with no
 * active job are absent from the map.
 */
export async function getActiveScanPerLibrary(): Promise<Map<number, ActiveLibraryScan>> {
  const rows = await db.execute<{
    library_id: number;
    status: string;
    reconcile: boolean;
    scanned: number | null;
    imported: number | null;
    errors: number | null;
    error_msg: string | null;
  }>(sql`
    SELECT DISTINCT ON (library_id)
      library_id, status, reconcile, scanned, imported, errors, error_msg
    FROM library_scan_queue
    WHERE status IN ('pending', 'processing', 'failed')
    ORDER BY library_id,
      CASE status
        WHEN 'processing' THEN 0
        WHEN 'pending'    THEN 1
        WHEN 'failed'     THEN 2
      END,
      enqueued_at DESC
  `);
  const map = new Map<number, ActiveLibraryScan>();
  for (const row of rows.rows) {
    map.set(row.library_id, {
      status: row.status as "pending" | "processing" | "failed",
      reconcile: row.reconcile,
      scanned: row.scanned,
      imported: row.imported,
      errors: row.errors,
      error_msg: row.error_msg,
    });
  }
  return map;
}
