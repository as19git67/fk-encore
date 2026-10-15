/**
 * Which documents a Sammelmappe holds — adding and taking out, free of
 * endpoints so the document folder endpoints and the generic collections
 * service (#1548) change membership by the same rules.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { documentCollectionItems, documentCollections, documents } from "../db/schema";
import type { CollectionRule } from "./dossiers";
import type { CollectionRow } from "./collection-access";
import { discardCollectionExports } from "./collection-export";
import { loadUserGroupIds, visibleDocumentsWhere } from "./visibility";

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

export function assertMembersFitVisibility(
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
export async function loadVisibleDocumentsById(
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

/**
 * Mark the summary as needing a rewrite, bump the change timestamp, and throw
 * away the PDFs built from the folder as it was.
 */
export async function touchCollection(collectionId: number): Promise<void> {
  await dbExec(
    db
      .update(documentCollections)
      .set({ summary_stale: true, updated_at: sql`now()` })
      .where(eq(documentCollections.id, collectionId)),
  );
  await discardCollectionExports(collectionId);
}

/** Renumber a collection's items to a dense 0-based sequence. */
export async function renumber(collectionId: number, orderedItemIds: number[]): Promise<void> {
  for (let index = 0; index < orderedItemIds.length; index++) {
    await dbExec(
      db
        .update(documentCollectionItems)
        .set({ position: index })
        .where(eq(documentCollectionItems.id, orderedItemIds[index])),
    );
  }
}

/**
 * Append documents to a collection, keeping the order they were given in and
 * ignoring the ones already there. Returns how many were newly added.
 */
export async function addDocumentsToCollection(
  collection: CollectionRow,
  documentIds: number[],
  userId: number,
  isAdmin: boolean,
): Promise<number> {
  const wanted = [...new Set(documentIds.filter((id) => Number.isFinite(id)))];
  if (wanted.length === 0) return 0;
  if (collection.entity_type != null && collection.entity_type !== "document") {
    throw APIError.failedPrecondition(
      `this collection holds ${collection.entity_type} items only, not documents`,
    );
  }

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

/**
 * Take one document out of a collection and close the gap in the order.
 * Out of a dossier, the removal is remembered so the rule does not put the
 * document straight back.
 */
export async function removeDocumentFromCollection(
  row: CollectionRow,
  documentId: number,
): Promise<void> {
  const id = row.id;
    // Taking a document out of a dossier is a decision the rule must respect:
    // remember it, or the next run would put the document straight back.
    if (row.kind === "dossier" && row.rule) {
      const rule = row.rule as CollectionRule;
      const excluded = new Set(rule.excluded_document_ids ?? []);
      if (!excluded.has(documentId)) {
        excluded.add(documentId);
        await dbExec(
          db
            .update(documentCollections)
            .set({ rule: { ...rule, excluded_document_ids: [...excluded] } })
            .where(eq(documentCollections.id, id)),
        );
      }
    }
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
}
