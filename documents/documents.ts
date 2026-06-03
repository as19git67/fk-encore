/**
 * API endpoints for the documents module.
 *
 * Upload goes through the raw endpoint so the PDF body streams
 * straight to disk; every other endpoint is a typed Encore API.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentCategorySuggestions,
  documentTagLinks,
  documentTags,
  documentTaxSections,
  documents,
  documentsUserPref,
} from "../db/schema";
import {
  DOCUMENTS_MAX_BYTES,
  SUPPORTED_MIME_TYPES,
  assertPathUnderDocumentsRoot,
  composeOwnerRootSegment,
  ensureDir,
  getInitialUploadDiskPath,
  guessExtension,
  pruneEmptyDirs,
  slugifyUserLogin,
} from "./documents.service";
import { users } from "../db/schema";
import { replaceUserTaxSections } from "./document-ops";
import {
  deleteTaxHintOverride,
  listTaxHintEntries,
  upsertTaxHintOverride,
  type TaxHintEntry,
} from "./tax-hint-overrides";
import {
  createSubjectPerson,
  deleteSubjectPerson,
  listSubjectPersons,
  updateSubjectPerson,
} from "./subject-persons";
import { dropTaxLinks, relocateDocument } from "./relocate";
import {
  assertGroupMember,
  loadAdministrableDocument,
  loadUserGroupIds,
  loadVisibleDocument,
  visibleDocumentsWhere,
} from "./visibility";
import { enqueueDocumentScan, getQueueStatus, requeueDocument } from "./scan-queue";
import { triggerWorkers } from "./scan-worker";
import { searchDocuments, type SearchMode } from "./search";
import {
  findTaxSection,
  isValidTaxSectionSlug,
  orderTaxSectionSlugs,
  TAX_SECTIONS,
  type TaxSectionGroup,
} from "./tax-sections";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface DocumentSummary {
  id: number;
  title: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: "pending" | "extracting" | "classifying" | "ready" | "failed";
  uploaded_at: string | null;
  doc_date: string | null;
  sender: string | null;
  category_id: number | null;
  category_slug: string | null;
  classification_confidence: number | null;
  tags: string[];
  tax_relevant: boolean;
  tax_year: number | null;
  last_error: string | null;
  visibility: "private" | "group";
  group_id: number | null;
}

export interface DocumentTaxSectionDTO {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  confidence: number | null;
  source: "ai" | "user";
}

export interface DocumentDetail extends DocumentSummary {
  summary: string | null;
  extracted_text_preview: string | null;
  tax_reviewed: boolean;
  tax_year_confidence: number | null;
  tax_sections: DocumentTaxSectionDTO[];
}

export interface DocumentCategoryDTO {
  id: number;
  slug: string;
  name: string;
  parent_id: number | null;
  icon: string | null;
  sort_order: number;
}

export interface ListDocumentsResponse {
  items: DocumentSummary[];
  total: number;
}

interface ListQuery {
  category?: Query<string>;
  tag?: Query<string>;
  q?: Query<string>;
  status?: Query<string>;
  /**
   * `needs_review=true` keeps only documents the human should look at:
   * status='failed', or status='ready' with classification_confidence
   * below LOW_CONFIDENCE_THRESHOLD. Combine with status= for a more
   * specific filter (e.g. status=ready + needs_review=true → just the
   * low-confidence ready ones).
   */
  needs_review?: Query<boolean>;
  limit?: Query<number>;
  offset?: Query<number>;
}

/** Mirrors documents/document-ops.ts — keep in sync. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ─── Upload (raw) ───────────────────────────────────────────────────────────

/**
 * Stream a PDF into DOCUMENTS_DIR. The sha256 digest is computed while
 * streaming and acts as the dedup key — re-uploading the same file
 * returns 409 without touching disk twice.
 */
export const uploadDocument = api.raw(
  { expose: true, method: "POST", path: "/documents", auth: true, bodyLimit: null },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const authData = getAuthData()!;
    try {
      requirePermission(authData, "documents.upload");
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Missing permission: documents.upload" }));
      return;
    }

    const userId = getUserId();
    const rawFileName = (req.headers["x-file-name"] as string) || "document.pdf";
    // Client percent-encodes the filename to stay within ISO-8859-1 header limits.
    let originalName = rawFileName;
    try {
      originalName = decodeURIComponent(rawFileName);
    } catch {
      originalName = rawFileName;
    }
    const mimeType = ((req.headers["content-type"] as string) || "application/pdf")
      .toLowerCase()
      .split(";")[0]
      .trim();

    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      res.statusCode = 415;
      res.end(JSON.stringify({ error: "Unsupported file type", message: "Nur PDF-Dateien werden unterstützt." }));
      return;
    }

    try {
      const result = await streamAndStorePdf(req, originalName, mimeType, userId);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err: any) {
      if (err.message === "DOCUMENT_ALREADY_EXISTS") {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Duplicate document", message: "Dokument wurde bereits hochgeladen." }));
        return;
      }
      if (err.message === "DOCUMENT_TOO_LARGE") {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Payload too large", message: "Datei überschreitet die erlaubte Größe." }));
        return;
      }
      console.error("[documents] upload error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message ?? "Internal Server Error" }));
    }
  },
);

async function streamAndStorePdf(
  req: NodeJS.ReadableStream,
  originalName: string,
  mimeType: string,
  userId: number,
): Promise<DocumentSummary> {
  const ext = guessExtension(originalName, mimeType);
  const hash = crypto.createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > DOCUMENTS_MAX_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
    hash.update(chunk);
    chunks.push(chunk);
  }
  const digest = hash.digest("hex");
  const buffer = Buffer.concat(chunks, size);

  const existing = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.sha256, digest)),
  );
  if (existing) throw new Error("DOCUMENT_ALREADY_EXISTS");

  // New uploads land in the uploader's personal root by default. If the
  // user has set a default group via the upload-defaults preference and
  // is still a member of that group, the document is created with
  // `visibility='group', group_id=<pref>` directly so the file goes
  // straight to the shared root.
  const uploader = await dbFirst<{ email: string }>(
    db.select({ email: users.email }).from(users).where(eq(users.id, userId)),
  );
  const userLoginSlug = slugifyUserLogin(
    uploader?.email ?? `user-${userId}@local`,
    userId,
  );

  const defaultGroupId = await loadDefaultGroupForUser(userId);

  const ownerRootSeg = composeOwnerRootSegment({
    visibility: "private",
    userLoginSlug,
    groupSlug: null,
  });
  const { absPath, dirAbs } = getInitialUploadDiskPath(
    ownerRootSeg,
    digest,
    ext,
    new Date(),
  );
  assertPathUnderDocumentsRoot(absPath);
  await ensureDir(dirAbs);
  await fs.promises.writeFile(absPath, buffer);

  const row = await dbFirst<typeof documents.$inferSelect>(
    db
      .insert(documents)
      .values({
        user_id: userId,
        sha256: digest,
        original_filename: originalName,
        mime_type: mimeType,
        size_bytes: size,
        disk_path: absPath,
        visibility: defaultGroupId != null ? "group" : "private",
        group_id: defaultGroupId,
      })
      .returning(),
  );
  if (!row) throw new Error("insert documents: no row returned");

  // When the document was created with a group right away the file still
  // sits under the uploader's private root — relocate to the group root.
  if (defaultGroupId != null) {
    try {
      await relocateDocument(row.id);
    } catch (err) {
      console.warn(
        `[documents] upload: relocate after default-group(${row.id}) failed: ${(err as Error).message}`,
      );
    }
  }

  await enqueueDocumentScan(row.id);
  triggerWorkers();

  return toSummary(row, null, []);
}

const UPLOAD_DEFAULTS_PREF_KEY = "upload_defaults";

interface UploadDefaultsPref {
  group_id: number | null;
}

/**
 * Read the configured default group for new uploads. Returns null when
 * the user has no preference, the preference is malformed, or the user
 * is no longer a member of the saved group (which we treat the same
 * as "no preference" so a stale pref doesn't fail uploads).
 */
async function loadDefaultGroupForUser(userId: number): Promise<number | null> {
  const row = await dbFirst<{ value: unknown }>(
    db
      .select({ value: documentsUserPref.value })
      .from(documentsUserPref)
      .where(
        and(
          eq(documentsUserPref.user_id, userId),
          eq(documentsUserPref.key, UPLOAD_DEFAULTS_PREF_KEY),
        ),
      ),
  );
  if (!row) return null;
  const v = row.value as UploadDefaultsPref | null;
  const groupId = v?.group_id ?? null;
  if (groupId == null) return null;
  // Still a member?
  try {
    await assertGroupMember(userId, groupId);
  } catch {
    return null;
  }
  return groupId;
}

// ─── List / get / file ──────────────────────────────────────────────────────

export const listDocuments = api(
  { expose: true, method: "GET", path: "/documents", auth: true },
  async ({ category, tag, q, status, needs_review, limit, offset }: ListQuery): Promise<ListDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const lim = Math.min(Math.max(limit ?? 50, 1), 200);
    const off = Math.max(offset ?? 0, 0);
    const groupIds = await loadUserGroupIds(userId);
    const conds = [visibleDocumentsWhere(userId, groupIds)];

    if (status && status.length > 0) {
      conds.push(eq(documents.status, status as any));
    }
    if (needs_review === true) {
      const reviewCond = or(
        eq(documents.status, "failed" as any),
        and(
          eq(documents.status, "ready" as any),
          lt(documents.classification_confidence, LOW_CONFIDENCE_THRESHOLD),
        ),
      );
      if (reviewCond) conds.push(reviewCond);
    }
    if (category && category.length > 0) {
      const cat = await dbFirst<{ id: number }>(
        db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, category)),
      );
      conds.push(eq(documents.category_id, cat?.id ?? -1));
    }
    if (q && q.trim().length > 0) {
      const pat = `%${q.trim()}%`;
      const matchedByTitle = or(
        ilike(documents.title, pat),
        ilike(documents.sender, pat),
        ilike(documents.original_filename, pat),
        ilike(documents.summary, pat),
      );
      if (matchedByTitle) conds.push(matchedByTitle);
    }

    let docIdFilter: number[] | null = null;
    if (tag && tag.length > 0) {
      const tagRow = await dbFirst<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(eq(documentTags.name, tag.toLowerCase())),
      );
      if (!tagRow) {
        return { items: [], total: 0 };
      }
      const links = await dbAll<{ document_id: number }>(
        db
          .select({ document_id: documentTagLinks.document_id })
          .from(documentTagLinks)
          .where(eq(documentTagLinks.tag_id, tagRow.id)),
      );
      docIdFilter = links.map((l) => l.document_id);
      if (docIdFilter.length === 0) return { items: [], total: 0 };
      conds.push(inArray(documents.id, docIdFilter));
    }

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
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(and(...conds))
        .orderBy(desc(documents.uploaded_at))
        .limit(lim)
        .offset(off),
    );

    const ids = rows.map((r) => r.id);
    const tagsByDoc = await fetchTagsForDocuments(ids);

    const total = (
      await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text as count FROM documents WHERE ${sql.join(
          conds.map((c) => sql`(${c})`),
          sql` AND `,
        )}`,
      )
    ).rows[0];

    return {
      items: rows.map((r) => toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? [])),
      total: parseInt(total?.count ?? "0", 10),
    };
  },
);

export const getDocument = api(
  { expose: true, method: "GET", path: "/documents/:id", auth: true },
  async ({ id }: { id: number }): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const row = await loadVisibleDocument(userId, id);
    const cat = row.category_id
      ? await dbFirst<{ slug: string }>(
          db.select({ slug: documentCategories.slug }).from(documentCategories).where(eq(documentCategories.id, row.category_id)),
        )
      : undefined;

    const tagsMap = await fetchTagsForDocuments([id]);
    const tags = tagsMap.get(id) ?? [];
    const taxSections = await fetchTaxSectionsForDocument(id);

    const preview = (row.extracted_text ?? "").slice(0, 2000);
    return {
      ...toSummary(row, cat?.slug ?? null, tags),
      summary: row.summary,
      extracted_text_preview: preview.length > 0 ? preview : null,
      tax_reviewed: row.tax_reviewed ?? false,
      tax_year_confidence: row.tax_year_confidence ?? null,
      tax_sections: taxSections,
    };
  },
);

/**
 * Stream the PDF back to the client. Only the owner can read it.
 * Path-traversal protection comes from the sha256-based disk path plus
 * `assertPathUnderDocumentsRoot`.
 */
export const getDocumentFile = api.raw(
  { expose: true, method: "GET", path: "/documents/:id/file", auth: true },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const authData = getAuthData();
    if (!authData) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(authData, "documents.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const userId = parseInt(authData.userID, 10);
    const m = /\/documents\/(\d+)\/file/.exec(req.url ?? "");
    const docId = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(docId)) {
      res.statusCode = 400;
      res.end("Invalid id");
      return;
    }

    try {
      const row = await loadVisibleDocument(userId, docId);
      assertPathUnderDocumentsRoot(row.disk_path);
      const stat = await fs.promises.stat(row.disk_path);
      res.statusCode = 200;
      res.setHeader("Content-Type", row.mime_type || "application/pdf");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(row.original_filename)}"`,
      );
      const stream = fs.createReadStream(row.disk_path);
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[documents] file stream error:", err);
        res.end();
      });
    } catch (err: any) {
      const code = err instanceof APIError ? (err as any).statusCode ?? 500 : 500;
      res.statusCode = code === 500 ? 404 : code;
      res.end(err?.message ?? "Not found");
    }
  },
);

// ─── Mutations ──────────────────────────────────────────────────────────────

export interface UpdateDocumentRequest {
  id: number;
  title?: string | null;
  doc_date?: string | null;
  sender?: string | null;
  summary?: string | null;
  category_slug?: string | null;
  tags?: string[];
}

export const updateDocument = api(
  { expose: true, method: "PATCH", path: "/documents/:id", auth: true },
  async (req: UpdateDocumentRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadVisibleDocument(userId, req.id);

    const patch: Partial<typeof documents.$inferInsert> = {};
    if (req.title !== undefined) patch.title = req.title?.trim() || null;
    if (req.doc_date !== undefined) patch.doc_date = req.doc_date?.trim() || null;
    if (req.sender !== undefined) patch.sender = req.sender?.trim() || null;
    if (req.summary !== undefined) patch.summary = req.summary?.trim() || null;

    if (req.category_slug !== undefined) {
      if (req.category_slug === null || req.category_slug === "") {
        patch.category_id = null;
      } else {
        const cat = await dbFirst<{ id: number }>(
          db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, req.category_slug)),
        );
        if (!cat) throw APIError.invalidArgument(`unknown category slug: ${req.category_slug}`);
        patch.category_id = cat.id;
      }
    }

    if (Object.keys(patch).length > 0) {
      await db.update(documents).set(patch).where(eq(documents.id, existing.id));
    }

    if (req.tags !== undefined) {
      await replaceTags(existing.id, req.tags);
    }

    // Metadata that contributes to the canonical path may have changed;
    // move the file and rebuild tax hardlinks. `relocateDocument` is
    // idempotent when nothing actually moved.
    if (Object.keys(patch).length > 0) {
      try {
        await relocateDocument(existing.id);
      } catch (err) {
        console.warn(
          `[documents] relocate after update(${existing.id}) failed: ${(err as Error).message}`,
        );
      }
    }

    return await loadDetail(userId, existing.id);
  },
);

export interface UpdateDocumentVisibilityRequest {
  id: number;
  visibility: "private" | "group";
  /** Required when `visibility='group'`; must be a group the caller belongs to. */
  group_id?: number | null;
}

/**
 * Flip a document between private (uploader-only) and group
 * (shared with every member of the named group) visibility.
 *
 * Only the original uploader or a group owner may change visibility
 * — this is a `loadAdministrableDocument` check. Moving a document
 * *into* a group additionally requires active membership in that
 * group. The physical file is relocated immediately so the
 * filesystem view matches the DB.
 */
export const updateDocumentVisibility = api(
  { expose: true, method: "POST", path: "/documents/:id/visibility", auth: true },
  async (req: UpdateDocumentVisibilityRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadAdministrableDocument(userId, req.id);

    if (req.visibility === "group") {
      if (req.group_id == null) {
        throw APIError.invalidArgument(
          "group_id is required when visibility='group'",
        );
      }
      await assertGroupMember(userId, req.group_id);
      await db
        .update(documents)
        .set({ visibility: "group", group_id: req.group_id })
        .where(eq(documents.id, existing.id));
    } else {
      await db
        .update(documents)
        .set({ visibility: "private", group_id: null })
        .where(eq(documents.id, existing.id));
    }

    try {
      await relocateDocument(existing.id);
    } catch (err) {
      console.warn(
        `[documents] relocate after visibility change(${existing.id}) failed: ${(err as Error).message}`,
      );
    }

    return await loadDetail(userId, existing.id);
  },
);

// ─── Batch updates ──────────────────────────────────────────────────────────

export interface BatchUpdateTagsRequest {
  document_ids: number[];
  /** Tag names to add to every document in `document_ids`. */
  add?: string[];
  /** Tag names to remove from every document in `document_ids`. */
  remove?: string[];
}

export interface BatchUpdateTagsResponse {
  affected_documents: number;
  added_links: number;
  removed_links: number;
}

/**
 * Add and/or remove a set of tags across multiple documents in one call.
 * Documents the caller cannot see are silently skipped — same pattern
 * as `finance.batchTag`.
 */
export const batchUpdateTags = api(
  { expose: true, method: "POST", path: "/documents/batch/tags", auth: true },
  async (req: BatchUpdateTagsRequest): Promise<BatchUpdateTagsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }
    const add = (req.add ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const remove = (req.remove ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (add.length === 0 && remove.length === 0) {
      throw APIError.invalidArgument("at least one of add / remove required");
    }

    const groupIds = await loadUserGroupIds(userId);
    const visibleRows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            inArray(documents.id, req.document_ids),
            visibleDocumentsWhere(userId, groupIds),
          ),
        ),
    );
    const docIds = visibleRows.map((r) => r.id);
    if (docIds.length === 0) {
      return { affected_documents: 0, added_links: 0, removed_links: 0 };
    }

    let removedLinks = 0;
    let addedLinks = 0;

    if (remove.length > 0) {
      const tagRows = await dbAll<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(inArray(documentTags.name, remove)),
      );
      if (tagRows.length > 0) {
        const delRes = await db
          .delete(documentTagLinks)
          .where(
            and(
              inArray(documentTagLinks.document_id, docIds),
              inArray(
                documentTagLinks.tag_id,
                tagRows.map((t) => t.id),
              ),
            ),
          )
          .returning({ document_id: documentTagLinks.document_id });
        removedLinks = delRes.length;
      }
    }

    if (add.length > 0) {
      // Upsert tag rows by name.
      for (const name of add) {
        await db
          .insert(documentTags)
          .values({ name })
          .onConflictDoNothing();
      }
      const tagRows = await dbAll<{ id: number; name: string }>(
        db
          .select({ id: documentTags.id, name: documentTags.name })
          .from(documentTags)
          .where(inArray(documentTags.name, add)),
      );
      for (const docId of docIds) {
        for (const tag of tagRows) {
          const inserted = await db
            .insert(documentTagLinks)
            .values({ document_id: docId, tag_id: tag.id })
            .onConflictDoNothing()
            .returning({ document_id: documentTagLinks.document_id });
          if (inserted.length > 0) addedLinks++;
        }
      }
    }

    return {
      affected_documents: docIds.length,
      added_links: addedLinks,
      removed_links: removedLinks,
    };
  },
);

export interface BatchUpdateVisibilityRequest {
  document_ids: number[];
  visibility: "private" | "group";
  /** Required when `visibility='group'`. */
  group_id?: number | null;
}

export interface BatchUpdateVisibilityResponse {
  affected_documents: number;
  skipped_unauthorized: number;
}

/**
 * Move multiple documents between private and a single group at once.
 * Each document is checked individually with `loadAdministrableDocument`;
 * documents the caller cannot administer are skipped silently and
 * counted in the response.
 */
export const batchUpdateVisibility = api(
  { expose: true, method: "POST", path: "/documents/batch/visibility", auth: true },
  async (req: BatchUpdateVisibilityRequest): Promise<BatchUpdateVisibilityResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }
    if (req.visibility === "group") {
      if (req.group_id == null) {
        throw APIError.invalidArgument(
          "group_id is required when visibility='group'",
        );
      }
      await assertGroupMember(userId, req.group_id);
    }

    let affected = 0;
    let skipped = 0;
    for (const id of req.document_ids) {
      let row;
      try {
        row = await loadAdministrableDocument(userId, id);
      } catch {
        skipped++;
        continue;
      }
      if (req.visibility === "group") {
        await db
          .update(documents)
          .set({ visibility: "group", group_id: req.group_id! })
          .where(eq(documents.id, row.id));
      } else {
        await db
          .update(documents)
          .set({ visibility: "private", group_id: null })
          .where(eq(documents.id, row.id));
      }
      try {
        await relocateDocument(row.id);
      } catch (err) {
        console.warn(
          `[documents] batch visibility: relocate(${row.id}) failed: ${(err as Error).message}`,
        );
      }
      affected++;
    }

    return { affected_documents: affected, skipped_unauthorized: skipped };
  },
);

export interface BatchReclassifyRequest {
  document_ids: number[];
  /**
   * When true, persist `force_ocr=true` on every document before
   * re-queueing so the text-extract worker skips the PDF text layer and
   * runs OCR — mirrors the single-document `force_ocr` option.
   */
  force_ocr?: boolean;
}

export interface BatchReclassifyResponse {
  affected_documents: number;
}

/**
 * Re-run the OCR / classification / embedding pipeline for multiple
 * documents at once. Documents the caller cannot see are silently
 * skipped — same visibility pattern as `batchUpdateTags`. Workers are
 * triggered once after all rows are re-queued so a large selection does
 * not fan out into one wake-up per document.
 */
export const batchReclassify = api(
  { expose: true, method: "POST", path: "/documents/batch/reclassify", auth: true },
  async (req: BatchReclassifyRequest): Promise<BatchReclassifyResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }

    const groupIds = await loadUserGroupIds(userId);
    const visibleRows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            inArray(documents.id, req.document_ids),
            visibleDocumentsWhere(userId, groupIds),
          ),
        ),
    );
    const docIds = visibleRows.map((r) => r.id);
    if (docIds.length === 0) {
      return { affected_documents: 0 };
    }

    const patch: Partial<typeof documents.$inferInsert> = {
      status: "pending",
      last_error: null,
    };
    if (req.force_ocr !== undefined) patch.force_ocr = req.force_ocr;
    await db.update(documents).set(patch).where(inArray(documents.id, docIds));

    for (const id of docIds) {
      await requeueDocument(id);
    }
    triggerWorkers();

    return { affected_documents: docIds.length };
  },
);

// ─── Upload defaults (per-user preference) ─────────────────────────────────

export interface UploadDefaultsResponse {
  group_id: number | null;
}

export interface SetUploadDefaultsRequest {
  group_id: number | null;
}

/**
 * Get the caller's default group for new uploads. `group_id=null` means
 * new uploads stay private (no default set).
 */
export const getUploadDefaults = api(
  { expose: true, method: "GET", path: "/documents/upload-defaults", auth: true },
  async (): Promise<UploadDefaultsResponse> => {
    checkModule();
    const userId = getUserId();
    const row = await dbFirst<{ value: unknown }>(
      db
        .select({ value: documentsUserPref.value })
        .from(documentsUserPref)
        .where(
          and(
            eq(documentsUserPref.user_id, userId),
            eq(documentsUserPref.key, UPLOAD_DEFAULTS_PREF_KEY),
          ),
        ),
    );
    if (!row) return { group_id: null };
    const v = row.value as UploadDefaultsPref | null;
    return { group_id: v?.group_id ?? null };
  },
);

/**
 * Save the caller's default group for new uploads. Setting
 * `group_id=null` clears the preference (back to private). The caller
 * must currently be a member of the chosen group.
 */
export const setUploadDefaults = api(
  { expose: true, method: "PUT", path: "/documents/upload-defaults", auth: true },
  async (req: SetUploadDefaultsRequest): Promise<UploadDefaultsResponse> => {
    checkModule();
    const userId = getUserId();
    if (req.group_id != null) {
      await assertGroupMember(userId, req.group_id);
    }
    const value: UploadDefaultsPref = { group_id: req.group_id };
    await db
      .insert(documentsUserPref)
      .values({
        user_id: userId,
        key: UPLOAD_DEFAULTS_PREF_KEY,
        value,
      })
      .onConflictDoUpdate({
        target: [documentsUserPref.user_id, documentsUserPref.key],
        set: { value, updated_at: new Date().toISOString() },
      });
    return { group_id: req.group_id };
  },
);

export const deleteDocument = api(
  { expose: true, method: "DELETE", path: "/documents/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.delete");
    const userId = getUserId();

    const row = await loadAdministrableDocument(userId, id);
    // Drop tax hardlinks first so we don't leave dangling entries under
    // `_steuer/` after the canonical inode is freed. The DB delete then
    // cascades through tag/tax rows via FK ON DELETE.
    try {
      await dropTaxLinks(id);
    } catch (err) {
      console.warn(
        `[documents] delete: dropTaxLinks(${id}) failed: ${(err as Error).message}`,
      );
    }
    await db.delete(documents).where(eq(documents.id, id));
    try {
      assertPathUnderDocumentsRoot(row.disk_path);
      await fs.promises.unlink(row.disk_path).catch(() => {});
      await pruneEmptyDirs(path.dirname(row.disk_path));
    } catch (err) {
      console.warn(`[documents] delete: failed to unlink ${row.disk_path}: ${(err as Error).message}`);
    }
    return { success: true };
  },
);

export interface ReclassifyDocumentRequest {
  id: number;
  /**
   * When true, persist `force_ocr=true` on the document row before
   * re-queueing. The text-extract worker then skips the PDF text layer
   * and runs OCR — used to recover documents whose pre-baked text
   * layer has missing spaces or garbled glyphs.
   */
  force_ocr?: boolean;
}

export const reclassifyDocument = api(
  { expose: true, method: "POST", path: "/documents/:id/reclassify", auth: true },
  async (req: ReclassifyDocumentRequest): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    await loadVisibleDocument(userId, req.id);
    const patch: Partial<typeof documents.$inferInsert> = {
      status: "pending",
      last_error: null,
    };
    if (req.force_ocr !== undefined) patch.force_ocr = req.force_ocr;
    await db.update(documents).set(patch).where(eq(documents.id, req.id));
    await requeueDocument(req.id);
    triggerWorkers();
    return { success: true };
  },
);

// ─── Tax override ──────────────────────────────────────────────────────────

export interface UpdateDocumentTaxRequest {
  id: number;
  tax_relevant: boolean;
  tax_year?: number | null;
  tax_sections?: string[];
}

/**
 * Manually assign tax-return metadata to a document.
 *
 * Flipping any of these fields marks the document as `tax_reviewed=true`,
 * which keeps future classifier runs from overwriting the choice. Passing
 * `tax_relevant=false` wipes the year, confidence, and all section
 * assignments so the document disappears from the Steuer view.
 */
export const updateDocumentTax = api(
  { expose: true, method: "POST", path: "/documents/:id/tax", auth: true },
  async (req: UpdateDocumentTaxRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadVisibleDocument(userId, req.id);

    let year: number | null = null;
    if (req.tax_relevant) {
      if (req.tax_year === undefined || req.tax_year === null) {
        throw APIError.invalidArgument("tax_year is required when tax_relevant=true");
      }
      if (!Number.isInteger(req.tax_year) || req.tax_year < 2000 || req.tax_year > 2100) {
        throw APIError.invalidArgument("tax_year must be an integer between 2000 and 2100");
      }
      year = req.tax_year;
    }

    const slugs = req.tax_sections ?? [];
    if (req.tax_relevant && slugs.length === 0) {
      throw APIError.invalidArgument("tax_sections must not be empty when tax_relevant=true");
    }
    for (const s of slugs) {
      if (!isValidTaxSectionSlug(s.trim().toLowerCase())) {
        throw APIError.invalidArgument(`unknown tax section slug: ${s}`);
      }
    }

    await db
      .update(documents)
      .set({
        tax_relevant: req.tax_relevant,
        tax_year: year,
        // A manual override has full confidence — the human *is* the
        // ground truth from here on.
        tax_year_confidence: req.tax_relevant ? 1 : 0,
        tax_reviewed: true,
      })
      .where(eq(documents.id, existing.id));

    if (req.tax_relevant) {
      await replaceUserTaxSections(
        existing.id,
        slugs.map((s) => s.trim().toLowerCase()),
      );
    } else {
      await replaceUserTaxSections(existing.id, []);
    }

    // Rebuild the `_steuer/` hardlink view against the new tax metadata.
    try {
      await relocateDocument(existing.id);
    } catch (err) {
      console.warn(
        `[documents] relocate after tax update(${existing.id}) failed: ${(err as Error).message}`,
      );
    }

    return await loadDetail(userId, existing.id);
  },
);

// ─── Tax backfill ──────────────────────────────────────────────────────────

/**
 * Re-queue the `classify` job for every ready document the caller owns
 * whose tax status hasn't been reviewed yet. Used after rolling out the
 * tax-detection feature so existing uploads get their tax metadata
 * without the user having to re-upload.
 */
export const backfillDocumentTax = api(
  { expose: true, method: "POST", path: "/documents/tax/backfill", auth: true },
  async (): Promise<{ queued: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            visibleDocumentsWhere(userId, groupIds),
            eq(documents.status, "ready"),
            eq(documents.tax_reviewed, false),
          ),
        ),
    );
    for (const r of rows) {
      await requeueDocument(r.id, ["classify"], 3);
    }
    if (rows.length > 0) triggerWorkers();
    return { queued: rows.length };
  },
);

// ─── Embeddings backfill ───────────────────────────────────────────────────

/**
 * Re-queue the `embed` job for every ready document the caller owns and
 * drop the existing embedding rows. Used after embedding-strategy changes
 * that shift the vector space — for example switching the e5-family
 * `query: ` / `passage: ` prefix on/off, changing chunk overlap, or
 * migrating the column type from `vector` to `halfvec`. Idempotent: a
 * second run just re-runs the embed workers on the same rows.
 *
 * The job is scoped to the caller's visible documents; an admin can run
 * it per user. The previous embeddings are deleted up-front so that
 * search keeps returning *something* during the rebuild — partial new
 * vectors live alongside no old vectors, which is preferable to mixing
 * old and new vectors in the same ranking.
 */
export const backfillDocumentEmbeddings = api(
  { expose: true, method: "POST", path: "/documents/embeddings/backfill", auth: true },
  async (): Promise<{ queued: number; cleared: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            visibleDocumentsWhere(userId, groupIds),
            eq(documents.status, "ready"),
          ),
        ),
    );

    let cleared = 0;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const deleted = await db.execute<{ document_id: number }>(sql`
        DELETE FROM document_embeddings
        WHERE document_id = ANY(${ids}::int[])
        RETURNING document_id
      `);
      cleared = deleted.rows.length;
    }

    for (const r of rows) {
      await requeueDocument(r.id, ["embed"], 3);
    }
    if (rows.length > 0) triggerWorkers();
    return { queued: rows.length, cleared };
  },
);

// ─── Layout backfill ───────────────────────────────────────────────────────

export interface RelocateDocumentsResponse {
  relocated: number;
  skipped: number;
  failed: number;
}

/**
 * One-shot maintenance endpoint: walk every document visible to the
 * caller and call `relocateDocument` so files land at their canonical
 * speaking path. Run once after upgrading to the folder-structure
 * release; harmless to re-run because `relocateDocument` is idempotent.
 */
export const relocateDocumentsBackfill = api(
  { expose: true, method: "POST", path: "/documents/layout/backfill", auth: true },
  async (): Promise<RelocateDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number; disk_path: string }>(
      db
        .select({ id: documents.id, disk_path: documents.disk_path })
        .from(documents)
        .where(visibleDocumentsWhere(userId, groupIds)),
    );

    let relocated = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        const before = r.disk_path;
        const after = await relocateDocument(r.id);
        if (before === after) skipped += 1;
        else relocated += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[documents] layout backfill: relocate(${r.id}) failed: ${(err as Error).message}`,
        );
      }
    }
    return { relocated, skipped, failed };
  },
);

// ─── Tax listing / grouping ────────────────────────────────────────────────

export interface TaxSectionDTO {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  hint: string;
}

/**
 * Canonical list of German tax-return sections the classifier understands.
 * Exposed so the detail view's override form can render the same set of
 * checkboxes without duplicating the list.
 */
export const listTaxSectionsCatalog = api(
  { expose: true, method: "GET", path: "/documents/tax/sections", auth: true },
  async (): Promise<{ items: TaxSectionDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return {
      items: TAX_SECTIONS.map((s) => ({
        slug: s.slug,
        name: s.name,
        group: s.group,
        hint: s.hint,
      })),
    };
  },
);

// ─── Tax hint admin ────────────────────────────────────────────────────────

export interface TaxHintListResponse {
  items: TaxHintEntry[];
}

/**
 * List every tax-section with its default hint, effective hint and
 * whether it is currently overridden. Powers the hint admin page.
 */
export const listTaxHints = api(
  { expose: true, method: "GET", path: "/documents/tax/hints", auth: true },
  async (): Promise<TaxHintListResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    return { items: await listTaxHintEntries() };
  },
);

export interface UpdateTaxHintRequest {
  slug: string;
  hint: string;
}

/**
 * Set or replace the hint for a single tax section. The new hint is used
 * on the next classification run without a service restart.
 */
export const updateTaxHint = api(
  { expose: true, method: "PUT", path: "/documents/tax/hints/:slug", auth: true },
  async (req: UpdateTaxHintRequest): Promise<TaxHintEntry> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    const hint = typeof req.hint === "string" ? req.hint.trim() : "";
    if (hint.length === 0) {
      throw APIError.invalidArgument("hint must not be empty");
    }
    await upsertTaxHintOverride(req.slug, hint);
    const entries = await listTaxHintEntries();
    const entry = entries.find((e) => e.slug === req.slug);
    if (!entry) throw APIError.internal("hint entry missing after upsert");
    return entry;
  },
);

export interface ResetTaxHintRequest {
  slug: string;
}

/**
 * Remove the override for a section so the canonical default from
 * `documents/tax-sections.ts` is used again on the next classify run.
 */
export const resetTaxHint = api(
  { expose: true, method: "DELETE", path: "/documents/tax/hints/:slug", auth: true },
  async (req: ResetTaxHintRequest): Promise<TaxHintEntry> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    await deleteTaxHintOverride(req.slug);
    const entries = await listTaxHintEntries();
    const entry = entries.find((e) => e.slug === req.slug);
    if (!entry) throw APIError.internal("hint entry missing after reset");
    return entry;
  },
);

export interface ReclassifyTaxSectionRequest {
  slug: string;
  /**
   * When true, include documents the user has already manually reviewed.
   * Default false: tax-reviewed docs are locked and wouldn't change
   * anyway, so re-running them wastes LLM cycles.
   */
  include_reviewed?: boolean;
}

export interface ReclassifyTaxSectionResponse {
  queued: number;
}

/**
 * Re-queue every visible document currently assigned to `slug` for a
 * full classify run. Use this after tweaking the hint so existing
 * documents pick up the new instruction without touching each doc
 * individually.
 */
export const reclassifyTaxSection = api(
  { expose: true, method: "POST", path: "/documents/tax/hints/:slug/reclassify", auth: true },
  async (req: ReclassifyTaxSectionRequest): Promise<ReclassifyTaxSectionResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    const userId = getUserId();
    const groupIds = await loadUserGroupIds(userId);

    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(
          documentTaxSections,
          eq(documentTaxSections.document_id, documents.id),
        )
        .where(
          and(
            eq(documentTaxSections.tax_section, req.slug),
            visibleDocumentsWhere(userId, groupIds),
            req.include_reviewed ? undefined : eq(documents.tax_reviewed, false),
          ),
        ),
    );

    if (rows.length === 0) return { queued: 0 };

    // Only the classify stage depends on the hint — text_extract output
    // is unchanged, so we skip re-OCR and save LLM/CPU time.
    for (const r of rows) {
      await requeueDocument(r.id, ["classify"], 3);
    }
    triggerWorkers();
    return { queued: rows.length };
  },
);

export interface TaxYearCount {
  year: number;
  count: number;
}

export interface TaxYearsResponse {
  years: TaxYearCount[];
}

/**
 * Distinct tax years for the caller, with a document count per year.
 * Used by the Steuer view's year-selector chips.
 */
export const listTaxYears = api(
  { expose: true, method: "GET", path: "/documents/tax/years", auth: true },
  async (): Promise<TaxYearsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const visibility = groupIds.length === 0
      ? sql`(visibility = 'private' AND user_id = ${userId})`
      : sql`(
          (visibility = 'private' AND user_id = ${userId})
          OR (visibility = 'group' AND group_id = ANY(${groupIds}))
        )`;
    const rows = await db.execute<{ tax_year: number; count: string }>(sql`
      SELECT tax_year, COUNT(*)::text as count
      FROM documents
      WHERE ${visibility}
        AND tax_relevant = true
        AND tax_year IS NOT NULL
      GROUP BY tax_year
      ORDER BY tax_year DESC
    `);
    return {
      years: rows.rows.map((r) => ({
        year: r.tax_year,
        count: parseInt(r.count, 10),
      })),
    };
  },
);

export interface TaxDocumentAssignmentDTO {
  document: DocumentSummary;
  confidence: number | null;
  source: "ai" | "user";
}

export interface TaxSectionBucket {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  documents: TaxDocumentAssignmentDTO[];
}

export interface ListTaxDocumentsResponse {
  year: number | null;
  total_documents: number;
  sections: TaxSectionBucket[];
}

interface ListTaxDocumentsQuery {
  year?: Query<number>;
  section?: Query<string>;
}

/**
 * List all tax-relevant documents for the caller, grouped by German
 * tax-return section (Anlage). Sections appear in canonical order
 * (Einkünfte → Abzüge → Bescheid → Rahmen); inside each section
 * user-pinned assignments precede AI ones, then by confidence desc.
 *
 *   ?year=2025   — restrict to one tax year (omit for "all years")
 *   ?section=anlage-n — restrict to one section (still returned as a
 *                      one-element array so the client renderer stays
 *                      uniform)
 */
export const listTaxDocuments = api(
  { expose: true, method: "GET", path: "/documents/tax", auth: true },
  async ({ year, section }: ListTaxDocumentsQuery): Promise<ListTaxDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const sectionFilter =
      typeof section === "string" && section.trim().length > 0
        ? section.trim().toLowerCase()
        : null;
    if (sectionFilter !== null && !isValidTaxSectionSlug(sectionFilter)) {
      throw APIError.invalidArgument(`unknown tax section slug: ${section}`);
    }

    const yearFilter =
      typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2100
        ? year
        : null;

    const groupIds = await loadUserGroupIds(userId);
    const conds = [
      visibleDocumentsWhere(userId, groupIds),
      eq(documents.tax_relevant, true),
    ];
    if (yearFilter !== null) conds.push(eq(documents.tax_year, yearFilter));

    const docRows = await dbAll<typeof documents.$inferSelect & { cat_slug: string | null }>(
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
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(and(...conds))
        .orderBy(desc(documents.doc_date), desc(documents.uploaded_at)),
    );

    if (docRows.length === 0) {
      return { year: yearFilter, total_documents: 0, sections: [] };
    }

    const docIds = docRows.map((r) => r.id);
    const tagsByDoc = await fetchTagsForDocuments(docIds);
    const summaryById = new Map<number, DocumentSummary>();
    for (const r of docRows) {
      summaryById.set(r.id, toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? []));
    }

    const assignments = await dbAll<{
      document_id: number;
      tax_section: string;
      confidence: number | null;
      source: "ai" | "user";
    }>(
      db
        .select({
          document_id: documentTaxSections.document_id,
          tax_section: documentTaxSections.tax_section,
          confidence: documentTaxSections.confidence,
          source: documentTaxSections.source,
        })
        .from(documentTaxSections)
        .where(inArray(documentTaxSections.document_id, docIds)),
    );

    // Index assignments by slug, dropping unknown slugs and (if
    // requested) slugs outside the section filter.
    const bySlug = new Map<string, TaxDocumentAssignmentDTO[]>();
    const slugsPresent = new Set<string>();
    for (const a of assignments) {
      if (sectionFilter !== null && a.tax_section !== sectionFilter) continue;
      if (!isValidTaxSectionSlug(a.tax_section)) continue;
      const doc = summaryById.get(a.document_id);
      if (!doc) continue;
      slugsPresent.add(a.tax_section);
      const arr = bySlug.get(a.tax_section) ?? [];
      arr.push({ document: doc, confidence: a.confidence, source: a.source });
      bySlug.set(a.tax_section, arr);
    }

    const orderedSections = orderTaxSectionSlugs(Array.from(slugsPresent));
    const sections: TaxSectionBucket[] = [];
    const distinctDocs = new Set<number>();
    for (const meta of orderedSections) {
      const docs = bySlug.get(meta.slug) ?? [];
      docs.sort((a, b) => {
        if (a.source !== b.source) return a.source === "user" ? -1 : 1;
        const ca = a.confidence ?? 0;
        const cb = b.confidence ?? 0;
        if (ca !== cb) return cb - ca;
        const da = a.document.doc_date ?? "";
        const dbb = b.document.doc_date ?? "";
        return dbb.localeCompare(da);
      });
      for (const d of docs) distinctDocs.add(d.document.id);
      sections.push({
        slug: meta.slug,
        name: meta.name,
        group: meta.group,
        documents: docs,
      });
    }

    return {
      year: yearFilter,
      total_documents: distinctDocs.size,
      sections,
    };
  },
);

// ─── Taxonomy + queue ───────────────────────────────────────────────────────

export const listDocumentCategories = api(
  { expose: true, method: "GET", path: "/document-categories", auth: true },
  async (): Promise<{ items: DocumentCategoryDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const rows = await dbAll<typeof documentCategories.$inferSelect>(
      db.select().from(documentCategories),
    );

    // `sort_order` is stored per-parent (each level starts at 0), so a flat
    // ORDER BY would interleave roots with children of other branches. Walk
    // the tree depth-first to return parent → its children → next parent.
    const childrenByParent = new Map<number | null, typeof rows>();
    for (const r of rows) {
      const key = r.parent_id ?? null;
      const list = childrenByParent.get(key);
      if (list) list.push(r);
      else childrenByParent.set(key, [r]);
    }
    const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name);
    for (const list of childrenByParent.values()) list.sort(cmp);

    const ordered: typeof rows = [];
    const visit = (parentId: number | null) => {
      const children = childrenByParent.get(parentId);
      if (!children) return;
      for (const c of children) {
        ordered.push(c);
        visit(c.id);
      }
    };
    visit(null);

    return {
      items: ordered.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        parent_id: r.parent_id ?? null,
        icon: r.icon ?? null,
        sort_order: r.sort_order,
      })),
    };
  },
);

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchDocumentsResponse {
  items: DocumentSummary[];
  mode: SearchMode;
  query: string;
}

interface SearchQuery {
  q: Query<string>;
  mode?: Query<string>;
  limit?: Query<number>;
}

/**
 * Hybrid search over the caller's documents.
 *
 * `mode=fts` — lexical only (good for exact terms, invoice numbers).
 * `mode=semantic` — embedding-based (good for paraphrases).
 * `mode=hybrid` (default) — Reciprocal Rank Fusion of both branches.
 *
 * Returned documents keep the same shape as `GET /documents` so the
 * frontend can reuse the list renderer.
 */
export const searchDocumentsEndpoint = api(
  { expose: true, method: "GET", path: "/documents/search", auth: true },
  async ({ q, mode, limit }: SearchQuery): Promise<SearchDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const resolvedMode: SearchMode =
      mode === "fts" || mode === "semantic" || mode === "hybrid" ? mode : "hybrid";
    const lim = Math.min(Math.max(limit ?? 20, 1), 100);
    const query = (q ?? "").trim();
    if (query.length === 0) {
      return { items: [], mode: resolvedMode, query };
    }

    const hits = await searchDocuments({
      userId,
      query,
      mode: resolvedMode,
      limit: lim,
    });
    if (hits.length === 0) {
      return { items: [], mode: resolvedMode, query };
    }

    const ids = hits.map((h) => h.document_id);
    const groupIds = await loadUserGroupIds(userId);
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
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(and(visibleDocumentsWhere(userId, groupIds), inArray(documents.id, ids))),
    );

    const byId = new Map<number, (typeof rows)[number]>();
    for (const r of rows) byId.set(r.id, r);

    const tagsByDoc = await fetchTagsForDocuments(ids);

    // Preserve the ranked order — Postgres' WHERE IN is unordered.
    const items = hits
      .map((h) => {
        const r = byId.get(h.document_id);
        if (!r) return null;
        return toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? []);
      })
      .filter((x): x is DocumentSummary => x !== null);

    return { items, mode: resolvedMode, query };
  },
);

export const getDocumentQueueStatus = api(
  { expose: true, method: "GET", path: "/document-queue/status", auth: true },
  async () => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return await getQueueStatus();
  },
);

// ─── Taxonomy refinement (category suggestions) ─────────────────────────────

export interface CategorySuggestionDTO {
  id: number;
  suggested_name: string;
  parent_slug: string | null;
  example_document_ids: number[];
  rationale: string | null;
  status: "open" | "accepted" | "rejected";
  created_at: string | null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * List taxonomy refinements proposed by the classifier. Defaults to
 * `open` suggestions; pass `?status=` to surface accepted/rejected
 * for audit purposes.
 */
export const listCategorySuggestions = api(
  { expose: true, method: "GET", path: "/document-category-suggestions", auth: true },
  async ({ status }: { status?: Query<string> }): Promise<{ items: CategorySuggestionDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const filter = status === "accepted" || status === "rejected" ? status : "open";
    const rows = await dbAll<typeof documentCategorySuggestions.$inferSelect>(
      db
        .select()
        .from(documentCategorySuggestions)
        .where(eq(documentCategorySuggestions.status, filter as any))
        .orderBy(desc(documentCategorySuggestions.created_at)),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        suggested_name: r.suggested_name,
        parent_slug: r.parent_slug,
        example_document_ids: r.example_document_ids ?? [],
        rationale: r.rationale,
        status: r.status,
        created_at: r.created_at ?? null,
      })),
    };
  },
);

export interface AcceptSuggestionRequest {
  id: number;
  /** Optional admin override for the auto-derived slug. */
  slug?: string;
  /** Optional admin override for the suggested name. */
  name?: string;
}

/**
 * Accept a category suggestion: create the new `document_categories`
 * row (if no slug collision) and mark the suggestion as accepted.
 * Returns the new category id so the UI can offer a follow-up
 * "reclassify these examples" action.
 */
export const acceptCategorySuggestion = api(
  { expose: true, method: "POST", path: "/document-category-suggestions/:id/accept", auth: true },
  async (req: AcceptSuggestionRequest): Promise<{ category_id: number; slug: string }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const suggestion = await dbFirst<typeof documentCategorySuggestions.$inferSelect>(
      db.select().from(documentCategorySuggestions).where(eq(documentCategorySuggestions.id, req.id)),
    );
    if (!suggestion) throw APIError.notFound("suggestion not found");
    if (suggestion.status !== "open") {
      throw APIError.failedPrecondition(`suggestion is ${suggestion.status}`);
    }

    const name = (req.name ?? suggestion.suggested_name).trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const slug = (req.slug ?? slugify(name)).trim();
    if (!slug) throw APIError.invalidArgument("slug must not be empty");

    let parentId: number | null = null;
    if (suggestion.parent_slug) {
      const parent = await dbFirst<{ id: number }>(
        db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, suggestion.parent_slug)),
      );
      parentId = parent?.id ?? null;
    }

    const existing = await dbFirst<{ id: number }>(
      db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, slug)),
    );
    let categoryId: number;
    if (existing) {
      categoryId = existing.id;
    } else {
      const inserted = await dbFirst<{ id: number }>(
        db
          .insert(documentCategories)
          .values({ slug, name, parent_id: parentId })
          .returning({ id: documentCategories.id }),
      );
      if (!inserted) throw new Error("insert documentCategories: no row returned");
      categoryId = inserted.id;
    }

    await db
      .update(documentCategorySuggestions)
      .set({ status: "accepted" })
      .where(eq(documentCategorySuggestions.id, req.id));

    return { category_id: categoryId, slug };
  },
);

export const rejectCategorySuggestion = api(
  { expose: true, method: "POST", path: "/document-category-suggestions/:id/reject", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const updated = await db
      .update(documentCategorySuggestions)
      .set({ status: "rejected" })
      .where(and(eq(documentCategorySuggestions.id, id), eq(documentCategorySuggestions.status, "open")));
    if ((updated as any)?.rowCount === 0) {
      throw APIError.failedPrecondition("suggestion is not open");
    }
    return { success: true };
  },
);

// ─── Subject persons (Bezugspersonen) ──────────────────────────────────────

export interface SubjectPersonDTO {
  id: number;
  full_name: string;
  relation_tag: string;
  created_at: string;
  updated_at: string;
}

export interface SubjectPersonListResponse {
  items: SubjectPersonDTO[];
}

export interface CreateSubjectPersonRequest {
  full_name: string;
  relation_tag: string;
}

export interface UpdateSubjectPersonRequest {
  id: number;
  full_name?: string;
  relation_tag?: string;
}

export interface DeleteSubjectPersonRequest {
  id: number;
}

/**
 * List the caller's "Bezugspersonen" — the mapping of names that
 * appear on documents (e.g. "Erika Mustermann") to relationship tags
 * (e.g. "mutter") that the classifier should add as document tags
 * whenever it encounters the corresponding name on a page.
 */
export const listSubjectPersonsEndpoint = api(
  { expose: true, method: "GET", path: "/documents/subject-persons", auth: true },
  async (): Promise<SubjectPersonListResponse> => {
    checkModule();
    const userId = getUserId();
    const items = await listSubjectPersons(userId);
    return { items };
  },
);

export const createSubjectPersonEndpoint = api(
  { expose: true, method: "POST", path: "/documents/subject-persons", auth: true },
  async (req: CreateSubjectPersonRequest): Promise<SubjectPersonDTO> => {
    checkModule();
    const userId = getUserId();
    return await createSubjectPerson(userId, req);
  },
);

export const updateSubjectPersonEndpoint = api(
  { expose: true, method: "PATCH", path: "/documents/subject-persons/:id", auth: true },
  async (req: UpdateSubjectPersonRequest): Promise<SubjectPersonDTO> => {
    checkModule();
    const userId = getUserId();
    return await updateSubjectPerson(userId, req.id, {
      full_name: req.full_name,
      relation_tag: req.relation_tag,
    });
  },
);

export const deleteSubjectPersonEndpoint = api(
  { expose: true, method: "DELETE", path: "/documents/subject-persons/:id", auth: true },
  async (req: DeleteSubjectPersonRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    await deleteSubjectPerson(userId, req.id);
    return { success: true };
  },
);

// ─── Internal helpers ───────────────────────────────────────────────────────

async function loadDetail(userId: number, id: number): Promise<DocumentDetail> {
  const row = await loadVisibleDocument(userId, id);
  const cat = row.category_id
    ? await dbFirst<{ slug: string }>(
        db.select({ slug: documentCategories.slug }).from(documentCategories).where(eq(documentCategories.id, row.category_id)),
      )
    : undefined;
  const tagsMap = await fetchTagsForDocuments([id]);
  const taxSections = await fetchTaxSectionsForDocument(id);
  const preview = (row.extracted_text ?? "").slice(0, 2000);
  return {
    ...toSummary(row, cat?.slug ?? null, tagsMap.get(id) ?? []),
    summary: row.summary,
    extracted_text_preview: preview.length > 0 ? preview : null,
    tax_reviewed: row.tax_reviewed ?? false,
    tax_year_confidence: row.tax_year_confidence ?? null,
    tax_sections: taxSections,
  };
}

async function fetchTagsForDocuments(ids: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (ids.length === 0) return map;
  const rows = await dbAll<{ document_id: number; name: string }>(
    db
      .select({ document_id: documentTagLinks.document_id, name: documentTags.name })
      .from(documentTagLinks)
      .innerJoin(documentTags, eq(documentTagLinks.tag_id, documentTags.id))
      .where(inArray(documentTagLinks.document_id, ids)),
  );
  for (const r of rows) {
    const arr = map.get(r.document_id) ?? [];
    arr.push(r.name);
    map.set(r.document_id, arr);
  }
  return map;
}

async function replaceTags(documentId: number, tags: readonly string[]): Promise<void> {
  await db.delete(documentTagLinks).where(eq(documentTagLinks.document_id, documentId));
  const seen = new Set<string>();
  for (const raw of tags) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const inserted = await db
      .insert(documentTags)
      .values({ name })
      .onConflictDoNothing()
      .returning({ id: documentTags.id });
    let tagId: number | undefined = inserted[0]?.id;
    if (tagId === undefined) {
      const found = await dbFirst<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(eq(documentTags.name, name)),
      );
      tagId = found?.id;
    }
    if (tagId === undefined) continue;
    await db
      .insert(documentTagLinks)
      .values({ document_id: documentId, tag_id: tagId })
      .onConflictDoNothing();
  }
}

function toSummary(
  row: typeof documents.$inferSelect,
  categorySlug: string | null,
  tags: string[],
): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    status: row.status,
    uploaded_at: row.uploaded_at ?? null,
    doc_date: row.doc_date,
    sender: row.sender,
    category_id: row.category_id,
    category_slug: categorySlug,
    classification_confidence: row.classification_confidence,
    tags,
    tax_relevant: row.tax_relevant ?? false,
    tax_year: row.tax_year ?? null,
    last_error: row.last_error ?? null,
    visibility: row.visibility,
    group_id: row.group_id,
  };
}

async function fetchTaxSectionsForDocument(documentId: number): Promise<DocumentTaxSectionDTO[]> {
  const rows = await dbAll<{
    tax_section: string;
    confidence: number | null;
    source: "ai" | "user";
  }>(
    db
      .select({
        tax_section: documentTaxSections.tax_section,
        confidence: documentTaxSections.confidence,
        source: documentTaxSections.source,
      })
      .from(documentTaxSections)
      .where(eq(documentTaxSections.document_id, documentId)),
  );
  const items: DocumentTaxSectionDTO[] = [];
  for (const r of rows) {
    const meta = findTaxSection(r.tax_section);
    if (!meta) continue;
    items.push({
      slug: meta.slug,
      name: meta.name,
      group: meta.group,
      confidence: r.confidence,
      source: r.source,
    });
  }
  // Sort: user-sourced first, then descending confidence, stable by slug.
  items.sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (ca !== cb) return cb - ca;
    return a.slug.localeCompare(b.slug);
  });
  return items;
}
