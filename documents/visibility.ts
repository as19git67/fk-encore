/**
 * Visibility / access-control helpers for the documents module.
 *
 * A document is reachable by the caller when either
 *   - `visibility='private'` AND `user_id = caller`
 *   - `visibility='household'` AND `household_id ∈ caller's households`
 *
 * Internal endpoints replace the old `loadOwnedDocument` with
 * `loadVisibleDocument` so the shared-family use case works without
 * weakening path-traversal or per-row access checks.
 */

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { documents, householdMembers } from "../db/schema";

type DocumentRow = typeof documents.$inferSelect;

/** Drizzle `WHERE` fragment selecting every document visible to `userId`. */
export function visibleDocumentsWhere(userId: number, householdIds: number[]): SQL {
  const privateMatch = and(
    eq(documents.visibility, "private"),
    eq(documents.user_id, userId),
  )!;
  if (householdIds.length === 0) return privateMatch;
  const householdMatch = and(
    eq(documents.visibility, "household"),
    inArray(documents.household_id, householdIds),
  )!;
  return or(privateMatch, householdMatch)!;
}

/** Caller membership: fetch every household id the user belongs to. */
export async function loadUserHouseholdIds(userId: number): Promise<number[]> {
  const rows = await dbAll<{ household_id: number }>(
    db
      .select({ household_id: householdMembers.household_id })
      .from(householdMembers)
      .where(eq(householdMembers.user_id, userId)),
  );
  return rows.map((r) => r.household_id);
}

/**
 * Load a document row if (and only if) the caller may see it — i.e. it
 * is either their own private upload or a household-scoped document in
 * a household they belong to. Throws `APIError.notFound` otherwise
 * (deliberately masking the difference from "does not exist" so we
 * don't leak document ids).
 */
export async function loadVisibleDocument(
  userId: number,
  documentId: number,
): Promise<DocumentRow> {
  const householdIds = await loadUserHouseholdIds(userId);
  const row = await dbFirst<DocumentRow>(
    db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), visibleDocumentsWhere(userId, householdIds))),
  );
  if (!row) throw APIError.notFound("document not found");
  return row;
}

/**
 * Stricter variant for destructive operations (delete, visibility
 * change): the caller must be the uploader OR hold the `owner` role in
 * the document's household. Regular members cannot delete household
 * documents they didn't upload.
 */
export async function loadAdministrableDocument(
  userId: number,
  documentId: number,
): Promise<DocumentRow> {
  const row = await loadVisibleDocument(userId, documentId);
  if (row.user_id === userId) return row;
  if (row.visibility === "household" && row.household_id != null) {
    const membership = await dbFirst<{ role: "owner" | "member" }>(
      db
        .select({ role: householdMembers.role })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.household_id, row.household_id),
            eq(householdMembers.user_id, userId),
          ),
        ),
    );
    if (membership?.role === "owner") return row;
  }
  throw APIError.permissionDenied(
    "only the uploader or a household owner may perform this action",
  );
}

/**
 * Assert that the caller is a member of `householdId`; used when
 * moving a private document into a household or when the frontend
 * enumerates household-visible documents explicitly.
 */
export async function assertHouseholdMember(
  userId: number,
  householdId: number,
): Promise<void> {
  const row = await dbFirst<{ user_id: number }>(
    db
      .select({ user_id: householdMembers.user_id })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.household_id, householdId),
          eq(householdMembers.user_id, userId),
        ),
      ),
  );
  if (!row) {
    throw APIError.permissionDenied("not a member of this household");
  }
}

/** Assert household-owner role for admin-level household mutations. */
export async function assertHouseholdOwner(
  userId: number,
  householdId: number,
): Promise<void> {
  const row = await dbFirst<{ role: "owner" | "member" }>(
    db
      .select({ role: householdMembers.role })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.household_id, householdId),
          eq(householdMembers.user_id, userId),
        ),
      ),
  );
  if (row?.role !== "owner") {
    throw APIError.permissionDenied("only household owners may perform this action");
  }
}

/**
 * Raw SQL fragment for the full-text / semantic search queries which
 * issue hand-crafted SQL rather than going through the Drizzle query
 * builder. Returns the bind-ready condition string pieces.
 */
export function visibleDocumentsSqlFragment(userId: number, householdIds: number[]) {
  if (householdIds.length === 0) {
    return sql`(d.visibility = 'private' AND d.user_id = ${userId})`;
  }
  return sql`(
    (d.visibility = 'private' AND d.user_id = ${userId})
    OR (d.visibility = 'household' AND d.household_id IN ${householdIds})
  )`;
}
