/**
 * Retrieval-augmented classification ("few-shot") for the documents module.
 *
 * The classifier's confidence signal is flat (~0.90 almost everywhere) and
 * its main failure mode is precision: similar recurring documents drift into
 * the generic "finanzen-rechnungen" bucket. Deterministic sender routing
 * (see `sender-rules.ts`) fixes the handful of mono-categorial institutions;
 * this module attacks the long tail by anchoring the LLM with concrete prior
 * decisions of the *same household*.
 *
 * At classify time we embed the document text as a `query`, find the nearest
 * already-classified documents by pgvector cosine distance, and pass them to
 * the LLM as orientation ("Absender X | Titel Y → Kategorie Z"). Reviewed
 * documents (a human asserted their attributes) rank ahead of AI-only guesses,
 * and we keep at most one example per distinct category so the prompt shows a
 * spread of plausible labels rather than six copies of the same bucket.
 *
 * The whole path is best-effort: any failure (LLM service down, no embeddings
 * yet, empty corpus) degrades silently to a normal zero-shot classification.
 */

import db from "../db/database";
import { sql } from "drizzle-orm";
import { embedTexts, type ClassifyExample } from "./llm-client";

/**
 * How many of the closest chunks to pull before collapsing to one row per
 * document. Mirrors the oversampling in `search.ts` — enough candidate
 * documents that the per-category dedup below has variety to work with.
 */
const CANDIDATE_CHUNK_LIMIT = 60;

/** Default number of distinct-category examples rendered into the prompt. */
const DEFAULT_MAX_EXAMPLES = 5;

/**
 * Probe text length sent to the embedder. The first ~2k characters carry the
 * letterhead/sender and subject — the part that drives the nearest-neighbour
 * match — without paying to embed multi-page bodies.
 */
const PROBE_CHARS = 2000;

/** One neighbour row as returned by the SQL below, before dedup. */
export interface NeighborRow {
  category_slug: string;
  category_name: string;
  title: string | null;
  sender: string | null;
  /** Cosine distance of the closest chunk (0 = identical). */
  dist: number;
  /** True when a human pinned this document's attributes. */
  attributes_reviewed: boolean;
}

/**
 * Collapse neighbour rows to at most `maxExamples` examples, keeping the
 * single best (closest, reviewed-first) document per distinct category.
 *
 * Input is expected pre-sorted by the SQL (`attributes_reviewed DESC,
 * dist ASC`); the dedup therefore keeps the right representative for each
 * category on first sight. Pure + exported so the ranking logic is unit
 * tested without a database.
 */
export function pickDiverseExamples(
  rows: readonly NeighborRow[],
  maxExamples: number = DEFAULT_MAX_EXAMPLES,
): ClassifyExample[] {
  const seen = new Set<string>();
  const out: ClassifyExample[] = [];
  for (const r of rows) {
    const slug = r.category_slug.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    const title = (r.title ?? "").trim();
    if (!title) continue;
    seen.add(slug);
    out.push({
      sender: r.sender?.trim() ? r.sender.trim() : null,
      title,
      category_slug: slug,
      category_name: (r.category_name ?? "").trim(),
    });
    if (out.length >= maxExamples) break;
  }
  return out;
}

export interface FindNearestParams {
  userId: number;
  /** The document being classified — never used as its own example. */
  excludeDocumentId: number;
  /** 768-d e5 `query` embedding of the document text. */
  queryVector: number[];
  maxExamples?: number;
}

/**
 * Nearest already-classified documents of the user, one per distinct
 * category, ranked reviewed-first then by similarity. Pure SQL — the caller
 * supplies the query vector so this stays embeddable in tests.
 *
 * The `<=>` cosine-distance operator and the `::vector` literal cast mirror
 * `runSemantic` in `search.ts`; the implicit vector→halfvec cast resolves the
 * operator on the (post-migration-0054) `halfvec(768)` column transparently.
 */
export async function findNearestClassifiedExamples(
  params: FindNearestParams,
): Promise<ClassifyExample[]> {
  const { userId, excludeDocumentId, queryVector } = params;
  if (queryVector.length === 0) return [];
  const literal = `[${queryVector.join(",")}]`;

  const rows = await db.execute<NeighborRow>(sql`
    WITH nearest AS (
      SELECT de.document_id,
             de.embedding <=> ${literal}::vector AS dist
      FROM document_embeddings de
      JOIN documents d ON d.id = de.document_id
      WHERE d.user_id = ${userId}
        AND d.id <> ${excludeDocumentId}
        AND d.status = 'ready'
        AND d.category_id IS NOT NULL
      ORDER BY de.embedding <=> ${literal}::vector ASC
      LIMIT ${CANDIDATE_CHUNK_LIMIT}
    ),
    per_doc AS (
      SELECT document_id, MIN(dist) AS dist
      FROM nearest
      GROUP BY document_id
    )
    SELECT c.slug AS category_slug,
           c.name AS category_name,
           d.title AS title,
           d.sender AS sender,
           p.dist AS dist,
           d.attributes_reviewed AS attributes_reviewed
    FROM per_doc p
    JOIN documents d ON d.id = p.document_id
    JOIN document_categories c ON c.id = d.category_id
    ORDER BY d.attributes_reviewed DESC, p.dist ASC
  `);

  const normalized: NeighborRow[] = rows.rows.map((r) => ({
    category_slug: String(r.category_slug),
    category_name: String(r.category_name ?? ""),
    title: r.title == null ? null : String(r.title),
    sender: r.sender == null ? null : String(r.sender),
    dist: Number(r.dist),
    attributes_reviewed: r.attributes_reviewed === true,
  }));

  return pickDiverseExamples(normalized, params.maxExamples ?? DEFAULT_MAX_EXAMPLES);
}

export interface BuildExamplesParams {
  documentId: number;
  userId: number;
  /** Already text-extracted (and clipped) document text. */
  text: string;
  maxExamples?: number;
}

/**
 * End-to-end few-shot retrieval for one document: embed → nearest-neighbour
 * lookup → diverse examples. Best-effort by design — every failure path
 * (empty text, embedder down, no prior corpus) returns `[]` so the caller
 * falls back to plain zero-shot classification.
 */
export async function buildClassifyExamples(
  params: BuildExamplesParams,
): Promise<ClassifyExample[]> {
  const probe = params.text.trim().slice(0, PROBE_CHARS);
  if (probe.length === 0) return [];
  try {
    const [vector] = await embedTexts([probe], "query");
    if (!vector || vector.length === 0) return [];
    return await findNearestClassifiedExamples({
      userId: params.userId,
      excludeDocumentId: params.documentId,
      queryVector: vector,
      maxExamples: params.maxExamples,
    });
  } catch (err) {
    console.warn(
      `[documents] few-shot retrieval(${params.documentId}) failed: ${(err as Error).message}`,
    );
    return [];
  }
}
