/**
 * Persistent scan queue for external photo libraries.
 *
 * Mirrors the structure of photo_scan_queue so library scans show up in the
 * same "Scan-Queue" status table as the per-photo ML services. One logical
 * job per (library, active state): the partial unique index
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
 * Reset all failed library scans back to pending. Mirrors the per-photo
 * retry-failed action triggered from Datenverwaltung.
 */
export async function requeueFailedLibraryScans(): Promise<number> {
  const res = await db
    .update(libraryScanQueue)
    .set({
      status: "pending",
      error_msg: null,
      started_at: null,
      finished_at: null,
    })
    .where(eq(libraryScanQueue.status, "failed"));
  const changed = (res as any).rowCount ?? 0;
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
