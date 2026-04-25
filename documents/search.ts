/**
 * Search helpers for the documents module.
 *
 * Three modes:
 *   - `fts`      — lexical via the generated `text_tsv` tsvector column
 *                  and `plainto_tsquery('german', …)` + `ts_rank`.
 *   - `semantic` — embed the query with the same model used for the
 *                  corpus (multilingual-e5-base, 768-d) and rank by
 *                  pgvector cosine distance. Document-level scoring
 *                  sums similarity over the top-N closest chunks per
 *                  document so that several moderate matches outrank
 *                  a single near-miss.
 *   - `hybrid`   — combine both result lists via Reciprocal Rank
 *                  Fusion. This is the default because FTS handles
 *                  exact words (IBANs, invoice numbers) while the
 *                  semantic index handles paraphrases.
 *
 * Only the owning user's documents are ever considered — callers pass
 * the authenticated `userId` and that becomes a hard WHERE clause.
 */

import db from "../db/database";
import { sql } from "drizzle-orm";
import { embedTexts } from "./llm-client";
import { loadUserHouseholdIds } from "./visibility";

export type SearchMode = "fts" | "semantic" | "hybrid";

export interface SearchHit {
  document_id: number;
  /** Normalised 0..1 score (rank fusion or per-mode score, not comparable across modes). */
  score: number;
  /** Set when the hit came from the FTS branch. */
  fts_rank?: number;
  /** Set when the hit came from the semantic branch (lower = closer). */
  semantic_distance?: number;
}

export interface SearchParams {
  userId: number;
  query: string;
  mode: SearchMode;
  limit: number;
}

/** Max rows pulled from each branch before fusion. */
const PER_BRANCH_LIMIT = 50;

/** RRF constant — standard literature value, see Cormack et al. 2009. */
const RRF_K = 60;

/**
 * How many of the closest chunks per document feed the aggregated score.
 * Three is a pragmatic default: enough to reward a document that mentions
 * the query in several places, small enough not to drown out a single
 * very-strong chunk.
 */
const SEMANTIC_TOP_CHUNKS_PER_DOC = 3;

/**
 * Multiplier on the requested document `limit` to size the chunk-level
 * ANN candidate set. With max 32 chunks per document and top-3 aggregation
 * a 4× multiplier hits the right grain: enough chunk diversity that the
 * top-K documents are well-supported, while keeping the candidate set
 * compact so HNSW iterative-scan stays fast.
 */
const SEMANTIC_CHUNK_OVERSAMPLE = 4;

export async function searchDocuments(params: SearchParams): Promise<SearchHit[]> {
  const { userId, mode, limit } = params;
  const q = params.query.trim();
  if (q.length === 0) return [];

  const householdIds = await loadUserHouseholdIds(userId);

  if (mode === "fts") {
    return await runFts(userId, householdIds, q, limit);
  }
  if (mode === "semantic") {
    return await runSemantic(userId, householdIds, q, limit);
  }

  const [fts, semantic] = await Promise.all([
    runFts(userId, householdIds, q, PER_BRANCH_LIMIT).catch((err) => {
      console.warn(`[documents.search] fts branch failed: ${err?.message ?? err}`);
      return [] as SearchHit[];
    }),
    runSemantic(userId, householdIds, q, PER_BRANCH_LIMIT).catch((err) => {
      console.warn(`[documents.search] semantic branch failed: ${err?.message ?? err}`);
      return [] as SearchHit[];
    }),
  ]);
  return reciprocalRankFusion([fts, semantic], RRF_K).slice(0, limit);
}

/** Raw SQL fragment matching every document visible to the caller. */
function visibilityClause(userId: number, householdIds: number[]) {
  if (householdIds.length === 0) {
    return sql`(visibility = 'private' AND user_id = ${userId})`;
  }
  return sql`(
    (visibility = 'private' AND user_id = ${userId})
    OR (visibility = 'household' AND household_id = ANY(${householdIds}))
  )`;
}

async function runFts(
  userId: number,
  householdIds: number[],
  q: string,
  limit: number,
): Promise<SearchHit[]> {
  const visibility = visibilityClause(userId, householdIds);
  const rows = await db.execute<{ document_id: number; rank: number }>(sql`
    SELECT
      id AS document_id,
      ts_rank(text_tsv, plainto_tsquery('german', ${q})) AS rank
    FROM documents
    WHERE ${visibility}
      AND text_tsv @@ plainto_tsquery('german', ${q})
    ORDER BY rank DESC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    document_id: Number(r.document_id),
    score: Number(r.rank),
    fts_rank: Number(r.rank),
  }));
}

async function runSemantic(
  userId: number,
  householdIds: number[],
  q: string,
  limit: number,
): Promise<SearchHit[]> {
  // `kind: "query"` so the embedding service applies the e5-family
  // `query: ` prefix the corpus side does not get. See
  // `_apply_embedding_prefix` in `llm-service/main.py`.
  const embeddings = await embedTexts([q], "query");
  if (embeddings.length === 0) return [];
  const vec = embeddings[0];
  const literal = `[${vec.join(",")}]`;

  // The visibility clause references columns aliased as `d` in this query.
  const visibility = householdIds.length === 0
    ? sql`(d.visibility = 'private' AND d.user_id = ${userId})`
    : sql`(
        (d.visibility = 'private' AND d.user_id = ${userId})
        OR (d.visibility = 'household' AND d.household_id = ANY(${householdIds}))
      )`;

  // Aggregate at the document level by summing similarity over the top-N
  // closest chunks. The previous `MIN(distance)` scoring only cared about
  // the single best chunk and lost the signal that a document with multiple
  // moderately-close chunks is usually more relevant than one whose match
  // is concentrated in a single passage.
  //
  // Pipeline:
  //   1. ANN over chunks, capped at `chunkCandidateLimit`. The ORDER BY
  //      lets pgvector's HNSW index drive the scan; the visibility join
  //      prunes other users' content via iterative scan.
  //   2. Number chunks per document by ascending distance.
  //   3. Sum (1 − distance) over the top-N chunks per document, clamped
  //      at zero to keep negative-similarity outliers from dragging the
  //      score below well-formed weak hits.
  //   4. Keep `MIN(distance)` for the diagnostic `semantic_distance`
  //      field consumed by the UI / RRF fusion.
  //
  // `<=>` is pgvector's cosine *distance*: 0 = identical, 2 = opposite.
  const chunkCandidateLimit = Math.max(limit * SEMANTIC_CHUNK_OVERSAMPLE, 100);
  const rows = await db.execute<{
    document_id: number;
    best_dist: number;
    score: number;
  }>(sql`
    WITH visible_chunks AS (
      SELECT de.document_id,
             de.embedding <=> ${literal}::vector AS dist
      FROM document_embeddings de
      JOIN documents d ON d.id = de.document_id
      WHERE ${visibility}
      ORDER BY de.embedding <=> ${literal}::vector ASC
      LIMIT ${chunkCandidateLimit}
    ),
    ranked AS (
      SELECT document_id,
             dist,
             ROW_NUMBER() OVER (
               PARTITION BY document_id
               ORDER BY dist ASC
             ) AS rn
      FROM visible_chunks
    )
    SELECT document_id,
           MIN(dist) AS best_dist,
           SUM(GREATEST(0, 1 - dist))
             FILTER (WHERE rn <= ${SEMANTIC_TOP_CHUNKS_PER_DOC}) AS score
    FROM ranked
    GROUP BY document_id
    ORDER BY score DESC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    document_id: Number(r.document_id),
    score: Number(r.score),
    semantic_distance: Number(r.best_dist),
  }));
}

/**
 * Reciprocal Rank Fusion.
 *
 * Each input list is already sorted best-first. A document's fused
 * score is the sum over lists of `1 / (k + rank)`, where `rank` is
 * the 1-based position in the list (documents absent from a list
 * contribute nothing).
 *
 * Exported for unit tests — the pure function is the only tricky part.
 */
export function reciprocalRankFusion(lists: readonly SearchHit[][], k: number): SearchHit[] {
  const fused = new Map<number, SearchHit>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i];
      const contribution = 1 / (k + i + 1);
      const existing = fused.get(hit.document_id);
      if (existing) {
        existing.score += contribution;
        if (hit.fts_rank !== undefined) existing.fts_rank = hit.fts_rank;
        if (hit.semantic_distance !== undefined) existing.semantic_distance = hit.semantic_distance;
      } else {
        fused.set(hit.document_id, {
          document_id: hit.document_id,
          score: contribution,
          fts_rank: hit.fts_rank,
          semantic_distance: hit.semantic_distance,
        });
      }
    }
  }
  return Array.from(fused.values()).sort((a, b) => b.score - a.score);
}
