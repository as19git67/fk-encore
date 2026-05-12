/**
 * Persistent queue for AI tag suggestions on finance transactions.
 * Follows the same pattern as photo/scan-queue.ts and
 * documents/scan-queue.ts: one row per pending job, atomic dequeue
 * via FOR UPDATE SKIP LOCKED, WebSocket fan-out after every mutation.
 */

import { eq, and, sql } from "drizzle-orm";
import db from "../db/database";
import { financeTagQueue } from "../db/schema";
import { notifyFinanceTagQueueChanged } from "./tag-queue-events";

export type TagQueueStatus = "pending" | "processing" | "failed" | "done";

export interface TagQueueServiceStatus {
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export class DeferTagJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DeferTagJobError";
  }
}

/**
 * Enqueue a transaction for AI tag suggestion.
 * Uses ON CONFLICT DO NOTHING on the partial unique index so a
 * transaction already pending/processing is not duplicated.
 */
export async function enqueueTagSuggestion(
  transactionId: number,
  userId?: number,
  priority = 2,
): Promise<void> {
  await db
    .insert(financeTagQueue)
    .values({ transaction_id: transactionId, user_id: userId ?? null, priority })
    .onConflictDoNothing();
  notifyFinanceTagQueueChanged();
}

/**
 * Atomically claim the next pending job.
 * Returns undefined when the queue is empty.
 */
export async function dequeueNextTagJob(): Promise<
  typeof financeTagQueue.$inferSelect | undefined
> {
  const rows = await db.execute<typeof financeTagQueue.$inferSelect>(sql`
    UPDATE finance_tag_queue
    SET status     = 'processing',
        started_at = NOW(),
        attempts   = attempts + 1
    WHERE id = (
      SELECT id FROM finance_tag_queue
      WHERE status = 'pending'
      ORDER BY priority ASC, enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const job = rows.rows[0];
  if (job) notifyFinanceTagQueueChanged();
  return job;
}

export async function markTagJobDone(id: number): Promise<void> {
  await db
    .update(financeTagQueue)
    .set({ status: "done", finished_at: sql`NOW()` })
    .where(eq(financeTagQueue.id, id));
  notifyFinanceTagQueueChanged();
}

export async function markTagJobFailed(id: number, error: string): Promise<void> {
  await db
    .update(financeTagQueue)
    .set({ status: "failed", error_msg: error, finished_at: sql`NOW()` })
    .where(eq(financeTagQueue.id, id));
  notifyFinanceTagQueueChanged();
}

export async function deferTagJob(id: number): Promise<void> {
  await db
    .update(financeTagQueue)
    .set({
      status: "pending",
      started_at: null,
      enqueued_at: sql`NOW()`,
      attempts: sql`GREATEST(0, attempts - 1)`,
    })
    .where(eq(financeTagQueue.id, id));
  notifyFinanceTagQueueChanged();
}

/** Aggregate queue counts (global — not per-user, admin sees all). */
export async function getTagQueueStatus(): Promise<TagQueueServiceStatus> {
  const rows = await db.execute<{ status: TagQueueStatus; count: string }>(sql`
    SELECT status, COUNT(*)::int AS count
    FROM finance_tag_queue
    GROUP BY status
  `);
  const result: TagQueueServiceStatus = { pending: 0, processing: 0, failed: 0, done: 0 };
  for (const row of rows.rows) {
    result[row.status] = Number(row.count);
  }
  return result;
}

/** Reset all failed jobs back to pending. */
export async function requeueFailedTagJobs(): Promise<number> {
  const result = await db
    .update(financeTagQueue)
    .set({ status: "pending", priority: 3, error_msg: null, started_at: null, finished_at: null })
    .where(eq(financeTagQueue.status, "failed"));
  const changed = (result as any).rowCount ?? 0;
  if (changed > 0) notifyFinanceTagQueueChanged();
  return changed;
}

/** Delete all pending jobs (processing jobs finish naturally). */
export async function cancelPendingTagJobs(): Promise<number> {
  const result = await db
    .delete(financeTagQueue)
    .where(eq(financeTagQueue.status, "pending"));
  const cancelled = (result as any).rowCount ?? 0;
  if (cancelled > 0) notifyFinanceTagQueueChanged();
  return cancelled;
}

/** Reset stuck processing jobs on worker startup. */
export async function resetStuckTagJobs(): Promise<void> {
  await db
    .update(financeTagQueue)
    .set({ status: "pending", started_at: null })
    .where(eq(financeTagQueue.status, "processing"));
  notifyFinanceTagQueueChanged();
}
