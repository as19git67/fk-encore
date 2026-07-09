/**
 * Visibility / access-control helpers for the documents module.
 *
 * A document is reachable by the caller when either
 *   - `visibility='private'` AND `user_id = caller`
 *   - `visibility='group'` AND `group_id ∈ caller's groups`
 *
 * Internal endpoints replace the old `loadOwnedDocument` with
 * `loadVisibleDocument` so the shared-family use case works without
 * weakening path-traversal or per-row access checks.
 */

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { documents, groupMembers } from "../db/schema";

type DocumentRow = typeof documents.$inferSelect;

/** Drizzle `WHERE` fragment selecting every document visible to `userId`. */
export function visibleDocumentsWhere(userId: number, groupIds: number[]): SQL {
  const privateMatch = and(
    eq(documents.visibility, "private"),
    eq(documents.user_id, userId),
  )!;
  if (groupIds.length === 0) return privateMatch;
  const groupMatch = and(
    eq(documents.visibility, "group"),
    inArray(documents.group_id, groupIds),
  )!;
  return or(privateMatch, groupMatch)!;
}

/** Caller membership: fetch every group id the user belongs to. */
export async function loadUserGroupIds(userId: number): Promise<number[]> {
  const rows = await dbAll<{ group_id: number }>(
    db
      .select({ group_id: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, userId)),
  );
  return rows.map((r) => r.group_id);
}

/**
 * Load a document row if (and only if) the caller may see it — i.e. it
 * is either their own private upload or a group-scoped document in
 * a group they belong to. Throws `APIError.notFound` otherwise
 * (deliberately masking the difference from "does not exist" so we
 * don't leak document ids).
 *
 * `isAdmin` callers (holding `data.manage`) bypass the visibility filter
 * and may load any document. This keeps the single-document endpoints
 * consistent with `listDocuments`, which already shows admins every
 * document: without it an admin could see a document in the list but get
 * "document not found" when opening, deleting, or replacing it.
 */
export async function loadVisibleDocument(
  userId: number,
  documentId: number,
  isAdmin = false,
): Promise<DocumentRow> {
  if (isAdmin) {
    const row = await dbFirst<DocumentRow>(
      db.select().from(documents).where(eq(documents.id, documentId)),
    );
    if (!row) throw APIError.notFound("document not found");
    return row;
  }
  const groupIds = await loadUserGroupIds(userId);
  const row = await dbFirst<DocumentRow>(
    db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), visibleDocumentsWhere(userId, groupIds))),
  );
  if (!row) throw APIError.notFound("document not found");
  return row;
}

/**
 * Stricter variant for destructive operations (delete, visibility
 * change): the caller must be the uploader OR hold the `owner` role in
 * the document's group. Regular members cannot delete group
 * documents they didn't upload.
 *
 * `isAdmin` callers (holding `data.manage`) may administer any document,
 * mirroring the admin bypass in `loadVisibleDocument`.
 */
export async function loadAdministrableDocument(
  userId: number,
  documentId: number,
  isAdmin = false,
): Promise<DocumentRow> {
  const row = await loadVisibleDocument(userId, documentId, isAdmin);
  if (isAdmin) return row;
  if (row.user_id === userId) return row;
  if (row.visibility === "group" && row.group_id != null) {
    const membership = await dbFirst<{ role: "owner" | "member" }>(
      db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.group_id, row.group_id),
            eq(groupMembers.user_id, userId),
          ),
        ),
    );
    if (membership?.role === "owner") return row;
  }
  throw APIError.permissionDenied(
    "only the uploader or a group owner may perform this action",
  );
}

/**
 * Assert that the caller is a member of `groupId`; used when
 * moving a private document into a group or when the frontend
 * enumerates group-visible documents explicitly.
 */
export async function assertGroupMember(
  userId: number,
  groupId: number,
): Promise<void> {
  const row = await dbFirst<{ user_id: number }>(
    db
      .select({ user_id: groupMembers.user_id })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.group_id, groupId),
          eq(groupMembers.user_id, userId),
        ),
      ),
  );
  if (!row) {
    throw APIError.permissionDenied("not a member of this group");
  }
}

/** Assert group-owner role for admin-level group mutations. */
export async function assertGroupOwner(
  userId: number,
  groupId: number,
): Promise<void> {
  const row = await dbFirst<{ role: "owner" | "member" }>(
    db
      .select({ role: groupMembers.role })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.group_id, groupId),
          eq(groupMembers.user_id, userId),
        ),
      ),
  );
  if (row?.role !== "owner") {
    throw APIError.permissionDenied("only group owners may perform this action");
  }
}

/**
 * Raw SQL fragment for the full-text / semantic search queries which
 * issue hand-crafted SQL rather than going through the Drizzle query
 * builder. Returns the bind-ready condition string pieces.
 */
export function visibleDocumentsSqlFragment(userId: number, groupIds: number[]) {
  if (groupIds.length === 0) {
    return sql`(d.visibility = 'private' AND d.user_id = ${userId})`;
  }
  return sql`(
    (d.visibility = 'private' AND d.user_id = ${userId})
    OR (d.visibility = 'group' AND d.group_id IN ${groupIds})
  )`;
}
