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
import { requirePermission } from "../user/auth-handler";
import {
  countMissingPageWords,
  PAGE_WORDS_BATCH,
  queuePageWordsBatch,
  type PageWordsBackfillResponse,
} from "./page-words-backfill";
import { findTextBoxes } from "./page-words-store";
import { loadVisibleDocument } from "./visibility";
import { triggerWorkers } from "./scan-worker";

export type { PageWordsBackfillResponse };

const MAX_BATCH = 5000;

export interface PageWordsBackfillRequest {
  /** Documents to queue in this call (default 500); the worker queues the rest. */
  limit?: number;
}

export async function queuePageWordsBackfill(limit: number): Promise<PageWordsBackfillResponse> {
  const result = await queuePageWordsBatch(limit);
  if (result.queued) triggerWorkers();
  return result;
}

export const backfillPageWords = api(
  { expose: true, method: "POST", path: "/documents/page-words/backfill", auth: true },
  async (req: PageWordsBackfillRequest): Promise<PageWordsBackfillResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "module.documents");
    requirePermission(auth, "data.manage");
    const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(req.limit ?? PAGE_WORDS_BATCH)));
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
    return { remaining: await countMissingPageWords() };
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
