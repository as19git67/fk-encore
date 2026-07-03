/**
 * Batch mutations for the document basket (issue #736).
 *
 * The selection basket in the frontend collects arbitrary documents (single
 * picks or a whole filter result) and applies one change to all of them.
 * Tags and visibility already have batch endpoints in `documents.ts`; this
 * module adds the remaining operations from the issue:
 *
 *   - attributes: category and/or document date (pins `attributes_reviewed`,
 *     mirroring the single-document PATCH),
 *   - tax: relevance, year and sections (sets `tax_reviewed`, mirroring
 *     `POST /documents/:id/tax`),
 *   - subject persons ("Bezugspersonen"): add/remove links.
 *
 * Visibility semantics follow `batchUpdateTags`: documents the caller cannot
 * see are silently skipped and only the affected count is reported.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentSubjectPersons,
  documents,
  userSubjectPersons,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { replaceUserTaxSections } from "./document-ops";
import { relocateDocument } from "./relocate";
import { isValidTaxSectionSlug } from "./tax-sections";
import { loadUserGroupIds, visibleDocumentsWhere } from "./visibility";

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

/** The subset of `ids` the user is allowed to see (same rule as listDocuments). */
async function visibleDocumentIds(userId: number, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const groupIds = await loadUserGroupIds(userId);
  const rows = await dbAll<{ id: number }>(
    db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(inArray(documents.id, [...ids]), visibleDocumentsWhere(userId, groupIds)),
      ),
  );
  return rows.map((r) => r.id);
}

/** Category/date changes move the file; rebuild each document's canonical path. */
async function relocateAll(ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    try {
      await relocateDocument(id);
    } catch (err) {
      console.warn(
        `[documents] batch: relocate(${id}) failed: ${(err as Error).message}`,
      );
    }
  }
}

// ─── attributes (category / document date) ──────────────────────────────────

export interface BatchAttributesPatch {
  /** New category slug; `null` clears the category. `undefined` = untouched. */
  category_slug?: string | null;
  /** New document date (`YYYY-MM-DD`); `null` clears it. `undefined` = untouched. */
  doc_date?: string | null;
}

/**
 * Set category and/or document date on every visible document in `ids`.
 * Pins `attributes_reviewed` — a batch edit is a human assertion, exactly
 * like the single-document PATCH. Returns the number of affected documents.
 */
export async function batchSetAttributes(
  userId: number,
  ids: readonly number[],
  patch: BatchAttributesPatch,
): Promise<number> {
  if (patch.category_slug === undefined && patch.doc_date === undefined) {
    throw APIError.invalidArgument("at least one of category_slug / doc_date required");
  }

  const set: Partial<typeof documents.$inferInsert> = { attributes_reviewed: true };

  if (patch.category_slug !== undefined) {
    if (patch.category_slug === null || patch.category_slug === "") {
      set.category_id = null;
    } else {
      const cat = await dbFirst<{ id: number }>(
        db
          .select({ id: documentCategories.id })
          .from(documentCategories)
          .where(eq(documentCategories.slug, patch.category_slug)),
      );
      if (!cat) {
        throw APIError.invalidArgument(`unknown category slug: ${patch.category_slug}`);
      }
      set.category_id = cat.id;
    }
  }

  if (patch.doc_date !== undefined) {
    if (patch.doc_date === null || patch.doc_date === "") {
      set.doc_date = null;
    } else {
      if (!isValidIsoDate(patch.doc_date)) {
        throw APIError.invalidArgument("doc_date must be a valid YYYY-MM-DD date");
      }
      set.doc_date = patch.doc_date;
    }
  }

  const docIds = await visibleDocumentIds(userId, ids);
  if (docIds.length === 0) return 0;

  await db.update(documents).set(set).where(inArray(documents.id, docIds));
  await relocateAll(docIds);
  return docIds.length;
}

// ─── tax (relevance / year / sections) ──────────────────────────────────────

export interface BatchTaxPatch {
  tax_relevant: boolean;
  /** Required when `tax_relevant=true`. */
  tax_year?: number | null;
  /** Replaces every section assignment; required non-empty when relevant. */
  tax_sections?: string[];
}

/**
 * Set the tax metadata on every visible document in `ids`. Same validation
 * and `tax_reviewed` pinning as the single-document `POST /documents/:id/tax`:
 * the human override is authoritative and replaces AI + user section rows.
 */
export async function batchSetTax(
  userId: number,
  ids: readonly number[],
  patch: BatchTaxPatch,
): Promise<number> {
  let year: number | null = null;
  if (patch.tax_relevant) {
    if (patch.tax_year === undefined || patch.tax_year === null) {
      throw APIError.invalidArgument("tax_year is required when tax_relevant=true");
    }
    if (!Number.isInteger(patch.tax_year) || patch.tax_year < 2000 || patch.tax_year > 2100) {
      throw APIError.invalidArgument("tax_year must be an integer between 2000 and 2100");
    }
    year = patch.tax_year;
  }

  const slugs = (patch.tax_sections ?? []).map((s) => s.trim().toLowerCase());
  if (patch.tax_relevant && slugs.length === 0) {
    throw APIError.invalidArgument("tax_sections must not be empty when tax_relevant=true");
  }
  for (const s of slugs) {
    if (!isValidTaxSectionSlug(s)) {
      throw APIError.invalidArgument(`unknown tax section slug: ${s}`);
    }
  }

  const docIds = await visibleDocumentIds(userId, ids);
  if (docIds.length === 0) return 0;

  await db
    .update(documents)
    .set({
      tax_relevant: patch.tax_relevant,
      tax_year: year,
      tax_year_confidence: patch.tax_relevant ? 1 : 0,
      tax_reviewed: true,
    })
    .where(inArray(documents.id, docIds));

  for (const id of docIds) {
    await replaceUserTaxSections(id, patch.tax_relevant ? slugs : []);
  }

  // Rebuild the `_steuer/` hardlink view against the new tax metadata.
  await relocateAll(docIds);
  return docIds.length;
}

// ─── subject persons ("Bezugspersonen") ─────────────────────────────────────

export interface BatchSubjectPersonsPatch {
  /** Subject-person ids to link (source becomes 'user') on every document. */
  add_ids?: number[];
  /** Subject-person ids to unlink (removes AI and user links alike). */
  remove_ids?: number[];
}

/**
 * Add and/or remove Bezugsperson links across every visible document in
 * `ids`. Added links are user-curated (`source='user'`), so a later
 * re-classify cannot drop them; existing AI links are promoted the same way
 * (mirrors `batchUpdateTags`). Removal deletes the link regardless of source
 * — "this person does not belong on these documents" is a human assertion.
 * Only subject persons owned by the caller are accepted.
 */
export async function batchSetSubjectPersons(
  userId: number,
  ids: readonly number[],
  patch: BatchSubjectPersonsPatch,
): Promise<number> {
  const addIds = [...new Set(patch.add_ids ?? [])];
  const removeIds = [...new Set(patch.remove_ids ?? [])];
  if (addIds.length === 0 && removeIds.length === 0) {
    throw APIError.invalidArgument("at least one of add_ids / remove_ids required");
  }

  const referenced = [...new Set([...addIds, ...removeIds])];
  const owned = await dbAll<{ id: number }>(
    db
      .select({ id: userSubjectPersons.id })
      .from(userSubjectPersons)
      .where(
        and(
          eq(userSubjectPersons.user_id, userId),
          inArray(userSubjectPersons.id, referenced),
        ),
      ),
  );
  const ownedIds = new Set(owned.map((r) => r.id));
  for (const id of referenced) {
    if (!ownedIds.has(id)) {
      throw APIError.invalidArgument(`unknown subject person id: ${id}`);
    }
  }

  const docIds = await visibleDocumentIds(userId, ids);
  if (docIds.length === 0) return 0;

  if (removeIds.length > 0) {
    await db
      .delete(documentSubjectPersons)
      .where(
        and(
          inArray(documentSubjectPersons.document_id, docIds),
          inArray(documentSubjectPersons.subject_person_id, removeIds),
        ),
      );
  }

  for (const docId of docIds) {
    for (const personId of addIds) {
      await db
        .insert(documentSubjectPersons)
        .values({ document_id: docId, subject_person_id: personId, source: "user" })
        .onConflictDoUpdate({
          target: [
            documentSubjectPersons.document_id,
            documentSubjectPersons.subject_person_id,
          ],
          set: { source: "user" },
        });
    }
  }

  return docIds.length;
}

// ─── endpoints ──────────────────────────────────────────────────────────────

export interface BatchDocumentIdsRequest {
  document_ids: number[];
}

export interface BatchAffectedResponse {
  affected_documents: number;
}

function requireDocumentIds(req: BatchDocumentIdsRequest): number[] {
  if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
    throw APIError.invalidArgument("document_ids required");
  }
  return req.document_ids;
}

export interface BatchUpdateAttributesRequest extends BatchDocumentIdsRequest {
  category_slug?: string | null;
  doc_date?: string | null;
}

export const batchUpdateAttributes = api(
  { expose: true, method: "POST", path: "/documents/batch/attributes", auth: true },
  async (req: BatchUpdateAttributesRequest): Promise<BatchAffectedResponse> => {
    checkModule();
    requirePermission(getAuthData()!, "documents.edit");
    const affected = await batchSetAttributes(getUserId(), requireDocumentIds(req), {
      category_slug: req.category_slug,
      doc_date: req.doc_date,
    });
    return { affected_documents: affected };
  },
);

export interface BatchUpdateTaxRequest extends BatchDocumentIdsRequest {
  tax_relevant: boolean;
  tax_year?: number | null;
  tax_sections?: string[];
}

export const batchUpdateTax = api(
  { expose: true, method: "POST", path: "/documents/batch/tax", auth: true },
  async (req: BatchUpdateTaxRequest): Promise<BatchAffectedResponse> => {
    checkModule();
    requirePermission(getAuthData()!, "documents.edit");
    const affected = await batchSetTax(getUserId(), requireDocumentIds(req), {
      tax_relevant: req.tax_relevant,
      tax_year: req.tax_year,
      tax_sections: req.tax_sections,
    });
    return { affected_documents: affected };
  },
);

export interface BatchUpdateSubjectPersonsRequest extends BatchDocumentIdsRequest {
  add_ids?: number[];
  remove_ids?: number[];
}

export const batchUpdateSubjectPersons = api(
  { expose: true, method: "POST", path: "/documents/batch/subject-persons", auth: true },
  async (req: BatchUpdateSubjectPersonsRequest): Promise<BatchAffectedResponse> => {
    checkModule();
    requirePermission(getAuthData()!, "documents.edit");
    const affected = await batchSetSubjectPersons(getUserId(), requireDocumentIds(req), {
      add_ids: req.add_ids,
      remove_ids: req.remove_ids,
    });
    return { affected_documents: affected };
  },
);
