/**
 * Word positions for documents extracted before they were kept (#1531).
 *
 * New documents get their rows from text_extract. For the rest, an admin
 * starts the backfill here: it queues `page_words` jobs, lowest OCR confidence
 * first (the reads most worth repeating), then oldest, and the worker runs
 * them only while no text_extract is waiting.
 *
 * `GET /documents/:id/text-boxes` answers where a value stands in a document
 * the caller may see — the redaction boxes the assistant proposes (#1532).
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { requirePermission } from "../user/auth-handler";
import { PAGE_WORDS_PRIORITY } from "./document-ops";
import { requeueDocument } from "./scan-queue";
import { findTextBoxes } from "./page-words-store";
import { loadVisibleDocument } from "./visibility";
import { triggerWorkers } from "./scan-worker";

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

export interface PageWordsBackfillRequest {
  /** Documents to queue in this call (default 500). */
  limit?: number;
}

export interface PageWordsBackfillResponse {
  queued: number;
  /** Ready documents still without word positions, after this call. */
  remaining: number;
}

/** Ready documents with text but without word positions, most in need first. */
async function missing(limit: number): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    SELECT d.id
    FROM documents d
    WHERE d.status = 'ready'
      AND d.extracted_text IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM document_page_words w WHERE w.document_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM document_scan_queue q
        WHERE q.document_id = d.id AND q.service = 'page_words' AND q.status IN ('pending', 'processing')
      )
    ORDER BY d.ocr_mean_confidence ASC NULLS LAST, d.uploaded_at ASC, d.id ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => Number(r.id));
}

async function countMissing(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM documents d
    WHERE d.status = 'ready'
      AND d.extracted_text IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM document_page_words w WHERE w.document_id = d.id)
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

export async function queuePageWordsBackfill(limit: number): Promise<PageWordsBackfillResponse> {
  const ids = await missing(limit);
  for (const id of ids) await requeueDocument(id, ["page_words"], PAGE_WORDS_PRIORITY);
  if (ids.length) triggerWorkers();
  return { queued: ids.length, remaining: await countMissing() };
}

export const backfillPageWords = api(
  { expose: true, method: "POST", path: "/documents/page-words/backfill", auth: true },
  async (req: PageWordsBackfillRequest): Promise<PageWordsBackfillResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "module.documents");
    requirePermission(auth, "data.manage");
    const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(req.limit ?? DEFAULT_BATCH)));
    return queuePageWordsBackfill(limit);
  },
);

export const pageWordsBackfillStatus = api(
  { expose: true, method: "GET", path: "/documents/page-words/backfill", auth: true },
  async (): Promise<{ remaining: number }> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "module.documents");
    requirePermission(auth, "data.manage");
    return { remaining: await countMissing() };
  },
);

export interface TextBoxesRequest {
  id: number;
  /** What to find: an amount in any printed form, or a phrase. */
  q: Query<string>;
}

export interface TextBoxDTO {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBoxesResponse {
  /** "no_words": extracted before positions were kept; the backfill fills it in. */
  status: "ok" | "no_words";
  boxes: TextBoxDTO[];
  /** The pages the boxes stand on, ascending. */
  pages: number[];
}

export const findDocumentTextBoxes = api(
  { expose: true, method: "GET", path: "/documents/:id/text-boxes", auth: true },
  async ({ id, q }: TextBoxesRequest): Promise<TextBoxesResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "module.documents");
    requirePermission(auth, "documents.view");
    const query = (q ?? "").trim();
    if (!query) throw APIError.invalidArgument("q must not be empty");
    if (query.length > 200) throw APIError.invalidArgument("q is longer than 200 characters");
    await loadVisibleDocument(Number(auth.userID), id, auth.permissions.includes("data.manage"));
    const found = await findTextBoxes(id, query);
    return {
      status: found.status,
      boxes: found.boxes,
      pages: [...new Set(found.boxes.map((b) => b.page))].sort((a, b) => a - b),
    };
  },
);
