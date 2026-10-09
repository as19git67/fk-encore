/**
 * Related documents (#1478): what else belongs next to this one, and why.
 *
 * Search finds the one document that carries the policy number. The terms
 * and conditions that arrived in the same envelope never mention it, so
 * nothing leads from the one to the other — unless something else does. This
 * module gathers those other links, each as its own group with the reason it
 * is suggested, so the reader can judge every suggestion on its stated
 * ground rather than on a blended score:
 *
 *   - `same_folder`: the file came from the same origin folder (#1477).
 *   - `same_correspondent_nearby`: the same correspondent wrote it within
 *     ±NEARBY_DAYS of this document's date — the letter and its enclosures.
 *   - `same_collection`: it sits in the same Sammelmappe, one group per
 *     folder, titled by it.
 *   - `semantic`: its text is close to this one's in the embedding space,
 *     below a distance cutoff so the group can come back empty rather than
 *     always naming *something*.
 *
 * A document shown in an earlier group is not repeated in a later one, and
 * every group is filtered by the caller's visibility — a group never names a
 * document the caller could not open.
 */

import { and, asc, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  documentCategories,
  documentCollectionItems,
  documentCollections,
  documents,
} from "../db/schema";
import { loadUserGroupIds, loadVisibleDocument, visibleDocumentsWhere } from "./visibility";

console.log("[boot] documents/related.ts: all imports resolved");

/** Documents per group. Enough to show the envelope, not the whole drawer. */
export const RELATED_GROUP_LIMIT = 8;
/** ±days around `doc_date` for "same correspondent, close in time". */
export const RELATED_NEARBY_DAYS = 30;
/**
 * Largest cosine distance still counted as semantically close. pgvector's
 * `<=>` is 0 for identical and 2 for opposite texts; two letters about the
 * same contract from the same sender usually land well under 0.3.
 */
export const RELATED_SEMANTIC_MAX_DISTANCE = parseFloat(
  process.env.DOCUMENTS_RELATED_SEMANTIC_MAX_DISTANCE ?? "0.35",
);

export type RelatedReason =
  | "same_folder"
  | "same_correspondent_nearby"
  | "same_collection"
  | "semantic";

export interface RelatedDocumentDTO {
  id: number;
  title: string | null;
  original_filename: string;
  doc_date: string | null;
  sender: string | null;
  correspondent_display: string | null;
  document_type: string | null;
  category_slug: string | null;
  status: string;
  /** Only on `semantic` items: cosine distance, lower is closer. */
  semantic_distance?: number;
}

export interface RelatedGroupDTO {
  reason: RelatedReason;
  /** The folder for `same_folder`, the collection title for `same_collection`. */
  label: string | null;
  /** The Sammelmappe for `same_collection`, so the UI can link to it. */
  collection_id: number | null;
  items: RelatedDocumentDTO[];
}

export interface RelatedDocumentsResponse {
  groups: RelatedGroupDTO[];
}

type DocRow = typeof documents.$inferSelect;

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID, 10);
}

/** Visibility as a WHERE fragment on an aliased `documents d`, for raw SQL. */
function visibilitySqlFor(userId: number, groupIds: number[], isAdmin: boolean): SQL {
  if (isAdmin) return sql`TRUE`;
  if (groupIds.length === 0) return sql`(d.visibility = 'private' AND d.user_id = ${userId})`;
  const groupIdArray = sql`ARRAY[${sql.join(groupIds.map((g) => sql`${g}`), sql`, `)}]::int[]`;
  return sql`(
    (d.visibility = 'private' AND d.user_id = ${userId})
    OR (d.visibility = 'group' AND d.group_id = ANY(${groupIdArray}))
  )`;
}

const dtoColumns = {
  id: documents.id,
  title: documents.title,
  original_filename: documents.original_filename,
  doc_date: documents.doc_date,
  sender: documents.sender,
  correspondent_display: documents.correspondent_display,
  document_type: documents.document_type,
  category_slug: documentCategories.slug,
  status: documents.status,
};

interface DtoRow {
  id: number;
  title: string | null;
  original_filename: string;
  doc_date: string | null;
  sender: string | null;
  correspondent_display: string | null;
  document_type: string | null;
  category_slug: string | null;
  status: string;
}

function toDto(row: DtoRow): RelatedDocumentDTO {
  return {
    id: row.id,
    title: row.title,
    original_filename: row.original_filename,
    doc_date: row.doc_date,
    sender: row.sender,
    correspondent_display: row.correspondent_display,
    document_type: row.document_type,
    category_slug: row.category_slug,
    status: row.status,
  };
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The groups for `doc`, in display order. `visibility` is `null` for an
 * admin (who sees everything) and the caller's clause otherwise. Separated
 * from the endpoint so a test can call it with rows it inserted itself.
 */
export async function collectRelatedDocuments(
  doc: DocRow,
  ctx: { userId: number; groupIds: number[]; isAdmin: boolean },
  limit = RELATED_GROUP_LIMIT,
): Promise<RelatedGroupDTO[]> {
  const visibility = ctx.isAdmin ? sql`TRUE` : visibleDocumentsWhere(ctx.userId, ctx.groupIds);
  const groups: RelatedGroupDTO[] = [];
  const shown = new Set<number>([doc.id]);

  const baseQuery = (extra: SQL) =>
    db
      .select(dtoColumns)
      .from(documents)
      .leftJoin(documentCategories, eq(documentCategories.id, documents.category_id))
      .where(and(visibility, ne(documents.id, doc.id), extra));

  const notShown = (): SQL =>
    shown.size > 0
      ? sql`${documents.id} NOT IN (${sql.join([...shown].map((id) => sql`${id}`), sql`, `)})`
      : sql`TRUE`;

  // 1. Same origin folder, newest first.
  if (doc.source_folder) {
    const rows = await dbAll<DtoRow>(
      baseQuery(eq(documents.source_folder, doc.source_folder))
        .orderBy(desc(documents.doc_date), desc(documents.id))
        .limit(limit),
    );
    if (rows.length > 0) {
      groups.push({
        reason: "same_folder",
        label: doc.source_folder,
        collection_id: null,
        items: rows.map(toDto),
      });
      for (const r of rows) shown.add(r.id);
    }
  }

  // 2. Same correspondent, dated within ±NEARBY_DAYS: the letter and what
  //    came with it. Needs both a correspondent and a date on this side.
  if (doc.correspondent_slug && doc.doc_date) {
    const from = shiftIsoDate(doc.doc_date, -RELATED_NEARBY_DAYS);
    const to = shiftIsoDate(doc.doc_date, RELATED_NEARBY_DAYS);
    const rows = await dbAll<DtoRow>(
      baseQuery(
        and(
          eq(documents.correspondent_slug, doc.correspondent_slug),
          gte(documents.doc_date, from),
          lte(documents.doc_date, to),
          notShown(),
        )!,
      )
        // Closest in time first, so the enclosure of *this* letter leads.
        .orderBy(sql`ABS(${documents.doc_date}::date - ${doc.doc_date}::date)`, desc(documents.id))
        .limit(limit),
    );
    if (rows.length > 0) {
      groups.push({
        reason: "same_correspondent_nearby",
        label: doc.correspondent_display ?? doc.correspondent_slug,
        collection_id: null,
        items: rows.map(toDto),
      });
      for (const r of rows) shown.add(r.id);
    }
  }

  // 3. Fellow members of each Sammelmappe this document is in. The
  //    collection itself must be readable too: a collection never widens
  //    access, so its visibility is checked like a document's.
  const collectionVisibility = ctx.isAdmin
    ? sql`TRUE`
    : ctx.groupIds.length === 0
      ? and(eq(documentCollections.visibility, "private"), eq(documentCollections.user_id, ctx.userId))!
      : sql`(
          (${documentCollections.visibility} = 'private' AND ${documentCollections.user_id} = ${ctx.userId})
          OR (${documentCollections.visibility} = 'group' AND ${documentCollections.group_id} IN (${sql.join(ctx.groupIds.map((g) => sql`${g}`), sql`, `)}))
        )`;
  const memberships = await dbAll<{ id: number; title: string }>(
    db
      .select({ id: documentCollections.id, title: documentCollections.title })
      .from(documentCollectionItems)
      .innerJoin(documentCollections, eq(documentCollections.id, documentCollectionItems.collection_id))
      .where(and(eq(documentCollectionItems.document_id, doc.id), collectionVisibility))
      .orderBy(asc(documentCollections.title)),
  );
  for (const m of memberships) {
    const rows = await dbAll<DtoRow>(
      baseQuery(
        and(
          sql`EXISTS (
            SELECT 1 FROM ${documentCollectionItems} ci
            WHERE ci.collection_id = ${m.id} AND ci.document_id = ${documents.id}
          )`,
          notShown(),
        )!,
      )
        .orderBy(
          sql`(SELECT ci.position FROM ${documentCollectionItems} ci WHERE ci.collection_id = ${m.id} AND ci.document_id = ${documents.id})`,
          asc(documents.id),
        )
        .limit(limit),
    );
    if (rows.length > 0) {
      groups.push({
        reason: "same_collection",
        label: m.title,
        collection_id: m.id,
        items: rows.map(toDto),
      });
      for (const r of rows) shown.add(r.id);
    }
  }

  // 4. Nearest neighbours in the embedding space. Each of this document's
  //    chunks asks the HNSW index for its closest foreign chunks (the LATERAL
  //    keeps the index in play); a candidate document scores by its closest
  //    chunk, and only candidates under the cutoff come back.
  const semantic = await semanticNeighbours(doc.id, ctx, [...shown], limit);
  if (semantic.length > 0) {
    const ids = semantic.map((s) => s.document_id);
    const rows = await dbAll<DtoRow>(baseQuery(inArray(documents.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: RelatedDocumentDTO[] = [];
    for (const s of semantic) {
      const row = byId.get(s.document_id);
      if (!row) continue;
      items.push({ ...toDto(row), semantic_distance: s.dist });
    }
    if (items.length > 0) {
      groups.push({ reason: "semantic", label: null, collection_id: null, items });
    }
  }

  return groups;
}

async function semanticNeighbours(
  documentId: number,
  ctx: { userId: number; groupIds: number[]; isAdmin: boolean },
  excluded: number[],
  limit: number,
): Promise<Array<{ document_id: number; dist: number }>> {
  if (!(RELATED_SEMANTIC_MAX_DISTANCE > 0)) return [];
  const visibility = visibilitySqlFor(ctx.userId, ctx.groupIds, ctx.isAdmin);
  const excludedArray = sql`ARRAY[${sql.join(excluded.map((id) => sql`${id}`), sql`, `)}]::int[]`;
  // Per own chunk, this many closest foreign chunks are considered.
  const perChunk = Math.max(limit * 3, 20);
  try {
    const rows = await db.execute<{ document_id: number; dist: number }>(sql`
      WITH own AS (
        SELECT embedding FROM document_embeddings WHERE document_id = ${documentId}
      ),
      near AS (
        SELECT n.document_id, n.dist
        FROM own o
        CROSS JOIN LATERAL (
          SELECT de.document_id, de.embedding <=> o.embedding AS dist
          FROM document_embeddings de
          WHERE de.document_id <> ${documentId}
          ORDER BY de.embedding <=> o.embedding ASC
          LIMIT ${perChunk}
        ) n
      )
      SELECT n.document_id, MIN(n.dist) AS dist
      FROM near n
      JOIN documents d ON d.id = n.document_id
      WHERE ${visibility}
        AND NOT (d.id = ANY(${excludedArray}))
      GROUP BY n.document_id
      HAVING MIN(n.dist) <= ${RELATED_SEMANTIC_MAX_DISTANCE}
      ORDER BY dist ASC
      LIMIT ${limit}
    `);
    return rows.rows.map((r) => ({ document_id: Number(r.document_id), dist: Number(r.dist) }));
  } catch (err: any) {
    // No embeddings yet, or the extension is missing on this install: the
    // other groups still stand, so this one simply stays empty.
    console.warn(`[documents.related] semantic branch failed: ${err?.message ?? err}`);
    return [];
  }
}

export const getRelatedDocuments = api(
  { expose: true, method: "GET", path: "/documents/:id/related", auth: true },
  async ({ id }: { id: number }): Promise<RelatedDocumentsResponse> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.documents");
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const isAdmin = authData.permissions.includes("data.manage");

    const doc = await loadVisibleDocument(userId, id, isAdmin);
    const groupIds = isAdmin ? [] : await loadUserGroupIds(userId);
    const groups = await collectRelatedDocuments(doc, { userId, groupIds, isAdmin });
    return { groups };
  },
);
