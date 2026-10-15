/**
 * Sammelmappen for every entity type (#1548, stage 1).
 *
 * A collection used to be a folder of documents. It now holds photos, albums,
 * transactions, securities, meters and single meter readings as well — of one
 * type, or of any (`entity_type` NULL). The folder itself is still the row in
 * `document_collections`, so who may read, edit and administer it is the rule
 * the document folders already follow (documents/collection-access.ts).
 *
 * What a reader sees *inside* is decided per member by the member's module
 * (members.ts). Documents keep their membership table, because only a
 * document has a place in the PDF, pages and redactions; adding or removing
 * one here goes through the same code as the document folder endpoints.
 */

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { dbAll, dbExec, dbInsertReturning } from "../db/adapter";
import {
  collectionMembers,
  collectionUserState,
  documentCollectionItems,
  documentCollections,
  type CollectionEntityType,
  type CollectionMemberType,
} from "../db/schema";
import {
  assertCollectionAdministrable,
  loadReadableCollection,
  readableCollectionsWhere,
  type CollectionRow,
} from "../documents/collection-access";
import {
  addDocumentsToCollection,
  removeDocumentFromCollection,
} from "../documents/collection-membership";
import { removeCollectionExports } from "../documents/collection-export";
import { assertGroupMember, loadUserGroupIds } from "../documents/visibility";
import type { CollectionKind } from "../documents/dossiers";
import {
  applyMemberRule,
  excludeFromRule,
  normalizeMemberRule,
  ruleOf,
  type MemberRule,
  type RuleApplyResult,
} from "./rules";
import { createAlbumLogic, batchUpdateAlbumPhotosLogic } from "../photo/photo.service";
import {
  COLLECTION_ENTITY_TYPES,
  isCollectionEntityType,
  mayUseType,
  resolveMembers,
  type Caller,
  type MemberDisplay,
} from "./members";

// ─── Caller ─────────────────────────────────────────────────────────────────

function caller(): Caller {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return { userId: parseInt(authData.userID, 10), permissions: authData.permissions };
}

/** Folder-level admin: the same `data.manage` that reads every document folder. */
function isAdmin(c: Caller): boolean {
  return c.permissions.includes("data.manage");
}

/** Anyone who uses at least one module that can put something into a collection. */
function assertMayUseCollections(c: Caller): void {
  if (!COLLECTION_ENTITY_TYPES.some((type) => mayUseType(c, type))) {
    throw APIError.permissionDenied("no module that can use collections");
  }
}

function parseEntityType(value: unknown, field: string): CollectionEntityType {
  if (!isCollectionEntityType(value)) {
    throw APIError.invalidArgument(`${field} must be one of ${COLLECTION_ENTITY_TYPES.join(", ")}`);
  }
  return value;
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface CollectionSummary {
  id: number;
  name: string;
  description: string | null;
  /** The one type the collection holds, or null for any. */
  entity_type: CollectionEntityType | null;
  kind: CollectionKind;
  visibility: "private" | "group";
  group_id: number | null;
  archived_at: string | null;
  created_by: "user" | "assistant";
  created_at: string;
  updated_at: string;
  /** The caller's own star and last visit. */
  favourite: boolean;
  last_opened_at: string | null;
  /** Members per type, as stored; what a reader may open can be fewer. */
  counts: Partial<Record<CollectionEntityType, number>>;
  total: number;
  /** True when the caller may share, archive or delete it. */
  can_administer: boolean;
  /** The membership rule of a rule collection (#1548, stage 5); null otherwise. */
  rule: MemberRule | null;
}

export interface CollectionMember extends MemberDisplay {
  entity_type: CollectionEntityType;
  entity_id: number;
  joined_by: "user" | "rule";
  added_at: string;
}

export interface CollectionDetail extends CollectionSummary {
  members: CollectionMember[];
  /** Members stored that the caller may not open (left out of `members`). */
  hidden_count: number;
}

// ─── Loading ────────────────────────────────────────────────────────────────

interface CountRow {
  collection_id: number;
  entity_type: CollectionEntityType;
  n: number;
}

async function loadCounts(collectionIds: number[]): Promise<Map<number, Partial<Record<CollectionEntityType, number>>>> {
  const counts = new Map<number, Partial<Record<CollectionEntityType, number>>>();
  if (collectionIds.length === 0) return counts;
  const docs = await dbAll<CountRow>(
    db
      .select({
        collection_id: documentCollectionItems.collection_id,
        entity_type: sql<CollectionEntityType>`'document'`,
        n: sql<number>`count(*)::int`,
      })
      .from(documentCollectionItems)
      .where(inArray(documentCollectionItems.collection_id, collectionIds))
      .groupBy(documentCollectionItems.collection_id),
  );
  const others = await dbAll<CountRow>(
    db
      .select({
        collection_id: collectionMembers.collection_id,
        entity_type: collectionMembers.entity_type,
        n: sql<number>`count(*)::int`,
      })
      .from(collectionMembers)
      .where(inArray(collectionMembers.collection_id, collectionIds))
      .groupBy(collectionMembers.collection_id, collectionMembers.entity_type),
  );
  for (const row of [...docs, ...others]) {
    const entry = counts.get(row.collection_id) ?? {};
    entry[row.entity_type] = Number(row.n);
    counts.set(row.collection_id, entry);
  }
  return counts;
}

async function loadUserStates(
  userId: number,
  collectionIds: number[],
): Promise<Map<number, { favourite: boolean; last_opened_at: string | null }>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await dbAll<{ collection_id: number; favourite: boolean; last_opened_at: string | null }>(
    db
      .select({
        collection_id: collectionUserState.collection_id,
        favourite: collectionUserState.favourite,
        last_opened_at: collectionUserState.last_opened_at,
      })
      .from(collectionUserState)
      .where(
        and(
          eq(collectionUserState.user_id, userId),
          inArray(collectionUserState.collection_id, collectionIds),
        ),
      ),
  );
  return new Map(rows.map((r) => [r.collection_id, r]));
}

async function mayAdminister(row: CollectionRow, c: Caller): Promise<boolean> {
  try {
    await assertCollectionAdministrable(row, c.userId, isAdmin(c));
    return true;
  } catch {
    return false;
  }
}

async function toSummaries(rows: CollectionRow[], c: Caller): Promise<CollectionSummary[]> {
  const ids = rows.map((r) => r.id);
  const [counts, states] = await Promise.all([loadCounts(ids), loadUserStates(c.userId, ids)]);
  return await Promise.all(
    rows.map(async (row) => {
      const rowCounts = counts.get(row.id) ?? {};
      const state = states.get(row.id);
      return {
        id: row.id,
        name: row.title,
        description: row.notes,
        entity_type: row.entity_type ?? null,
        kind: row.kind,
        visibility: row.visibility,
        group_id: row.group_id,
        archived_at: row.archived_at,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        favourite: state?.favourite ?? false,
        last_opened_at: state?.last_opened_at ?? null,
        counts: rowCounts,
        total: Object.values(rowCounts).reduce((sum, n) => sum + (n ?? 0), 0),
        can_administer: await mayAdminister(row, c),
        rule: ruleOf(row),
      };
    }),
  );
}

interface StoredMember {
  entity_type: CollectionEntityType;
  entity_id: number;
  joined_by: "user" | "rule";
  added_at: string;
  position: number;
}

async function loadStoredMembers(collectionId: number): Promise<StoredMember[]> {
  const docs = await dbAll<StoredMember>(
    db
      .select({
        entity_type: sql<CollectionEntityType>`'document'`,
        entity_id: documentCollectionItems.document_id,
        joined_by: documentCollectionItems.joined_by,
        added_at: documentCollectionItems.added_at,
        position: documentCollectionItems.position,
      })
      .from(documentCollectionItems)
      .where(eq(documentCollectionItems.collection_id, collectionId))
      .orderBy(asc(documentCollectionItems.position)),
  );
  const others = await dbAll<StoredMember>(
    db
      .select({
        entity_type: collectionMembers.entity_type,
        entity_id: collectionMembers.entity_id,
        joined_by: collectionMembers.joined_by,
        added_at: collectionMembers.added_at,
        position: sql<number>`0`,
      })
      .from(collectionMembers)
      .where(eq(collectionMembers.collection_id, collectionId))
      .orderBy(asc(collectionMembers.added_at), asc(collectionMembers.id)),
  );
  return [...docs, ...others];
}

/** Stored members turned into what this caller may see, in stored order. */
async function resolveVisible(
  stored: StoredMember[],
  c: Caller,
): Promise<CollectionMember[]> {
  const byType = new Map<CollectionEntityType, number[]>();
  for (const m of stored) {
    const list = byType.get(m.entity_type) ?? [];
    list.push(Number(m.entity_id));
    byType.set(m.entity_type, list);
  }
  const resolved = new Map<CollectionEntityType, Map<number, MemberDisplay>>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      resolved.set(type, await resolveMembers(c, type, ids));
    }),
  );
  const members: CollectionMember[] = [];
  for (const m of stored) {
    const shown = resolved.get(m.entity_type)?.get(Number(m.entity_id));
    if (!shown) continue;
    members.push({
      ...shown,
      entity_type: m.entity_type,
      entity_id: Number(m.entity_id),
      joined_by: m.joined_by,
      added_at: m.added_at,
    });
  }
  return members;
}

// ─── Listing ────────────────────────────────────────────────────────────────

export type CollectionSort = "last_opened" | "updated" | "name" | "count";

export interface ListCollectionsRequest {
  /** Search over name and description. */
  q?: Query<string>;
  /** Only collections typed for this entity type; "mixed" for the untyped ones. */
  type?: Query<string>;
  /** Only collections that hold at least one member of this type. */
  holds?: Query<string>;
  /** true: only archived; false or absent: only active. */
  archived?: Query<boolean>;
  favourite?: Query<boolean>;
  created_by?: Query<string>;
  sort?: Query<string>;
  dir?: Query<string>;
}

export interface ListCollectionsResponse {
  items: CollectionSummary[];
}

/** Sorts the summaries in place; ties fall back to the newest change. */
export function sortSummaries(
  items: CollectionSummary[],
  sort: CollectionSort,
  dir: "asc" | "desc",
): CollectionSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  const byUpdated = (a: CollectionSummary, b: CollectionSummary) =>
    b.updated_at.localeCompare(a.updated_at);
  const key: Record<CollectionSort, (a: CollectionSummary, b: CollectionSummary) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
    count: (a, b) => a.total - b.total,
    updated: (a, b) => a.updated_at.localeCompare(b.updated_at),
    // Never opened sorts as the oldest visit.
    last_opened: (a, b) => (a.last_opened_at ?? "").localeCompare(b.last_opened_at ?? ""),
  };
  return items.sort((a, b) => sign * key[sort](a, b) || byUpdated(a, b));
}

function parseSort(value: string | undefined): CollectionSort {
  return value === "updated" || value === "name" || value === "count" ? value : "last_opened";
}

export const listAllCollections = api(
  { expose: true, method: "GET", path: "/collections", auth: true },
  async (req: ListCollectionsRequest): Promise<ListCollectionsResponse> => {
    const c = caller();
    assertMayUseCollections(c);
    const groupIds = await loadUserGroupIds(c.userId);

    const conditions: SQL[] = [ne(documentCollections.kind, "basket")];
    const readable = readableCollectionsWhere(c.userId, groupIds, isAdmin(c));
    if (readable) conditions.push(readable);
    conditions.push(
      req.archived
        ? isNotNull(documentCollections.archived_at)
        : isNull(documentCollections.archived_at),
    );
    const term = (req.q ?? "").trim();
    if (term) {
      conditions.push(
        or(
          ilike(documentCollections.title, `%${term}%`),
          ilike(documentCollections.notes, `%${term}%`),
        )!,
      );
    }
    if (req.type === "mixed") {
      conditions.push(isNull(documentCollections.entity_type));
    } else if (req.type) {
      conditions.push(eq(documentCollections.entity_type, parseEntityType(req.type, "type")));
    }
    if (req.holds) {
      const holds = parseEntityType(req.holds, "holds");
      conditions.push(
        holds === "document"
          ? sql`EXISTS (SELECT 1 FROM ${documentCollectionItems} i WHERE i.collection_id = ${documentCollections.id})`
          : sql`EXISTS (SELECT 1 FROM ${collectionMembers} m WHERE m.collection_id = ${documentCollections.id} AND m.entity_type = ${holds})`,
      );
    }
    if (req.created_by === "user" || req.created_by === "assistant") {
      conditions.push(eq(documentCollections.created_by, req.created_by));
    }

    const rows = await dbAll<CollectionRow>(
      db
        .select()
        .from(documentCollections)
        .where(and(...conditions))
        .orderBy(desc(documentCollections.updated_at)),
    );
    let items = await toSummaries(rows, c);
    if (req.favourite) items = items.filter((item) => item.favourite);
    const dir = req.dir === "asc" ? "asc" : "desc";
    return { items: sortSummaries(items, parseSort(req.sort), dir) };
  },
);

// ─── One collection ─────────────────────────────────────────────────────────

async function buildDetail(row: CollectionRow, c: Caller): Promise<CollectionDetail> {
  const [summary] = await toSummaries([row], c);
  const stored = await loadStoredMembers(row.id);
  const members = await resolveVisible(stored, c);
  return { ...summary!, members, hidden_count: stored.length - members.length };
}

export const getAnyCollection = api(
  { expose: true, method: "GET", path: "/collections/:id", auth: true },
  async ({ id }: { id: number }): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, id, isAdmin(c));
    return await buildDetail(row, c);
  },
);

export interface MemberRef {
  entity_type: CollectionEntityType;
  entity_id: number;
}

export interface CreateAnyCollectionRequest {
  name: string;
  description?: string | null;
  /** One type, or null/absent for a collection that holds any type. */
  entity_type?: CollectionEntityType | null;
  visibility?: "private" | "group";
  group_id?: number | null;
  members?: MemberRef[];
}

export const createAnyCollection = api(
  { expose: true, method: "POST", path: "/collections", auth: true },
  async (req: CreateAnyCollectionRequest): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const name = (req.name ?? "").trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const entityType = req.entity_type == null ? null : parseEntityType(req.entity_type, "entity_type");
    if (entityType && !mayUseType(c, entityType)) {
      throw APIError.permissionDenied(`no access to ${entityType} items`);
    }

    const visibility = req.visibility ?? "private";
    const groupId = visibility === "group" ? (req.group_id ?? null) : null;
    if (visibility === "group") {
      if (groupId == null) throw APIError.invalidArgument("group_id is required for a group collection");
      await assertGroupMember(c.userId, groupId);
    }

    const created = await dbInsertReturning<CollectionRow>(
      db
        .insert(documentCollections)
        .values({
          user_id: c.userId,
          title: name,
          notes: req.description?.trim() || null,
          visibility,
          group_id: groupId,
          kind: "manual",
          entity_type: entityType,
        })
        .returning(),
    );
    if (!created) throw APIError.internal("failed to create collection");
    if (req.members?.length) await addMembers(created, req.members, c);
    await markOpened(created.id, c.userId);
    return await buildDetail(created, c);
  },
);

export interface UpdateAnyCollectionRequest {
  id: number;
  name?: string;
  description?: string | null;
  /** Archive (true) or bring back (false). Administrators only. */
  archived?: boolean;
  /** The caller's own star. */
  favourite?: boolean;
}

export const updateAnyCollection = api(
  { expose: true, method: "PATCH", path: "/collections/:id", auth: true },
  async (req: UpdateAnyCollectionRequest): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, req.id, isAdmin(c));

    const patch: Partial<typeof documentCollections.$inferInsert> = {};
    if (req.name !== undefined) {
      const name = req.name.trim();
      if (!name) throw APIError.invalidArgument("name must not be empty");
      patch.title = name;
    }
    if (req.description !== undefined) patch.notes = req.description?.trim() || null;
    if (req.archived !== undefined) {
      // Archiving hides the folder from everyone it is shared with, so it is
      // the same call as sharing or deleting it.
      await assertCollectionAdministrable(row, c.userId, isAdmin(c));
      patch.archived_at = req.archived ? (row.archived_at ?? new Date().toISOString()) : null;
    }
    if (Object.keys(patch).length > 0) {
      await dbExec(
        db
          .update(documentCollections)
          .set({ ...patch, updated_at: sql`now()` })
          .where(eq(documentCollections.id, row.id)),
      );
    }
    if (req.favourite !== undefined) await setFavourite(row.id, c.userId, req.favourite);

    const fresh = await loadReadableCollection(c.userId, row.id, isAdmin(c));
    return await buildDetail(fresh, c);
  },
);

export const deleteAnyCollection = api(
  { expose: true, method: "DELETE", path: "/collections/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, id, isAdmin(c));
    await assertCollectionAdministrable(row, c.userId, isAdmin(c));
    await dbExec(db.delete(documentCollections).where(eq(documentCollections.id, id)));
    await removeCollectionExports(id);
    return { deleted: true };
  },
);

/** Remember the visit, so "recently used" can put this collection first. */
export const markCollectionOpened = api(
  { expose: true, method: "POST", path: "/collections/:id/opened", auth: true },
  async ({ id }: { id: number }): Promise<{ ok: boolean }> => {
    const c = caller();
    assertMayUseCollections(c);
    await loadReadableCollection(c.userId, id, isAdmin(c));
    await markOpened(id, c.userId);
    return { ok: true };
  },
);

async function markOpened(collectionId: number, userId: number): Promise<void> {
  await dbExec(
    db
      .insert(collectionUserState)
      .values({ collection_id: collectionId, user_id: userId, last_opened_at: sql`now()` })
      .onConflictDoUpdate({
        target: [collectionUserState.collection_id, collectionUserState.user_id],
        set: { last_opened_at: sql`now()` },
      }),
  );
}

async function setFavourite(collectionId: number, userId: number, favourite: boolean): Promise<void> {
  await dbExec(
    db
      .insert(collectionUserState)
      .values({ collection_id: collectionId, user_id: userId, favourite })
      .onConflictDoUpdate({
        target: [collectionUserState.collection_id, collectionUserState.user_id],
        set: { favourite },
      }),
  );
}

// ─── Membership ─────────────────────────────────────────────────────────────

export interface AddMembersRequest {
  id: number;
  members: MemberRef[];
}

export interface AddMembersResponse {
  added: number;
  collection: CollectionDetail;
}

/**
 * Check a batch of references against the collection and the caller before
 * anything is written: every type must fit the collection, and every member
 * must be one the caller may open. One bad reference refuses the batch, as
 * the document folder does.
 */
async function validateMembers(
  row: CollectionRow,
  refs: MemberRef[],
  c: Caller,
): Promise<Map<CollectionEntityType, number[]>> {
  const byType = new Map<CollectionEntityType, number[]>();
  for (const ref of refs) {
    const type = parseEntityType(ref.entity_type, "entity_type");
    const id = Number(ref.entity_id);
    if (!Number.isInteger(id) || id <= 0) throw APIError.invalidArgument("entity_id must be a positive integer");
    if (row.entity_type != null && row.entity_type !== type) {
      throw APIError.failedPrecondition(
        `this collection holds ${row.entity_type} items only, not ${type}`,
      );
    }
    const list = byType.get(type) ?? [];
    if (!list.includes(id)) list.push(id);
    byType.set(type, list);
  }
  for (const [type, ids] of byType) {
    const visible = await resolveMembers(c, type, ids);
    const missing = ids.filter((id) => !visible.has(id));
    if (missing.length > 0) throw APIError.notFound(`${type} not found: ${missing.join(", ")}`);
  }
  return byType;
}

async function addMembers(row: CollectionRow, refs: MemberRef[], c: Caller): Promise<number> {
  const byType = await validateMembers(row, refs, c);
  let added = 0;
  for (const [type, ids] of byType) {
    if (type === "document") {
      added += await addDocumentsToCollection(row, ids, c.userId, isAdmin(c));
      continue;
    }
    const inserted = await dbAll<{ id: number }>(
      db
        .insert(collectionMembers)
        .values(
          ids.map((entityId) => ({
            collection_id: row.id,
            entity_type: type as CollectionMemberType,
            entity_id: entityId,
            added_by: c.userId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: collectionMembers.id }),
    );
    added += inserted.length;
  }
  if (added > 0) {
    await dbExec(
      db
        .update(documentCollections)
        .set({ updated_at: sql`now()` })
        .where(eq(documentCollections.id, row.id)),
    );
  }
  return added;
}

export const addAnyCollectionMembers = api(
  { expose: true, method: "POST", path: "/collections/:id/members", auth: true },
  async (req: AddMembersRequest): Promise<AddMembersResponse> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, req.id, isAdmin(c));
    const added = await addMembers(row, req.members ?? [], c);
    const fresh = await loadReadableCollection(c.userId, row.id, isAdmin(c));
    return { added, collection: await buildDetail(fresh, c) };
  },
);

export const removeAnyCollectionMember = api(
  {
    expose: true,
    method: "DELETE",
    path: "/collections/:id/members/:entityType/:entityId",
    auth: true,
  },
  async ({
    id,
    entityType,
    entityId,
  }: {
    id: number;
    entityType: string;
    entityId: number;
  }): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const type = parseEntityType(entityType, "entityType");
    const row = await loadReadableCollection(c.userId, id, isAdmin(c));
    // Taking out is open to whoever may see the member, as adding is.
    const visible = await resolveMembers(c, type, [entityId]);
    if (!visible.has(entityId)) throw APIError.notFound(`${type} not found: ${entityId}`);
    if (type === "document") {
      await removeDocumentFromCollection(row, entityId);
    } else {
      // Out of a rule collection, a removal is a decision the rule respects.
      await excludeFromRule(row, type as CollectionMemberType, entityId);
      await dbExec(
        db
          .delete(collectionMembers)
          .where(
            and(
              eq(collectionMembers.collection_id, row.id),
              eq(collectionMembers.entity_type, type),
              eq(collectionMembers.entity_id, entityId),
            ),
          ),
      );
      await dbExec(
        db
          .update(documentCollections)
          .set({ updated_at: sql`now()` })
          .where(eq(documentCollections.id, row.id)),
      );
    }
    const fresh = await loadReadableCollection(c.userId, row.id, isAdmin(c));
    return await buildDetail(fresh, c);
  },
);

// ─── Reverse lookup ─────────────────────────────────────────────────────────

export interface CollectionsOfResponse {
  items: Array<Pick<CollectionSummary, "id" | "name" | "entity_type" | "archived_at">>;
}

/** The collections the caller may read that hold this item ("In collections"). */
export const collectionsOfItem = api(
  {
    expose: true,
    method: "GET",
    path: "/collections/of/:entityType/:entityId",
    auth: true,
  },
  async ({ entityType, entityId }: { entityType: string; entityId: number }): Promise<CollectionsOfResponse> => {
    const c = caller();
    const type = parseEntityType(entityType, "entityType");
    const visible = await resolveMembers(c, type, [entityId]);
    if (!visible.has(entityId)) throw APIError.notFound(`${type} not found: ${entityId}`);

    const groupIds = await loadUserGroupIds(c.userId);
    const readable = readableCollectionsWhere(c.userId, groupIds, isAdmin(c));
    const holds =
      type === "document"
        ? sql`EXISTS (SELECT 1 FROM ${documentCollectionItems} i WHERE i.collection_id = ${documentCollections.id} AND i.document_id = ${entityId})`
        : sql`EXISTS (SELECT 1 FROM ${collectionMembers} m WHERE m.collection_id = ${documentCollections.id} AND m.entity_type = ${type} AND m.entity_id = ${entityId})`;
    const rows = await dbAll<CollectionRow>(
      db
        .select()
        .from(documentCollections)
        .where(and(readable, holds, ne(documentCollections.kind, "basket")))
        .orderBy(asc(documentCollections.title)),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.title,
        entity_type: r.entity_type ?? null,
        archived_at: r.archived_at,
      })),
    };
  },
);

// ─── Basket ─────────────────────────────────────────────────────────────────

/**
 * The caller's basket: their one unnamed, mixed collection of what they set
 * aside while working. Made on first use; at most one per user (a partial
 * unique index), so two tabs asking at once both end up with the same row.
 */
async function loadBasket(userId: number): Promise<CollectionRow> {
  const find = () =>
    dbAll<CollectionRow>(
      db
        .select()
        .from(documentCollections)
        .where(and(eq(documentCollections.user_id, userId), eq(documentCollections.kind, "basket"))),
    );
  const [existing] = await find();
  if (existing) return existing;
  await dbExec(
    db
      .insert(documentCollections)
      .values({
        user_id: userId,
        title: "Basket",
        visibility: "private",
        kind: "basket",
        entity_type: null,
        summary_stale: false,
      })
      .onConflictDoNothing(),
  );
  const [created] = await find();
  if (!created) throw APIError.internal("failed to create basket");
  return created;
}

export const getBasket = api(
  { expose: true, method: "GET", path: "/collections/basket", auth: true },
  async (): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    return await buildDetail(await loadBasket(c.userId), c);
  },
);

export const addToBasket = api(
  { expose: true, method: "POST", path: "/collections/basket/members", auth: true },
  async (req: { members: MemberRef[] }): Promise<AddMembersResponse> => {
    const c = caller();
    assertMayUseCollections(c);
    const basket = await loadBasket(c.userId);
    const added = await addMembers(basket, req.members ?? [], c);
    return { added, collection: await buildDetail(await loadBasket(c.userId), c) };
  },
);

/**
 * Take members out of the basket. References that are not in it are ignored:
 * the drawer and a list can both remove the same item a moment apart.
 */
async function removeMembers(row: CollectionRow, refs: MemberRef[]): Promise<number> {
  const byType = new Map<CollectionEntityType, number[]>();
  for (const ref of refs) {
    const type = parseEntityType(ref.entity_type, "entity_type");
    const id = Number(ref.entity_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    byType.set(type, [...(byType.get(type) ?? []), id]);
  }
  let removed = 0;
  for (const [type, ids] of byType) {
    if (type === "document") {
      const deleted = await dbAll<{ id: number }>(
        db
          .delete(documentCollectionItems)
          .where(
            and(
              eq(documentCollectionItems.collection_id, row.id),
              inArray(documentCollectionItems.document_id, ids),
            ),
          )
          .returning({ id: documentCollectionItems.id }),
      );
      removed += deleted.length;
      continue;
    }
    const deleted = await dbAll<{ id: number }>(
      db
        .delete(collectionMembers)
        .where(
          and(
            eq(collectionMembers.collection_id, row.id),
            eq(collectionMembers.entity_type, type),
            inArray(collectionMembers.entity_id, ids),
          ),
        )
        .returning({ id: collectionMembers.id }),
    );
    removed += deleted.length;
  }
  if (removed > 0) {
    await dbExec(
      db
        .update(documentCollections)
        .set({ updated_at: sql`now()` })
        .where(eq(documentCollections.id, row.id)),
    );
  }
  return removed;
}

export const removeFromBasket = api(
  { expose: true, method: "POST", path: "/collections/basket/remove", auth: true },
  async (req: { members: MemberRef[] }): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const basket = await loadBasket(c.userId);
    await removeMembers(basket, req.members ?? []);
    return await buildDetail(await loadBasket(c.userId), c);
  },
);

export interface ClearBasketRequest {
  /** Only this type; absent empties the whole basket. */
  type?: Query<string>;
}

/**
 * Empty the basket, or one type of it. Only what the caller can see goes:
 * a member they lost access to stays put rather than vanishing unseen.
 */
export const clearBasket = api(
  { expose: true, method: "DELETE", path: "/collections/basket/members", auth: true },
  async (req: ClearBasketRequest): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const type = req.type ? parseEntityType(req.type, "type") : null;
    const basket = await loadBasket(c.userId);
    const visible = await resolveVisible(await loadStoredMembers(basket.id), c);
    await removeMembers(
      basket,
      visible.filter((m) => !type || m.entity_type === type).map((m) => ({
        entity_type: m.entity_type,
        entity_id: m.entity_id,
      })),
    );
    return await buildDetail(await loadBasket(c.userId), c);
  },
);

export interface SaveBasketRequest {
  name: string;
  description?: string | null;
  /** Empty the basket after saving (default), or keep it as it is. */
  keep?: boolean;
  /** Only this type of the basket; absent saves everything. */
  type?: CollectionEntityType;
}

/**
 * Give the basket a name: a new collection with what the caller sees in it.
 * A basket of one type becomes a collection typed for it; a mixed one stays
 * mixed.
 */
export const saveBasketAsCollection = api(
  { expose: true, method: "POST", path: "/collections/basket/save", auth: true },
  async (req: SaveBasketRequest): Promise<CollectionDetail> => {
    const c = caller();
    assertMayUseCollections(c);
    const name = (req.name ?? "").trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const type = req.type ? parseEntityType(req.type, "type") : null;
    const basket = await loadBasket(c.userId);
    const members = (await resolveVisible(await loadStoredMembers(basket.id), c))
      .filter((m) => !type || m.entity_type === type)
      .map((m) => ({ entity_type: m.entity_type, entity_id: m.entity_id }));
    if (members.length === 0) throw APIError.failedPrecondition("the basket holds nothing to save");
    const types = new Set(members.map((m) => m.entity_type));

    const created = await dbInsertReturning<CollectionRow>(
      db
        .insert(documentCollections)
        .values({
          user_id: c.userId,
          title: name,
          notes: req.description?.trim() || null,
          visibility: "private",
          kind: "manual",
          entity_type: types.size === 1 ? [...types][0]! : null,
        })
        .returning(),
    );
    if (!created) throw APIError.internal("failed to create collection");
    await addMembers(created, members, c);
    if (!req.keep) await removeMembers(basket, members);
    await markOpened(created.id, c.userId);
    const fresh = await loadReadableCollection(c.userId, created.id, isAdmin(c));
    return await buildDetail(fresh, c);
  },
);

// ─── Rules (#1548, stage 5) ─────────────────────────────────────────────────

export interface CreateRuleCollectionRequest {
  name: string;
  description?: string | null;
  visibility?: "private" | "group";
  group_id?: number | null;
  /** `{ type: "photo", filter }`, `{ type: "transaction" | "security" | "meter", criteria }`. */
  rule: Record<string, unknown>;
}

export interface RuleCollectionResponse {
  collection: CollectionDetail;
  applied: RuleApplyResult;
}

/**
 * A collection whose members join by themselves: typed for the rule's kind,
 * filled at once with what matches today, kept current by the hourly job.
 */
export const createRuleCollection = api(
  { expose: true, method: "POST", path: "/collections/rule", auth: true },
  async (req: CreateRuleCollectionRequest): Promise<RuleCollectionResponse> => {
    const c = caller();
    const name = (req.name ?? "").trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const rule = normalizeMemberRule(req.rule);
    if (!rule) throw APIError.invalidArgument("the rule must narrow something");
    if (!mayUseType(c, rule.type)) throw APIError.permissionDenied(`no access to ${rule.type} items`);

    const visibility = req.visibility ?? "private";
    const groupId = visibility === "group" ? (req.group_id ?? null) : null;
    if (visibility === "group") {
      if (groupId == null) throw APIError.invalidArgument("group_id is required for a group collection");
      await assertGroupMember(c.userId, groupId);
    }
    const created = await dbInsertReturning<CollectionRow>(
      db
        .insert(documentCollections)
        .values({
          user_id: c.userId,
          title: name,
          notes: req.description?.trim() || null,
          visibility,
          group_id: groupId,
          kind: "rule",
          entity_type: rule.type,
          rule: rule as never,
          summary_stale: false,
        })
        .returning(),
    );
    if (!created) throw APIError.internal("failed to create collection");
    const applied = await applyMemberRule(created);
    await markOpened(created.id, c.userId);
    const fresh = await loadReadableCollection(c.userId, created.id, isAdmin(c));
    return { collection: await buildDetail(fresh, c), applied };
  },
);

export interface SetCollectionRuleRequest {
  id: number;
  /** The new rule, or null to stop: members stay, nothing joins by itself any more. */
  rule: Record<string, unknown> | null;
}

export const setCollectionRule = api(
  { expose: true, method: "PUT", path: "/collections/:id/rule", auth: true },
  async (req: SetCollectionRuleRequest): Promise<RuleCollectionResponse> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, req.id, isAdmin(c));
    if (row.kind === "dossier" || row.kind === "basket") {
      throw APIError.failedPrecondition("dossiers and the basket keep their own rules");
    }
    if (req.rule === null) {
      await dbExec(
        db
          .update(documentCollections)
          .set({ kind: "manual", rule: null, updated_at: sql`now()` })
          .where(eq(documentCollections.id, row.id)),
      );
      // What the rule gathered is now simply in the folder.
      await dbExec(
        db
          .update(collectionMembers)
          .set({ joined_by: "user" })
          .where(eq(collectionMembers.collection_id, row.id)),
      );
      const fresh = await loadReadableCollection(c.userId, row.id, isAdmin(c));
      return { collection: await buildDetail(fresh, c), applied: { added: 0, removed: 0 } };
    }
    const previous = ruleOf(row);
    const rule = normalizeMemberRule(req.rule, previous?.excluded_ids ?? []);
    if (!rule) throw APIError.invalidArgument("the rule must narrow something");
    if (row.entity_type != null && row.entity_type !== rule.type) {
      throw APIError.failedPrecondition(`this collection holds ${row.entity_type} items only, not ${rule.type}`);
    }
    if (!mayUseType(c, rule.type)) throw APIError.permissionDenied(`no access to ${rule.type} items`);
    await dbExec(
      db
        .update(documentCollections)
        .set({ kind: "rule", rule: rule as never, entity_type: rule.type, updated_at: sql`now()` })
        .where(eq(documentCollections.id, row.id)),
    );
    const updated = await loadReadableCollection(c.userId, row.id, isAdmin(c));
    const applied = await applyMemberRule(updated);
    const fresh = await loadReadableCollection(c.userId, row.id, isAdmin(c));
    return { collection: await buildDetail(fresh, c), applied };
  },
);

/** Bring one rule collection up to date now instead of at the next hour. */
export const applyCollectionRuleNow = api(
  { expose: true, method: "POST", path: "/collections/:id/apply-rule", auth: true },
  async ({ id }: { id: number }): Promise<RuleCollectionResponse> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, id, isAdmin(c));
    if (!ruleOf(row)) throw APIError.failedPrecondition("this collection has no rule");
    const applied = await applyMemberRule(row);
    const fresh = await loadReadableCollection(c.userId, id, isAdmin(c));
    return { collection: await buildDetail(fresh, c), applied };
  },
);


// ─── Album from a collection (#1548, stage 5) ───────────────────────────────

export interface CollectionToAlbumRequest {
  id: number;
  name: string;
}

/**
 * A new album with the photos of a collection the caller may see. A copy,
 * not a link: the album is curated from here on, the collection stays a
 * working set (albums are what gets shared and published).
 */
export const createAlbumFromCollection = api(
  { expose: true, method: "POST", path: "/collections/:id/to-album", auth: true },
  async (req: CollectionToAlbumRequest): Promise<{ album_id: number; photos: number }> => {
    const c = caller();
    if (!c.permissions.includes("albums.manage")) throw APIError.permissionDenied("missing permission: albums.manage");
    const name = (req.name ?? "").trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const row = await loadReadableCollection(c.userId, req.id, isAdmin(c));
    const members = await resolveVisible(await loadStoredMembers(row.id), c);
    const photoIds = members.filter((m) => m.entity_type === "photo").map((m) => m.entity_id);
    if (photoIds.length === 0) throw APIError.failedPrecondition("the collection holds no photos you can see");
    const album = await createAlbumLogic(c.userId, { name });
    await batchUpdateAlbumPhotosLogic(c.userId, { albumIds: [album.id], photoIds, action: "add" });
    return { album_id: album.id, photos: photoIds.length };
  },
);
