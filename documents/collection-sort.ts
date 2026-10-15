/**
 * Automatic order for a Sammelmappe.
 *
 * By default a person sets the order by dragging. A collection may instead
 * sort itself by up to three keys — correspondent, title, document date —
 * each ascending or descending ("first by correspondent, then by date").
 * While a sort is set, dragging is off and the positions follow the keys:
 * they are rewritten when the sort is chosen, when documents join, and when
 * a member's title, date or correspondent changes. The positions stay the one
 * order every reader (page, PDF, summary) uses.
 */

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { documentCollectionItems, documentCollections, documents } from "../db/schema";
import { discardCollectionExports } from "./collection-export";

export type CollectionSortField = "correspondent" | "title" | "doc_date";
export type CollectionSortDirection = "asc" | "desc";

export interface CollectionSortKey {
  field: CollectionSortField;
  dir: CollectionSortDirection;
}

const FIELDS: readonly CollectionSortField[] = ["correspondent", "title", "doc_date"];
export const MAX_SORT_KEYS = 3;

/** Keep known fields once each, at most three; nothing left means "by hand". */
export function normalizeSortOrder(
  input: ReadonlyArray<{ field?: string | null; dir?: string | null }> | null | undefined,
): CollectionSortKey[] | null {
  const out: CollectionSortKey[] = [];
  for (const raw of input ?? []) {
    const field = raw?.field as CollectionSortField;
    if (!FIELDS.includes(field) || out.some((k) => k.field === field)) continue;
    out.push({ field, dir: raw?.dir === "desc" ? "desc" : "asc" });
    if (out.length >= MAX_SORT_KEYS) break;
  }
  return out.length > 0 ? out : null;
}

/** What a member is sorted by. */
export interface SortSubject {
  position: number;
  correspondent: string | null;
  title: string | null;
  doc_date: string | null;
}

const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

function valueOf(item: SortSubject, field: CollectionSortField): string | null {
  const v = field === "correspondent" ? item.correspondent : field === "title" ? item.title : item.doc_date;
  const t = v?.trim();
  return t ? t : null;
}

/**
 * The items in the order the keys say. A missing value sorts last whichever
 * the direction (an undated letter is not "the oldest"); full ties keep their
 * current position, so re-sorting an already sorted folder moves nothing.
 */
export function sortItems<T extends SortSubject>(items: readonly T[], keys: readonly CollectionSortKey[]): T[] {
  return [...items].sort((a, b) => {
    for (const { field, dir } of keys) {
      const va = valueOf(a, field);
      const vb = valueOf(b, field);
      if (va === vb) continue;
      if (va === null) return 1;
      if (vb === null) return -1;
      // ISO dates compare as strings; names with the German collator.
      const c = field === "doc_date" ? (va < vb ? -1 : 1) : collator.compare(va, vb);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return a.position - b.position;
  });
}

/**
 * Rewrite a collection's positions from its sort keys. A collection without
 * keys is left alone. Returns whether anything moved.
 */
export async function resortCollection(collectionId: number): Promise<boolean> {
  const row = await dbFirst<{ sort_order: CollectionSortKey[] | null }>(
    db
      .select({ sort_order: documentCollections.sort_order })
      .from(documentCollections)
      .where(eq(documentCollections.id, collectionId)),
  );
  const keys = normalizeSortOrder(row?.sort_order);
  if (!keys) return false;

  const items = await dbAll<{
    id: number;
    position: number;
    display: string | null;
    sender: string | null;
    title: string | null;
    filename: string;
    doc_date: string | null;
  }>(
    db
      .select({
        id: documentCollectionItems.id,
        position: documentCollectionItems.position,
        display: documents.correspondent_display,
        sender: documents.sender,
        title: documents.title,
        filename: documents.original_filename,
        doc_date: documents.doc_date,
      })
      .from(documentCollectionItems)
      .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
      .where(eq(documentCollectionItems.collection_id, collectionId))
      .orderBy(asc(documentCollectionItems.position)),
  );
  // Sort by what the page shows: the correspondent's name (or the raw
  // sender), the title (or the file name).
  const subjects = items.map((i) => ({
    id: i.id,
    position: i.position,
    correspondent: i.display ?? i.sender,
    title: i.title ?? i.filename,
    doc_date: i.doc_date,
  }));
  const sorted = sortItems(subjects, keys);
  let moved = false;
  for (let index = 0; index < sorted.length; index++) {
    if (sorted[index].position === index) continue;
    moved = true;
    await dbExec(
      db
        .update(documentCollectionItems)
        .set({ position: index })
        .where(eq(documentCollectionItems.id, sorted[index].id)),
    );
  }
  if (moved) {
    // A new order changes the PDF and what the summary describes.
    await dbExec(
      db
        .update(documentCollections)
        .set({ summary_stale: true, updated_at: sql`now()` })
        .where(eq(documentCollections.id, collectionId)),
    );
    await discardCollectionExports(collectionId);
  }
  return moved;
}

/** Re-sort every sorted collection this document is in (after its attributes changed). */
export async function resortCollectionsOfDocument(documentId: number): Promise<void> {
  const rows = await dbAll<{ id: number }>(
    db
      .select({ id: documentCollections.id })
      .from(documentCollections)
      .where(
        and(
          isNotNull(documentCollections.sort_order),
          inArray(
            documentCollections.id,
            db
              .select({ id: documentCollectionItems.collection_id })
              .from(documentCollectionItems)
              .where(eq(documentCollectionItems.document_id, documentId)),
          ),
        ),
      ),
  );
  for (const { id } of rows) await resortCollection(id);
}
