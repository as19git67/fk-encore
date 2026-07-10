/**
 * Document follow-up ("Wiedervorlage") + work-item basket (issue #750).
 *
 * The basket is the documents equivalent of the finance work-item basket:
 * newly scanned documents the classifier wasn't sure about (low confidence)
 * or that failed outright land here for a human to handle. The basket is
 * derived, not stored — it is the set of visible, review-worthy documents
 * minus the ones the current user has snoozed via a follow-up.
 *
 * A follow-up parks a document out of the basket until a user-chosen date.
 * The daily cron (`follow-up-cron.ts`) then deletes due follow-ups so the
 * documents re-surface in the basket, and notifies the user. The "Later"
 * view (`listFollowUps`) lists every pending follow-up for the user.
 *
 * Everything here is user-specific: follow-ups are keyed by (document, user)
 * and the basket honours the same per-user document visibility as the rest
 * of the module.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { push } from "~encore/clients";
import { and, eq, lte, lt, or, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  documentCategories,
  documentFollowUps,
  documents,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import {
  LOW_CONFIDENCE_THRESHOLD,
  toSummary,
  type DocumentSummary,
} from "./documents";
import { fetchTagsForDocuments } from "./tags";
import {
  loadUserGroupIds,
  loadVisibleDocument,
  visibleDocumentsWhere,
} from "./visibility";

// ─── helpers ──────────────────────────────────────────────────────────────

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID, 10);
}

function checkModule(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.documents");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real `YYYY-MM-DD` calendar date (rejects e.g. 2026-13-40). */
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** Local-time `YYYY-MM-DD` for "today" — used to detect due follow-ups. */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * WHERE fragment selecting review-worthy documents: failures plus
 * ready-but-low-confidence documents the user hasn't pinned yet. Mirrors the
 * `low_confidence` notification gate in `document-ops.ts`.
 */
function reviewWorthyWhere() {
  return or(
    eq(documents.status, "failed"),
    and(
      eq(documents.status, "ready"),
      eq(documents.attributes_reviewed, false),
      lt(documents.classification_confidence, LOW_CONFIDENCE_THRESHOLD),
    ),
  )!;
}

/** A document is snoozed for the user when an active follow-up row exists. */
function notSnoozedWhere(userId: number) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${documentFollowUps}
    WHERE ${documentFollowUps.document_id} = ${documents.id}
      AND ${documentFollowUps.user_id} = ${userId}
  )`;
}

// ─── basket ─────────────────────────────────────────────────────────────────

export interface DocumentBasketResponse {
  items: DocumentSummary[];
  total: number;
}

/**
 * The work-item basket for `userId`: visible, review-worthy documents that
 * the user has not snoozed via a follow-up. `isAdmin` callers (data.manage)
 * see every document, mirroring `listDocuments`.
 */
export async function listBasket(
  userId: number,
  isAdmin: boolean,
  limit: number,
  offset: number,
): Promise<DocumentBasketResponse> {
  const conds = [reviewWorthyWhere(), notSnoozedWhere(userId)];
  if (!isAdmin) {
    const groupIds = await loadUserGroupIds(userId);
    conds.push(visibleDocumentsWhere(userId, groupIds));
  }
  const where = and(...conds)!;

  const rows = await dbAll<typeof documents.$inferSelect & { cat_slug: string | null }>(
    db
      .select({
        id: documents.id,
        user_id: documents.user_id,
        sha256: documents.sha256,
        original_filename: documents.original_filename,
        mime_type: documents.mime_type,
        size_bytes: documents.size_bytes,
        disk_path: documents.disk_path,
        uploaded_at: documents.uploaded_at,
        status: documents.status,
        category_id: documents.category_id,
        title: documents.title,
        doc_date: documents.doc_date,
        sender: documents.sender,
        document_number: documents.document_number,
        summary: documents.summary,
        extracted_text: documents.extracted_text,
        classification_confidence: documents.classification_confidence,
        force_ocr: documents.force_ocr,
        tax_relevant: documents.tax_relevant,
        tax_year: documents.tax_year,
        tax_year_confidence: documents.tax_year_confidence,
        tax_reviewed: documents.tax_reviewed,
        attributes_reviewed: documents.attributes_reviewed,
        visibility: documents.visibility,
        group_id: documents.group_id,
        last_error: documents.last_error,
        notes: documents.notes,
        cat_slug: documentCategories.slug,
      })
      .from(documents)
      .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
      .where(where)
      // Oldest uploads first so the longest-waiting documents surface on top.
      .orderBy(documents.uploaded_at)
      .limit(limit)
      .offset(offset),
  );

  const tagsByDoc = await fetchTagsForDocuments(rows.map((r) => r.id));
  const totalRow = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM documents WHERE ${where}`,
  );

  return {
    items: rows.map((r) => toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? [])),
    total: parseInt(totalRow.rows[0]?.count ?? "0", 10),
  };
}

// ─── follow-ups (the "Later" list) ───────────────────────────────────────────

export interface DocumentFollowUp {
  document: DocumentSummary;
  follow_up_date: string;
  note: string | null;
  created_at: string;
}

/** Every pending follow-up for the user, soonest date first. */
export async function listFollowUps(userId: number): Promise<DocumentFollowUp[]> {
  const rows = await dbAll<
    typeof documents.$inferSelect & {
      cat_slug: string | null;
      follow_up_date: string;
      fu_note: string | null;
      fu_created_at: string;
    }
  >(
    db
      .select({
        id: documents.id,
        user_id: documents.user_id,
        sha256: documents.sha256,
        original_filename: documents.original_filename,
        mime_type: documents.mime_type,
        size_bytes: documents.size_bytes,
        disk_path: documents.disk_path,
        uploaded_at: documents.uploaded_at,
        status: documents.status,
        category_id: documents.category_id,
        title: documents.title,
        doc_date: documents.doc_date,
        sender: documents.sender,
        document_number: documents.document_number,
        summary: documents.summary,
        extracted_text: documents.extracted_text,
        classification_confidence: documents.classification_confidence,
        force_ocr: documents.force_ocr,
        tax_relevant: documents.tax_relevant,
        tax_year: documents.tax_year,
        tax_year_confidence: documents.tax_year_confidence,
        tax_reviewed: documents.tax_reviewed,
        attributes_reviewed: documents.attributes_reviewed,
        visibility: documents.visibility,
        group_id: documents.group_id,
        last_error: documents.last_error,
        notes: documents.notes,
        cat_slug: documentCategories.slug,
        follow_up_date: documentFollowUps.follow_up_date,
        fu_note: documentFollowUps.note,
        fu_created_at: documentFollowUps.created_at,
      })
      .from(documentFollowUps)
      .innerJoin(documents, eq(documentFollowUps.document_id, documents.id))
      .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
      .where(eq(documentFollowUps.user_id, userId))
      .orderBy(documentFollowUps.follow_up_date),
  );

  const tagsByDoc = await fetchTagsForDocuments(rows.map((r) => r.id));
  return rows.map((r) => ({
    document: toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? []),
    follow_up_date: r.follow_up_date,
    note: r.fu_note,
    created_at: r.fu_created_at,
  }));
}

/**
 * Schedule (or reschedule) a follow-up for one or more documents. Every
 * document must be visible to the user; an unknown / inaccessible id throws
 * `not_found`. Returns the number of follow-ups written.
 */
export async function setFollowUps(
  userId: number,
  documentIds: number[],
  followUpDate: string,
  note: string | null,
): Promise<number> {
  if (documentIds.length === 0) {
    throw APIError.invalidArgument("no documents selected");
  }
  if (!isValidIsoDate(followUpDate)) {
    throw APIError.invalidArgument("follow_up_date must be a valid YYYY-MM-DD date");
  }
  if (followUpDate <= todayIsoDate()) {
    throw APIError.invalidArgument("follow_up_date must be in the future");
  }

  const cleanNote = note?.trim() || null;
  const uniqueIds = [...new Set(documentIds)];

  // Visibility check per document — reuse loadVisibleDocument so an id the
  // caller may not see is rejected exactly like elsewhere in the module.
  for (const id of uniqueIds) {
    await loadVisibleDocument(userId, id);
  }

  for (const id of uniqueIds) {
    await db
      .insert(documentFollowUps)
      .values({
        document_id: id,
        user_id: userId,
        follow_up_date: followUpDate,
        note: cleanNote,
      })
      .onConflictDoUpdate({
        target: [documentFollowUps.document_id, documentFollowUps.user_id],
        set: { follow_up_date: followUpDate, note: cleanNote, updated_at: sql`NOW()` },
      });
  }

  return uniqueIds.length;
}

/** Cancel a follow-up, bringing the document straight back into the basket. */
export async function removeFollowUp(userId: number, documentId: number): Promise<boolean> {
  const deleted = await db
    .delete(documentFollowUps)
    .where(
      and(
        eq(documentFollowUps.document_id, documentId),
        eq(documentFollowUps.user_id, userId),
      ),
    )
    .returning({ document_id: documentFollowUps.document_id });
  return deleted.length > 0;
}

// ─── due processing (called by the daily cron) ───────────────────────────────

export interface ProcessDueResult {
  /** Total due follow-up rows deleted (whether or not still review-worthy). */
  cleared: number;
  /** Of those, the documents that actually return to the basket. */
  surfaced: number;
  /** Push notifications actually sent for surfaced documents. */
  notified: number;
}

/**
 * Delete every follow-up whose date has arrived (≤ today) so the documents
 * re-enter their owners' baskets, and notify the owner.
 *
 * Notifications are sent only for documents that are *still* review-worthy:
 * a document the user handled while it was snoozed (pinned its attributes, or
 * a re-classify lifted the confidence) no longer reappears in the basket, so
 * a "back in your basket" push would be misleading. The follow-up rows are
 * deleted in either case — leaving stale rows behind would keep handled
 * documents permanently snoozed. Best effort: a failed push never blocks the
 * deletion.
 */
export async function processDueFollowUps(today: string = todayIsoDate()): Promise<ProcessDueResult> {
  const due = await dbAll<{
    document_id: number;
    user_id: number;
    title: string | null;
    original_filename: string;
    status: string;
    attributes_reviewed: boolean;
    classification_confidence: number | null;
  }>(
    db
      .select({
        document_id: documentFollowUps.document_id,
        user_id: documentFollowUps.user_id,
        title: documents.title,
        original_filename: documents.original_filename,
        status: documents.status,
        attributes_reviewed: documents.attributes_reviewed,
        classification_confidence: documents.classification_confidence,
      })
      .from(documentFollowUps)
      .innerJoin(documents, eq(documentFollowUps.document_id, documents.id))
      .where(lte(documentFollowUps.follow_up_date, today)),
  );

  if (due.length === 0) return { cleared: 0, surfaced: 0, notified: 0 };

  // Delete all due rows so handled documents don't stay snoozed forever.
  await db
    .delete(documentFollowUps)
    .where(lte(documentFollowUps.follow_up_date, today));

  // Mirror the basket's `reviewWorthyWhere` so we only notify for documents
  // that actually come back into view.
  const stillReviewWorthy = due.filter(
    (r) =>
      r.status === "failed" ||
      (r.status === "ready" &&
        !r.attributes_reviewed &&
        r.classification_confidence != null &&
        r.classification_confidence < LOW_CONFIDENCE_THRESHOLD),
  );

  let notified = 0;
  for (const row of stillReviewWorthy) {
    try {
      const res = await push.notifyDocumentReview({
        userId: row.user_id,
        kind: "follow_up",
        documentId: row.document_id,
        documentTitle: row.title || row.original_filename,
        reason: null,
      });
      notified += res.sent;
    } catch (err) {
      console.warn(
        `[documents.follow-ups] notify(follow_up,${row.document_id}) failed: ${(err as Error).message}`,
      );
    }
  }

  return { cleared: due.length, surfaced: stillReviewWorthy.length, notified };
}

// ─── API endpoints ───────────────────────────────────────────────────────────

export const getDocumentBasket = api(
  { expose: true, method: "GET", path: "/documents/basket", auth: true },
  async ({ limit, offset }: { limit?: Query<number>; offset?: Query<number> }): Promise<DocumentBasketResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const lim = Math.min(Math.max(limit ?? 50, 1), 200);
    const off = Math.max(offset ?? 0, 0);
    return await listBasket(userId, false, lim, off);
  },
);

export interface FollowUpsResponse {
  items: DocumentFollowUp[];
}

export const listDocumentFollowUps = api(
  { expose: true, method: "GET", path: "/documents/follow-ups", auth: true },
  async (): Promise<FollowUpsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return { items: await listFollowUps(getUserId()) };
  },
);

export interface SetFollowUpRequest {
  document_ids: number[];
  follow_up_date: string;
  note?: string | null;
}

export const setDocumentFollowUp = api(
  { expose: true, method: "POST", path: "/documents/follow-ups", auth: true },
  async (req: SetFollowUpRequest): Promise<{ scheduled: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const scheduled = await setFollowUps(
      getUserId(),
      req.document_ids ?? [],
      req.follow_up_date,
      req.note ?? null,
    );
    return { scheduled };
  },
);

export const deleteDocumentFollowUp = api(
  { expose: true, method: "DELETE", path: "/documents/follow-ups/:documentId", auth: true },
  async ({ documentId }: { documentId: number }): Promise<{ removed: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return { removed: await removeFollowUp(getUserId(), documentId) };
  },
);
