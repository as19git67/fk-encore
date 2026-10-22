/**
 * Which documents the word-position backfill (#1531) queues, and how it keeps
 * itself going.
 *
 * An admin starts the backfill with one batch; every finished `page_words`
 * job then tops the queue up again (`topUpPageWordsBackfill`, called by the
 * worker), so the rest follows in batches without another click. The chain
 * stops on its own once no document is left — or when the pending jobs are
 * cancelled, because a top-up needs jobs of the running batch still waiting.
 */

import { sql } from "drizzle-orm";
import db from "../db/database";
import { PAGE_WORDS_PRIORITY } from "./document-ops";
import { requeueDocument } from "./scan-queue";

export const PAGE_WORDS_BATCH = 500;
/** Top up once fewer than this many jobs wait. */
const LOW_WATER = 50;

export interface PageWordsBackfillResponse {
  queued: number;
  /** Ready documents still without word positions, after this call. */
  remaining: number;
}

/**
 * Ready documents with text but without word positions, most in need first.
 * `untriedOnly` also skips documents a `page_words` job already ran for: one
 * that failed, or a scan whose pages hold no words, would otherwise be queued
 * again with every top-up. A click retries them.
 */
async function missing(limit: number, untriedOnly: boolean): Promise<number[]> {
  const activeStatuses = untriedOnly
    ? sql`('pending', 'processing', 'done', 'failed')`
    : sql`('pending', 'processing')`;
  const rows = await db.execute<{ id: number }>(sql`
    SELECT d.id
    FROM documents d
    WHERE d.status = 'ready'
      AND d.extracted_text IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM document_page_words w WHERE w.document_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM document_scan_queue q
        WHERE q.document_id = d.id AND q.service = 'page_words' AND q.status IN ${activeStatuses}
      )
    ORDER BY d.ocr_mean_confidence ASC NULLS LAST, d.uploaded_at ASC, d.id ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => Number(r.id));
}

export async function countMissingPageWords(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM documents d
    WHERE d.status = 'ready'
      AND d.extracted_text IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM document_page_words w WHERE w.document_id = d.id)
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

async function queue(ids: readonly number[]): Promise<void> {
  for (const id of ids) await requeueDocument(id, ["page_words"], PAGE_WORDS_PRIORITY);
}

/** The admin's click: one batch, including documents that were tried before. */
export async function queuePageWordsBatch(limit: number): Promise<PageWordsBackfillResponse> {
  const ids = await missing(limit, false);
  await queue(ids);
  return { queued: ids.length, remaining: await countMissingPageWords() };
}

/**
 * After a `page_words` job: queue the next batch once the queue runs low.
 * Returns how many documents it queued; the caller wakes the workers.
 */
export async function topUpPageWordsBackfill(): Promise<number> {
  // Only while jobs of the running batch still wait: "Abbrechen" deletes the
  // pending ones, and the job that was processing then must not start the
  // next batch on its way out. A batch that runs out naturally always gets
  // topped up before it is empty, because LOW_WATER is above zero.
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM document_scan_queue
    WHERE service = 'page_words' AND status = 'pending'
  `);
  const pending = Number(rows.rows[0]?.n ?? 0);
  if (pending === 0 || pending >= LOW_WATER) return 0;
  const ids = await missing(PAGE_WORDS_BATCH, true);
  await queue(ids);
  return ids.length;
}
