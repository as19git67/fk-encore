/**
 * Persistent scan-queue helpers for the documents module.
 *
 * Three services are chained per document:
 *   text_extract → classify → embed
 *
 * The chain is expressed declaratively (see DOCUMENT_SERVICES) and the
 * worker dequeues jobs per service — if `classify` runs before
 * `text_extract` is done it simply defers.
 *
 * All rows belong to a single document and the partial unique index
 * `uq_active_document_scan` (see migration 0025_documents.sql)
 * prevents duplicate active jobs for (document_id, service).
 */

import { and, eq, sql, inArray } from "drizzle-orm";
import db from "../db/database";
import { documentScanQueue } from "../db/schema";

export type DocumentScanService = "text_extract" | "classify" | "embed" | "receipt_ocr";
export type DocumentScanStatus = "pending" | "processing" | "failed" | "done";

/** Services processed for every document, in dependency order. */
export const DOCUMENT_SERVICES: readonly DocumentScanService[] = [
  "text_extract",
  "classify",
  "embed",
] as const;

/** Every worker represented in queue status, including specialised jobs. */
export const DOCUMENT_QUEUE_SERVICES: readonly DocumentScanService[] = [
  ...DOCUMENT_SERVICES,
  "receipt_ocr",
] as const;

/**
 * Thrown by a job handler to signal "not ready yet — put me back in the
 * queue". The worker resets the job to pending without counting the
 * attempt as a failure.
 */
export class DeferJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DeferJobError";
  }
}

export interface QueueServiceStatus {
  service: DocumentScanService;
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export interface QueueStatus {
  services: QueueServiceStatus[];
}

/**
 * Enqueue a document for all configured services. Safe to call more
 * than once — duplicate active rows are prevented by
 * `uq_active_document_scan`.
 */
export async function enqueueDocumentScan(
  documentId: number,
  services: readonly DocumentScanService[] = DOCUMENT_SERVICES,
  priority = 2,
): Promise<void> {
  if (services.length === 0) return;

  for (const service of services) {
    await db
      .insert(documentScanQueue)
      .values({ document_id: documentId, service, priority })
      .onConflictDoNothing();
  }
}

/**
 * Atomically claim the next pending job for a service. Uses
 * `FOR UPDATE SKIP LOCKED` so multiple workers never race on the same
 * row. Returns the claimed row or undefined if the queue is empty.
 */
export async function dequeueNextJob(
  service: DocumentScanService,
): Promise<typeof documentScanQueue.$inferSelect | undefined> {
  const rows = await db.execute<typeof documentScanQueue.$inferSelect>(sql`
    UPDATE document_scan_queue
    SET status = 'processing',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM document_scan_queue
      WHERE service = ${service}
        AND status = 'pending'
      ORDER BY priority ASC, enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return rows.rows[0];
}

export async function markJobDone(id: number): Promise<void> {
  await db
    .update(documentScanQueue)
    .set({ status: "done", finished_at: sql`NOW()` })
    .where(eq(documentScanQueue.id, id));
}

/**
 * Defer a job — reset it to pending without counting the attempt as a
 * failure. `enqueued_at` is bumped so the deferred job moves to the
 * back of the queue (prevents livelock).
 */
export async function deferJob(id: number): Promise<void> {
  await db
    .update(documentScanQueue)
    .set({
      status: "pending",
      started_at: null,
      enqueued_at: sql`NOW()`,
      attempts: sql`GREATEST(0, attempts - 1)`,
    })
    .where(eq(documentScanQueue.id, id));
}

export async function markJobFailed(id: number, error: string): Promise<void> {
  await db
    .update(documentScanQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(documentScanQueue.id, id));
}

/**
 * True while `service` still has work outstanding for this document — the job
 * is queued or currently running.
 *
 * The pipeline stages run in independent workers, so a re-queue puts
 * text_extract and classify in flight at the same time. On a RE-run the
 * document already carries `extracted_text`, so classify no longer defers on
 * empty text and can overtake text_extract — classifying stale text and then
 * having its "ready" status overwritten by the text_extract that lands after
 * it. Callers use this to hold a later stage back until the earlier one is
 * really done.
 */
export async function hasUnfinishedJob(
  documentId: number,
  service: DocumentScanService,
): Promise<boolean> {
  const row = await db
    .select({ id: documentScanQueue.id })
    .from(documentScanQueue)
    .where(
      and(
        eq(documentScanQueue.document_id, documentId),
        eq(documentScanQueue.service, service),
        inArray(documentScanQueue.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/** Delete all scan-queue entries for a document (used when the document is deleted). */
export async function deleteJobsForDocument(documentId: number): Promise<void> {
  await db
    .delete(documentScanQueue)
    .where(eq(documentScanQueue.document_id, documentId));
}

/** Re-queue all services for a document — used by `POST /documents/:id/reclassify`. */
export async function requeueDocument(
  documentId: number,
  services: readonly DocumentScanService[] = DOCUMENT_SERVICES,
  priority = 2,
): Promise<void> {
  // Drop any previously-failed or done rows so the partial unique index
  // does not prevent the new insert. Active (pending/processing) rows
  // are left alone — they will be handled by the worker shortly.
  await db
    .delete(documentScanQueue)
    .where(
      and(
        eq(documentScanQueue.document_id, documentId),
        inArray(documentScanQueue.service, services as DocumentScanService[]),
        inArray(documentScanQueue.status, ["failed", "done"]),
      ),
    );

  for (const service of services) {
    await db
      .insert(documentScanQueue)
      .values({ document_id: documentId, service, priority })
      .onConflictDoNothing();
  }
}

/** Aggregate queue counts across all services. */
export async function getQueueStatus(): Promise<QueueStatus> {
  const rows = await db.execute<{
    service: DocumentScanService;
    status: DocumentScanStatus;
    count: string;
  }>(sql`
    SELECT service, status, COUNT(*)::int as count
    FROM document_scan_queue
    GROUP BY service, status
  `);

  const map = new Map<DocumentScanService, QueueServiceStatus>();
  for (const svc of DOCUMENT_QUEUE_SERVICES) {
    map.set(svc, { service: svc, pending: 0, processing: 0, failed: 0, done: 0 });
  }
  for (const row of rows.rows) {
    const entry = map.get(row.service);
    if (entry) entry[row.status] = Number(row.count);
  }

  return { services: Array.from(map.values()) };
}

/**
 * Reset stuck `processing` jobs to `pending` on service restart. Called
 * once at worker boot. Without this a crash mid-job would leave the
 * queue row stuck forever.
 */
export async function resetStuckJobs(): Promise<void> {
  await db
    .update(documentScanQueue)
    .set({ status: "pending", started_at: null })
    .where(eq(documentScanQueue.status, "processing"));
}

/** Cancel all pending jobs. Returns the number of cancelled rows. */
export async function cancelPendingJobs(): Promise<number> {
  const result = await db
    .delete(documentScanQueue)
    .where(eq(documentScanQueue.status, "pending"));
  return result.rowCount ?? 0;
}

/** Retry all failed jobs by resetting them to pending. Returns the count. */
export async function retryFailedJobs(): Promise<number> {
  const result = await db
    .update(documentScanQueue)
    .set({ status: "pending", started_at: null, error_msg: null })
    .where(eq(documentScanQueue.status, "failed"));
  return result.rowCount ?? 0;
}
