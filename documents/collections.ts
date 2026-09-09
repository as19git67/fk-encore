/**
 * Sammelmappen — several documents gathered under one title, exported as one PDF.
 *
 * A document belongs to as many collections as it likes, and what is true of
 * it *in a collection* — where it sits in the order, whether it is currently
 * switched on, which of its pages are left out — lives on the membership row,
 * never on the document. Removing a document from a collection therefore does
 * nothing to the document, and the same statement can be whole in the folder
 * for the Steuerberater and reduced to its last page in the one for the
 * insurer.
 *
 * **What a collection may contain.** A collection never widens access to what
 * is inside it, so every reader of the collection must independently be able
 * to read every member. For a private collection that is trivially true. For
 * a group collection it means the members have to be shared with that same
 * group — enforced on add (`assertMembersFitVisibility`) and again when a
 * collection is shared, because otherwise a group-wide summary and table of
 * contents would describe documents half the group cannot open.
 *
 * **The summary is never written on the request that invalidated it.** Adding
 * ten documents would mean ten model runs while the user waits, nine of them
 * describing a folder that has already moved on. Mutations set
 * `summary_stale`; the background job in collection-summary-cron.ts coalesces
 * and rewrites.
 */

import fs from "fs";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  documentCategories,
  documentCollectionItems,
  documentCollections,
  documents,
  groupMembers,
} from "../db/schema";
import { assertPathUnderDocumentsRoot } from "./documents.service";
import { assertGroupMember, loadUserGroupIds, visibleDocumentsWhere } from "./visibility";
import { shouldUseTesseractSidecar } from "./receipt-capture";
import { ensureSearchablePdf } from "./ocr-pdf";
import {
  buildCollectionPdf,
  normalizeExcludedPages,
  type CollectionPdfMember,
} from "./collection-pdf";

console.log("[boot] documents/collections.ts: all imports resolved");

type CollectionRow = typeof documentCollections.$inferSelect;

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

function isDataAdmin(authData: { permissions: string[] }): boolean {
  return authData.permissions.includes("data.manage");
}

/**
 * The file whose pages go into the export.
 *
 * Mirrors `downloadDocument`: regular scans are served through their
 * searchable ("sandwich") sidecar so the assembled PDF stays selectable and
 * searchable, while PaddleOCR receipt captures keep their prepared scan —
 * rasterizing that through Tesseract visibly costs thermal-print detail.
 */
async function exportSourcePath(row: {
  id: number;
  disk_path: string;
  receipt_ocr_state: string | null;
}): Promise<{ path: string; mime: string } | null> {
  try {
    assertPathUnderDocumentsRoot(row.disk_path);
  } catch {
    return null;
  }
  if (shouldUseTesseractSidecar(row.receipt_ocr_state as any)) {
    const ocrPath = await ensureSearchablePdf(row.id, row.disk_path);
    if (ocrPath) return { path: ocrPath, mime: "application/pdf" };
  }
  try {
    await fs.promises.access(row.disk_path, fs.constants.R_OK);
  } catch {
    return null;
  }
  return { path: row.disk_path, mime: "" };
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface CollectionSummaryDTO {
  id: number;
  title: string;
  notes: string | null;
  summary: string | null;
  summary_stale: boolean;
  summary_error: string | null;
  summary_generated_at: string | null;
  include_cover: boolean;
  include_toc: boolean;
  include_summary: boolean;
  visibility: "private" | "group";
  group_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  /** Members in the folder, switched on or off. */
  item_count: number;
  /** Members that would actually reach the PDF. */
  included_count: number;
  /** True when the caller may rename, share or delete this collection. */
  can_administer: boolean;
}

export interface CollectionItemDTO {
  document_id: number;
  position: number;
  included: boolean;
  excluded_pages: number[];
  title: string | null;
  original_filename: string;
  mime_type: string;
  sender: string | null;
  doc_date: string | null;
  category_slug: string | null;
  status: "pending" | "extracting" | "classifying" | "ready" | "failed";
  /** Pages the document has, when the pipeline counted them. */
  pages_total: number | null;
  visibility: "private" | "group";
  group_id: number | null;
}

export interface CollectionDetailDTO extends CollectionSummaryDTO {
  items: CollectionItemDTO[];
}

export interface ListCollectionsResponse {
  items: CollectionSummaryDTO[];
}

// ─── Access ─────────────────────────────────────────────────────────────────

/**
 * Load a collection the caller may read: their own private one, or a group
 * one in a group they belong to. `data.manage` admins may read any, matching
 * how they already see every document.
 */
async function loadReadableCollection(
  userId: number,
  collectionId: number,
  isAdmin: boolean,
): Promise<CollectionRow> {
  const row = await dbFirst<CollectionRow>(
    db.select().from(documentCollections).where(eq(documentCollections.id, collectionId)),
  );
  if (!row) throw APIError.notFound("collection not found");
  if (isAdmin) return row;
  if (row.visibility === "private") {
    if (row.user_id !== userId) throw APIError.notFound("collection not found");
    return row;
  }
  const groupIds = await loadUserGroupIds(userId);
  if (row.group_id == null || !groupIds.includes(row.group_id)) {
    throw APIError.notFound("collection not found");
  }
  return row;
}

/**
 * Who may change what.
 *
 * Editing the folder — title, note, membership, order, page selection — is
 * open to everyone who can read it, because a shared folder that only its
 * creator can fill is not shared. Renaming out from under the group is the
 * same act as editing, so it lives here too; only *sharing* and *deleting*
 * are narrowed further, in `assertCollectionAdministrable`.
 */
async function loadEditableCollection(
  userId: number,
  collectionId: number,
  isAdmin: boolean,
): Promise<CollectionRow> {
  return await loadReadableCollection(userId, collectionId, isAdmin);
}

/**
 * Deleting a collection, or changing who it is shared with, is the creator's
 * call (or a group owner's, or an admin's) — not every member's.
 */
async function assertCollectionAdministrable(
  row: CollectionRow,
  userId: number,
  isAdmin: boolean,
): Promise<void> {
  if (isAdmin) return;
  if (row.user_id === userId) return;
  if (row.visibility === "group" && row.group_id != null) {
    const membership = await dbFirst<{ role: "owner" | "member" }>(
      db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(
          and(eq(groupMembers.group_id, row.group_id), eq(groupMembers.user_id, userId)),
        ),
    );
    if (membership?.role === "owner") return;
  }
  throw APIError.permissionDenied(
    "only the creator or a group owner may share or delete this collection",
  );
}

/**
 * Every reader of the collection must be able to read every member.
 *
 * A private collection is read by its creator alone, so anything they can see
 * qualifies. A group collection is read by the whole group, so its members
 * have to be shared with that same group — a private document inside one
 * would show up in the group's table of contents and summary while staying
 * unopenable for everyone but its owner.
 */
export function membersFitVisibility(
  collection: { visibility: "private" | "group"; group_id: number | null },
  docs: Array<{ id: number; visibility: "private" | "group"; group_id: number | null }>,
): number[] {
  if (collection.visibility === "private") return [];
  return docs
    .filter((doc) => doc.visibility !== "group" || doc.group_id !== collection.group_id)
    .map((doc) => doc.id);
}

function assertMembersFitVisibility(
  collection: { visibility: "private" | "group"; group_id: number | null },
  docs: Array<{ id: number; visibility: "private" | "group"; group_id: number | null }>,
): void {
  const offenders = membersFitVisibility(collection, docs);
  if (offenders.length === 0) return;
  throw APIError.failedPrecondition(
    `a group collection may only contain documents shared with the same group; ` +
      `not shared: ${offenders.join(", ")}`,
  );
}

/** Load the documents the caller may see, out of a set of ids. */
async function loadVisibleDocumentsById(
  userId: number,
  ids: number[],
  isAdmin: boolean,
): Promise<Array<typeof documents.$inferSelect>> {
  if (ids.length === 0) return [];
  if (isAdmin) {
    return await dbAll(db.select().from(documents).where(inArray(documents.id, ids)));
  }
  const groupIds = await loadUserGroupIds(userId);
  return await dbAll(
    db
      .select()
      .from(documents)
      .where(and(inArray(documents.id, ids), visibleDocumentsWhere(userId, groupIds))),
  );
}

/** Mark the summary as needing a rewrite and bump the change timestamp. */
async function touchCollection(collectionId: number): Promise<void> {
  await dbExec(
    db
      .update(documentCollections)
      .set({ summary_stale: true, updated_at: sql`now()` })
      .where(eq(documentCollections.id, collectionId)),
  );
}

/** Renumber a collection's items to a dense 0-based sequence. */
async function renumber(collectionId: number, orderedItemIds: number[]): Promise<void> {
  for (let index = 0; index < orderedItemIds.length; index++) {
    await dbExec(
      db
        .update(documentCollectionItems)
        .set({ position: index })
        .where(eq(documentCollectionItems.id, orderedItemIds[index])),
    );
  }
}

async function toSummaryDTO(
  row: CollectionRow,
  userId: number,
  isAdmin: boolean,
): Promise<CollectionSummaryDTO> {
  const counts = await dbFirst<{ total: number; included: number }>(
    db
      .select({
        total: sql<number>`count(*)::int`,
        included: sql<number>`count(*) filter (where ${documentCollectionItems.included})::int`,
      })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, row.id)),
  );
  let canAdminister = true;
  try {
    await assertCollectionAdministrable(row, userId, isAdmin);
  } catch {
    canAdminister = false;
  }
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    summary: row.summary,
    summary_stale: row.summary_stale,
    summary_error: row.summary_error,
    summary_generated_at: row.summary_generated_at,
    include_cover: row.include_cover,
    include_toc: row.include_toc,
    include_summary: row.include_summary,
    visibility: row.visibility,
    group_id: row.group_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    item_count: counts?.total ?? 0,
    included_count: counts?.included ?? 0,
    can_administer: canAdminister,
  };
}

async function loadItems(collectionId: number): Promise<CollectionItemDTO[]> {
  const rows = await dbAll<{
    document_id: number;
    position: number;
    included: boolean;
    excluded_pages: number[] | null;
    title: string | null;
    original_filename: string;
    mime_type: string;
    sender: string | null;
    doc_date: string | null;
    category_slug: string | null;
    status: CollectionItemDTO["status"];
    pages_total: number | null;
    visibility: "private" | "group";
    group_id: number | null;
  }>(
    db
      .select({
        document_id: documentCollectionItems.document_id,
        position: documentCollectionItems.position,
        included: documentCollectionItems.included,
        excluded_pages: documentCollectionItems.excluded_pages,
        title: documents.title,
        original_filename: documents.original_filename,
        mime_type: documents.mime_type,
        sender: documents.sender,
        doc_date: documents.doc_date,
        category_slug: documentCategories.slug,
        status: documents.status,
        pages_total: documents.pages_total,
        visibility: documents.visibility,
        group_id: documents.group_id,
      })
      .from(documentCollectionItems)
      .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
      .leftJoin(documentCategories, eq(documentCategories.id, documents.category_id))
      .where(eq(documentCollectionItems.collection_id, collectionId))
      .orderBy(asc(documentCollectionItems.position)),
  );
  return rows.map((row) => ({
    ...row,
    excluded_pages: normalizeExcludedPages(row.excluded_pages),
  }));
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export const listCollections = api(
  { expose: true, method: "GET", path: "/document-collections", auth: true },
  async (): Promise<ListCollectionsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const groupIds = await loadUserGroupIds(userId);

    const ownPrivate = and(
      eq(documentCollections.visibility, "private"),
      eq(documentCollections.user_id, userId),
    )!;
    const where = isAdmin
      ? undefined
      : groupIds.length > 0
        ? or(
            ownPrivate,
            and(
              eq(documentCollections.visibility, "group"),
              inArray(documentCollections.group_id, groupIds),
            ),
          )!
        : ownPrivate;

    const rows = await dbAll<CollectionRow>(
      db
        .select()
        .from(documentCollections)
        .where(where)
        .orderBy(desc(documentCollections.updated_at)),
    );
    const items = await Promise.all(rows.map((row) => toSummaryDTO(row, userId, isAdmin)));
    return { items };
  },
);

export interface CreateCollectionRequest {
  title: string;
  notes?: string | null;
  visibility?: "private" | "group";
  group_id?: number | null;
  /** Documents to seed the collection with, in the order given. */
  document_ids?: number[];
}

export const createCollection = api(
  { expose: true, method: "POST", path: "/document-collections", auth: true },
  async (req: CreateCollectionRequest): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);

    const title = (req.title ?? "").trim();
    if (!title) throw APIError.invalidArgument("title must not be empty");

    const visibility = req.visibility ?? "private";
    const groupId = visibility === "group" ? (req.group_id ?? null) : null;
    if (visibility === "group") {
      if (groupId == null) {
        throw APIError.invalidArgument("group_id is required for a group collection");
      }
      await assertGroupMember(userId, groupId);
    }

    const created = await dbInsertReturning<CollectionRow>(
      db
        .insert(documentCollections)
        .values({
          user_id: userId,
          title,
          notes: req.notes?.trim() || null,
          visibility,
          group_id: groupId,
        })
        .returning(),
    );
    if (!created) throw APIError.internal("failed to create collection");

    if (req.document_ids?.length) {
      await addDocumentsToCollection(created, req.document_ids, userId, isAdmin);
    }
    return await buildDetail(created.id, userId, isAdmin);
  },
);

async function buildDetail(
  collectionId: number,
  userId: number,
  isAdmin: boolean,
): Promise<CollectionDetailDTO> {
  const row = await loadReadableCollection(userId, collectionId, isAdmin);
  const summary = await toSummaryDTO(row, userId, isAdmin);
  return { ...summary, items: await loadItems(collectionId) };
}

export const getCollection = api(
  { expose: true, method: "GET", path: "/document-collections/:id", auth: true },
  async ({ id }: { id: number }): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return await buildDetail(id, getUserId(), isDataAdmin(authData));
  },
);

export interface UpdateCollectionRequest {
  id: number;
  title?: string;
  notes?: string | null;
  /** Hand-written override of the generated summary. Clears the stale flag. */
  summary?: string | null;
  include_cover?: boolean;
  include_toc?: boolean;
  include_summary?: boolean;
  visibility?: "private" | "group";
  group_id?: number | null;
}

export const updateCollection = api(
  { expose: true, method: "PATCH", path: "/document-collections/:id", auth: true },
  async (req: UpdateCollectionRequest): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadEditableCollection(userId, req.id, isAdmin);

    const patch: Record<string, unknown> = { updated_at: sql`now()` };
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw APIError.invalidArgument("title must not be empty");
      patch.title = title;
    }
    if (req.notes !== undefined) patch.notes = req.notes?.trim() || null;
    if (req.summary !== undefined) {
      // A hand-written summary is the user's answer, not a draft the job may
      // overwrite: pin it by clearing the stale flag.
      patch.summary = req.summary?.trim() || null;
      patch.summary_stale = false;
      patch.summary_error = null;
      patch.summary_generated_at = sql`now()`;
    }
    if (req.include_cover !== undefined) patch.include_cover = req.include_cover;
    if (req.include_toc !== undefined) patch.include_toc = req.include_toc;
    if (req.include_summary !== undefined) patch.include_summary = req.include_summary;

    if (req.visibility !== undefined) {
      await assertCollectionAdministrable(row, userId, isAdmin);
      const visibility = req.visibility;
      const groupId = visibility === "group" ? (req.group_id ?? row.group_id ?? null) : null;
      if (visibility === "group") {
        if (groupId == null) {
          throw APIError.invalidArgument("group_id is required for a group collection");
        }
        await assertGroupMember(userId, groupId);
        const memberDocs = await dbAll<{
          id: number;
          visibility: "private" | "group";
          group_id: number | null;
        }>(
          db
            .select({
              id: documents.id,
              visibility: documents.visibility,
              group_id: documents.group_id,
            })
            .from(documentCollectionItems)
            .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
            .where(eq(documentCollectionItems.collection_id, row.id)),
        );
        assertMembersFitVisibility({ visibility, group_id: groupId }, memberDocs);
      }
      patch.visibility = visibility;
      patch.group_id = groupId;
    }

    await dbExec(
      db.update(documentCollections).set(patch).where(eq(documentCollections.id, row.id)),
    );
    return await buildDetail(row.id, userId, isAdmin);
  },
);

export const deleteCollection = api(
  { expose: true, method: "DELETE", path: "/document-collections/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadReadableCollection(userId, id, isAdmin);
    await assertCollectionAdministrable(row, userId, isAdmin);
    await dbExec(db.delete(documentCollections).where(eq(documentCollections.id, id)));
    return { deleted: true };
  },
);

// ─── Membership ─────────────────────────────────────────────────────────────

/**
 * Append documents to a collection, keeping the order they were given in and
 * ignoring the ones already there. Returns how many were newly added.
 */
async function addDocumentsToCollection(
  collection: CollectionRow,
  documentIds: number[],
  userId: number,
  isAdmin: boolean,
): Promise<number> {
  const wanted = [...new Set(documentIds.filter((id) => Number.isFinite(id)))];
  if (wanted.length === 0) return 0;

  const visible = await loadVisibleDocumentsById(userId, wanted, isAdmin);
  const byId = new Map(visible.map((doc) => [doc.id, doc]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw APIError.notFound(`document not found: ${missing.join(", ")}`);
  }
  assertMembersFitVisibility(collection, visible);

  const existing = await dbAll<{ document_id: number }>(
    db
      .select({ document_id: documentCollectionItems.document_id })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, collection.id)),
  );
  const present = new Set(existing.map((row) => row.document_id));
  const fresh = wanted.filter((id) => !present.has(id));
  if (fresh.length === 0) return 0;

  const next = await dbFirst<{ next: number }>(
    db
      .select({ next: sql<number>`coalesce(max(${documentCollectionItems.position}), -1) + 1` })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, collection.id)),
  );
  let position = next?.next ?? 0;
  await dbExec(
    db.insert(documentCollectionItems).values(
      fresh.map((documentId) => ({
        collection_id: collection.id,
        document_id: documentId,
        position: position++,
      })),
    ),
  );
  await touchCollection(collection.id);
  return fresh.length;
}

export interface AddCollectionDocumentsRequest {
  id: number;
  document_ids: number[];
}

export const addCollectionDocuments = api(
  {
    expose: true,
    method: "POST",
    path: "/document-collections/:id/documents",
    auth: true,
  },
  async (req: AddCollectionDocumentsRequest): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadEditableCollection(userId, req.id, isAdmin);
    await addDocumentsToCollection(row, req.document_ids ?? [], userId, isAdmin);
    return await buildDetail(row.id, userId, isAdmin);
  },
);

export const removeCollectionDocument = api(
  {
    expose: true,
    method: "DELETE",
    path: "/document-collections/:id/documents/:documentId",
    auth: true,
  },
  async ({
    id,
    documentId,
  }: {
    id: number;
    documentId: number;
  }): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadEditableCollection(userId, id, isAdmin);
    await dbExec(
      db
        .delete(documentCollectionItems)
        .where(
          and(
            eq(documentCollectionItems.collection_id, id),
            eq(documentCollectionItems.document_id, documentId),
          ),
        ),
    );
    const remaining = await dbAll<{ id: number }>(
      db
        .select({ id: documentCollectionItems.id })
        .from(documentCollectionItems)
        .where(eq(documentCollectionItems.collection_id, id))
        .orderBy(asc(documentCollectionItems.position)),
    );
    await renumber(id, remaining.map((item) => item.id));
    await touchCollection(id);
    return await buildDetail(row.id, userId, isAdmin);
  },
);

export interface ReorderCollectionRequest {
  id: number;
  /** Every member document id, in the order they should appear. */
  document_ids: number[];
}

/**
 * The new order, given the requested sequence and what is actually in the
 * collection. Ids the caller left out keep their relative order and follow the
 * named ones — a stale client list must reorder what it knows about without
 * dropping a document somebody else added in the meantime. Unknown ids are
 * ignored.
 */
export function resolveOrder(
  current: Array<{ document_id: number }>,
  requested: number[],
): number[] {
  const known = new Set(current.map((item) => item.document_id));
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const id of requested) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const item of current) {
    if (!seen.has(item.document_id)) ordered.push(item.document_id);
  }
  return ordered;
}

export const reorderCollection = api(
  {
    expose: true,
    method: "PUT",
    path: "/document-collections/:id/order",
    auth: true,
  },
  async (req: ReorderCollectionRequest): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadEditableCollection(userId, req.id, isAdmin);

    const current = await dbAll<{ id: number; document_id: number }>(
      db
        .select({
          id: documentCollectionItems.id,
          document_id: documentCollectionItems.document_id,
        })
        .from(documentCollectionItems)
        .where(eq(documentCollectionItems.collection_id, req.id))
        .orderBy(asc(documentCollectionItems.position)),
    );
    const itemIdByDocument = new Map(current.map((item) => [item.document_id, item.id]));
    const ordered = resolveOrder(current, req.document_ids ?? []);
    await renumber(
      req.id,
      ordered.map((documentId) => itemIdByDocument.get(documentId)!),
    );
    // The order changes what the summary describes ("beginnt mit …"), so it
    // counts as a change like any other.
    await touchCollection(req.id);
    return await buildDetail(row.id, userId, isAdmin);
  },
);

export interface UpdateCollectionItemRequest {
  id: number;
  documentId: number;
  /** Switch the whole document on or off without losing its page selection. */
  included?: boolean;
  /** 1-based page numbers to leave out of the PDF. */
  excluded_pages?: number[];
}

export const updateCollectionItem = api(
  {
    expose: true,
    method: "PATCH",
    path: "/document-collections/:id/documents/:documentId",
    auth: true,
  },
  async (req: UpdateCollectionItemRequest): Promise<CollectionDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);
    const row = await loadEditableCollection(userId, req.id, isAdmin);

    const patch: Record<string, unknown> = {};
    if (req.included !== undefined) patch.included = req.included;
    if (req.excluded_pages !== undefined) {
      patch.excluded_pages = normalizeExcludedPages(req.excluded_pages);
    }
    if (Object.keys(patch).length === 0) {
      return await buildDetail(row.id, userId, isAdmin);
    }
    const result = await dbExec(
      db
        .update(documentCollectionItems)
        .set(patch)
        .where(
          and(
            eq(documentCollectionItems.collection_id, req.id),
            eq(documentCollectionItems.document_id, req.documentId),
          ),
        ),
    );
    if (result.changes === 0) throw APIError.notFound("document not in this collection");
    await touchCollection(req.id);
    return await buildDetail(row.id, userId, isAdmin);
  },
);

// ─── "Which folders is this document in?" ───────────────────────────────────

export interface DocumentCollectionRefDTO {
  id: number;
  title: string;
  included: boolean;
}

export interface ListDocumentCollectionsResponse {
  items: DocumentCollectionRefDTO[];
}

export const listCollectionsForDocument = api(
  {
    expose: true,
    method: "GET",
    path: "/documents/:id/collections",
    auth: true,
  },
  async ({ id }: { id: number }): Promise<ListDocumentCollectionsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = isDataAdmin(authData);

    const rows = await dbAll<DocumentCollectionRefDTO>(
      db
        .select({
          id: documentCollections.id,
          title: documentCollections.title,
          included: documentCollectionItems.included,
        })
        .from(documentCollectionItems)
        .innerJoin(
          documentCollections,
          eq(documentCollections.id, documentCollectionItems.collection_id),
        )
        .where(eq(documentCollectionItems.document_id, id))
        .orderBy(asc(documentCollections.title)),
    );
    if (isAdmin) return { items: rows };
    // Re-check readability per row rather than folding it into the join: the
    // two rules (own private / group membership) already live in one place.
    const readable: DocumentCollectionRefDTO[] = [];
    for (const ref of rows) {
      try {
        await loadReadableCollection(userId, ref.id, false);
        readable.push(ref);
      } catch {
        /* not visible to this caller */
      }
    }
    return { items: readable };
  },
);

// ─── Export ─────────────────────────────────────────────────────────────────

/** Filename for the downloaded PDF, derived from the collection's title. */
export function collectionPdfFilename(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || "sammelmappe"}.pdf`;
}

/**
 * The collection as one PDF, assembled on demand.
 *
 * Members switched off, members the caller may not read, and members whose
 * every page is deselected all drop out; the response header
 * `X-Collection-Skipped` names how many, so the frontend can say so without a
 * second round trip.
 */
export const downloadCollectionPdf = api.raw(
  { expose: true, method: "GET", path: "/document-collections/:id/pdf", auth: true },
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
    const match = /\/document-collections\/(\d+)\/pdf/.exec(req.url ?? "");
    const collectionId = match ? parseInt(match[1], 10) : NaN;
    if (!Number.isFinite(collectionId)) {
      res.statusCode = 400;
      res.end("Invalid id");
      return;
    }

    try {
      const bytes = await renderCollectionPdf(collectionId, userId, isDataAdmin(authData));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(bytes.bytes.length));
      res.setHeader("X-Collection-Skipped", String(bytes.skipped.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(bytes.filename)}`,
      );
      res.end(bytes.bytes);
    } catch (err: any) {
      const code = err instanceof APIError ? ((err as any).statusCode ?? 500) : 500;
      console.error("[documents] collection export failed:", err?.message ?? err);
      res.statusCode = code === 500 ? 500 : code;
      res.end(err?.message ?? "Export failed");
    }
  },
);

/**
 * Gather the collection's readable, switched-on members and assemble the PDF.
 * Split out of the endpoint so the assembly is reachable from a test and from
 * any future scheduled export without going through HTTP.
 */
export async function renderCollectionPdf(
  collectionId: number,
  userId: number,
  isAdmin: boolean,
): Promise<{
  bytes: Buffer;
  filename: string;
  skipped: Array<{ document_id: number; reason: string }>;
}> {
  const collection = await loadReadableCollection(userId, collectionId, isAdmin);
  const items = await dbAll<{
    document_id: number;
    excluded_pages: number[] | null;
  }>(
    db
      .select({
        document_id: documentCollectionItems.document_id,
        excluded_pages: documentCollectionItems.excluded_pages,
      })
      .from(documentCollectionItems)
      .where(
        and(
          eq(documentCollectionItems.collection_id, collectionId),
          eq(documentCollectionItems.included, true),
        ),
      )
      .orderBy(asc(documentCollectionItems.position)),
  );

  const docs = await loadVisibleDocumentsById(
    userId,
    items.map((item) => item.document_id),
    isAdmin,
  );
  const byId = new Map(docs.map((doc) => [doc.id, doc]));

  const members: CollectionPdfMember[] = [];
  const skipped: Array<{ document_id: number; reason: string }> = [];
  for (const item of items) {
    const doc = byId.get(item.document_id);
    if (!doc) {
      skipped.push({ document_id: item.document_id, reason: "not_visible" });
      continue;
    }
    const source = await exportSourcePath({
      id: doc.id,
      disk_path: doc.disk_path,
      receipt_ocr_state: doc.receipt_ocr_state,
    });
    if (!source) {
      skipped.push({ document_id: item.document_id, reason: "file_missing" });
      continue;
    }
    members.push({
      document_id: doc.id,
      title: doc.title?.trim() || doc.original_filename,
      sender: doc.sender,
      doc_date: doc.doc_date,
      source_path: source.path,
      mime_type: source.mime || doc.mime_type,
      excluded_pages: normalizeExcludedPages(item.excluded_pages),
    });
  }

  if (members.length === 0 && !collection.include_cover) {
    throw APIError.failedPrecondition("collection has no exportable documents");
  }

  const result = await buildCollectionPdf(
    {
      title: collection.title,
      notes: collection.notes,
      summary: collection.summary,
      include_cover: collection.include_cover,
      include_toc: collection.include_toc,
      include_summary: collection.include_summary,
    },
    members,
  );
  return {
    bytes: result.bytes,
    filename: collectionPdfFilename(collection.title),
    skipped: [...skipped, ...result.skipped],
  };
}
