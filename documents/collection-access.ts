/**
 * Who may read and administer a Sammelmappe.
 *
 * Kept free of endpoints so the generic collections service (#1548) applies
 * the same rule as the document folders: a private collection is its
 * creator's, a group collection belongs to the group, and `data.manage`
 * admins may read any. What a reader then sees *inside* is a second question,
 * answered per member by the member's own module.
 */

import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { documentCollections, groupMembers } from "../db/schema";
import { loadUserGroupIds } from "./visibility";

export type CollectionRow = typeof documentCollections.$inferSelect;

/**
 * WHERE fragment over `document_collections` for the collections a caller may
 * read. `undefined` for an admin, who may read every one.
 */
export function readableCollectionsWhere(
  userId: number,
  groupIds: number[],
  isAdmin: boolean,
): SQL | undefined {
  if (isAdmin) return undefined;
  const ownPrivate = and(
    eq(documentCollections.visibility, "private"),
    eq(documentCollections.user_id, userId),
  )!;
  if (groupIds.length === 0) return ownPrivate;
  return or(
    ownPrivate,
    and(
      eq(documentCollections.visibility, "group"),
      inArray(documentCollections.group_id, groupIds),
    ),
  )!;
}

/**
 * Load a collection the caller may read: their own private one, or a group
 * one in a group they belong to. `data.manage` admins may read any, matching
 * how they already see every document.
 */
export async function loadReadableCollection(
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
 * Deleting a collection, or changing who it is shared with, is the creator's
 * call (or a group owner's, or an admin's) — not every member's.
 */
export async function assertCollectionAdministrable(
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

