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

/**
 * One outstanding (pending/processing) job, with just enough about its
 * document to find it in the list. The queue panel only ever showed counts,
 * so a job that never finished was a number with no way to trace it back to
 * a document — the document itself carries no per-service state (`embed`
 * deliberately never touches `documents.status`), so no list filter could
 * reproduce the set either.
 */
export interface QueueJobInfo {
  id: number;
  document_id: number;
  service: DocumentScanService;
  status: DocumentScanStatus;
  priority: number;
  attempts: number;
  defer_count: number;
  enqueued_at: string;
  started_at: string | null;
  /** Last defer/failure reason, if any. */
  error_msg: string | null;
  /** Status of the document itself (`ready`, `pending`, …). */
  document_status: string;
  /** Title (or filename) — null when the caller may not see the document. */
  document_title: string | null;
}

export interface QueueStatus {
  services: QueueServiceStatus[];
  /** Oldest outstanding jobs, oldest first. Capped by `listOutstandingJobs`. */
  jobs: QueueJobInfo[];
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
 * The stage each service has to wait for. A job is only claimable once its
 * upstream service has no outstanding work left for the same document.
 */
const UPSTREAM_SERVICE: Partial<Record<DocumentScanService, DocumentScanService>> = {
  classify: "text_extract",
  embed: "text_extract",
};

/**
 * Atomically claim the next pending job for a service. Uses
 * `FOR UPDATE SKIP LOCKED` so multiple workers never race on the same
 * row. Returns the claimed row or undefined if the queue is empty.
 *
 * Jobs whose upstream stage is still outstanding are skipped rather than
 * claimed-and-deferred. Deferring them is what used to starve the pipeline:
 * a defer bumps `enqueued_at`, so the deferred document moved to the back of
 * the queue, and the worker stopped its tick loop (a deferred job counts as
 * "no work"). With one wake-up per finished text_extract, classify got
 * exactly one attempt per upstream completion — and that attempt always
 * landed on the queue head, i.e. a document text_extract had not reached
 * yet. classify and embed therefore made zero progress until text_extract
 * had drained completely. Skipping in SQL hands the worker the oldest
 * document that is genuinely ready instead.
 */
export async function dequeueNextJob(
  service: DocumentScanService,
): Promise<typeof documentScanQueue.$inferSelect | undefined> {
  const upstream = UPSTREAM_SERVICE[service];
  const upstreamReady = upstream
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM document_scan_queue up
        WHERE up.document_id = q.document_id
          AND up.service = ${upstream}
          AND up.status IN ('pending', 'processing')
      )`
    : sql``;

  const rows = await db.execute<typeof documentScanQueue.$inferSelect>(sql`
    UPDATE document_scan_queue
    SET status = 'processing',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = (
      SELECT q.id FROM document_scan_queue q
      WHERE q.service = ${service}
        AND q.status = 'pending'
        ${upstreamReady}
      ORDER BY q.priority ASC, q.enqueued_at ASC
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
 * How often a single job may be deferred before it is treated as failed.
 *
 * A defer is "come back later", not "this went wrong", so it deliberately
 * does not consume an attempt. Unbounded, that turned every permanent defer
 * condition into an invisible infinite loop: a document whose /embed call
 * keeps timing out, an ai-queue slot that never becomes active, or a stale
 * document status all cycled pending → processing → pending for hours. The
 * queue panel showed "wartend", nothing showed an error, and no document
 * status told the user which document it even was.
 *
 * The budget is generous on purpose — a genuinely transient outage (llm
 * service restarting, model reloading) must not burn through it. With the
 * 30s poll interval, 50 defers span at least ~25 minutes of retrying.
 */
export const MAX_JOB_DEFERS = Math.max(
  1,
  parseInt(process.env.DOC_SCAN_MAX_DEFERS ?? "50", 10) || 50,
);

export interface DeferResult {
  /** Number of defers this job has accumulated, including this one. */
  deferCount: number;
  /** True once the budget is used up — the caller should fail the job. */
  exhausted: boolean;
}

/**
 * Defer a job — reset it to pending without counting the attempt as a
 * failure. `enqueued_at` is bumped so the deferred job moves to the
 * back of the queue (prevents livelock).
 *
 * `reason` is stored in `error_msg` so the reason a job keeps deferring is
 * visible in the queue while it is still pending, not only once it fails.
 */
export async function deferJob(id: number, reason?: string): Promise<DeferResult> {
  const rows = await db
    .update(documentScanQueue)
    .set({
      status: "pending",
      started_at: null,
      enqueued_at: sql`NOW()`,
      attempts: sql`GREATEST(0, attempts - 1)`,
      defer_count: sql`${documentScanQueue.defer_count} + 1`,
      ...(reason !== undefined ? { error_msg: reason } : {}),
    })
    .where(eq(documentScanQueue.id, id))
    .returning({ defer_count: documentScanQueue.defer_count });

  const deferCount = rows[0]?.defer_count ?? 0;
  return { deferCount, exhausted: deferCount >= MAX_JOB_DEFERS };
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

/**
 * True when a queue row for `service` exists for this document in ANY state.
 *
 * `documents.status` is not a reliable "is text extraction still coming"
 * signal: a re-queue sets it to `pending` up-front, and a run that ends
 * without reaching the status update (a crash, a cancelled queue, a
 * services list that omits text_extract) leaves it there permanently. A
 * downstream job that trusts the status alone then defers forever.
 *
 * The queue is the authority. `hasUnfinishedJob` answers "still running";
 * this answers "ever queued", which is what separates a re-queue whose
 * text_extract row is not inserted yet (wait a moment) from a run that is
 * over and produced no text (stop waiting).
 */
export async function hasAnyJob(
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

  // An active row that survived the delete above keeps its id — and would
  // keep a defer budget already spent by the previous run. A re-queue is an
  // explicit "try this again", so hand it a fresh budget.
  await db
    .update(documentScanQueue)
    .set({ defer_count: 0, error_msg: null })
    .where(
      and(
        eq(documentScanQueue.document_id, documentId),
        inArray(documentScanQueue.service, services as DocumentScanService[]),
        inArray(documentScanQueue.status, ["pending", "processing"]),
      ),
    );

  for (const service of services) {
    await db
      .insert(documentScanQueue)
      .values({ document_id: documentId, service, priority })
      .onConflictDoNothing();
  }
}

/** Default cap for `listOutstandingJobs` — enough to spot a stuck tail. */
export const OUTSTANDING_JOBS_LIMIT = 50;

/**
 * The oldest outstanding jobs across all services, oldest first. Used by the
 * queue panel to name the documents behind a stalled counter.
 */
export async function listOutstandingJobs(
  limit = OUTSTANDING_JOBS_LIMIT,
): Promise<QueueJobInfo[]> {
  const rows = await db.execute<QueueJobInfo & Record<string, unknown>>(sql`
    SELECT q.id,
           q.document_id,
           q.service,
           q.status,
           q.priority,
           q.attempts,
           q.defer_count,
           q.enqueued_at,
           q.started_at,
           q.error_msg,
           d.status AS document_status,
           COALESCE(NULLIF(d.title, ''), d.original_filename) AS document_title
    FROM document_scan_queue q
    JOIN documents d ON d.id = q.document_id
    WHERE q.status IN ('pending', 'processing')
    ORDER BY q.enqueued_at ASC, q.id ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r): QueueJobInfo => ({
    ...r,
    attempts: Number(r.attempts),
    defer_count: Number(r.defer_count),
    priority: Number(r.priority),
  }));
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

  return { services: Array.from(map.values()), jobs: await listOutstandingJobs() };
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
    .set({ status: "pending", started_at: null, error_msg: null, defer_count: 0 })
    .where(eq(documentScanQueue.status, "failed"));
  return result.rowCount ?? 0;
}
