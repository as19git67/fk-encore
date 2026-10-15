/**
 * "Only the members of this collection" as a filter for a module's own list
 * (#1548, stage 3).
 *
 * A typed collection opens the module's list with `collection=<id>` in the
 * query; the list keeps its own columns, sort and filters and adds this one
 * condition. The condition also asks whether the caller may read the
 * collection, so a list scoped to someone else's private folder is simply
 * empty — the same answer as a folder that does not exist.
 *
 * Free of endpoints so the photo, finance and meter services can use it.
 */

import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { collectionMembers, documentCollections, groupMembers } from "../db/schema";
import type { CollectionMemberType } from "../db/schema";

/** A positive integer collection id from a query value, or undefined. */
export function parseCollectionId(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * SQL condition: the row whose id is `idColumn` is a member of type `type` of
 * collection `collectionId`, and `userId` may read that collection (their own
 * private one, or a group one in a group they belong to).
 */
export function collectionScopeCondition(
  type: CollectionMemberType,
  idColumn: AnyColumn | SQL,
  collectionId: number,
  userId: number,
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${collectionMembers} cm
    JOIN ${documentCollections} dc ON dc.id = cm.collection_id
    WHERE cm.collection_id = ${collectionId}
      AND cm.entity_type = ${type}
      AND cm.entity_id = ${idColumn}
      AND (
        (dc.visibility = 'private' AND dc.user_id = ${userId})
        OR (dc.visibility = 'group' AND EXISTS (
          SELECT 1 FROM ${groupMembers} gm
          WHERE gm.group_id = dc.group_id AND gm.user_id = ${userId}
        ))
      )
  )`;
}
