/**
 * Search helpers for the documents module.
 *
 * Three modes:
 *   - `fts`      — lexical via the generated `text_tsv` tsvector column
 *                  and `plainto_tsquery('german', …)` + `ts_rank`.
 *   - `semantic` — embed the query with the same model used for the
 *                  corpus (multilingual-e5-base, 768-d) and rank by
 *                  pgvector cosine distance.
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

export async function searchDocuments(params: SearchParams): Promise<SearchHit[]> {
  const { userId, mode, limit } = params;
  const q = params.query.trim();
  if (q.length === 0) return [];

  if (mode === "fts") {
    return await runFts(userId, q, limit);
  }
  if (mode === "semantic") {
    return await runSemantic(userId, q, limit);
  }

  const [fts, semantic] = await Promise.all([
    runFts(userId, q, PER_BRANCH_LIMIT).catch((err) => {
      console.warn(`[documents.search] fts branch failed: ${err?.message ?? err}`);
      return [] as SearchHit[];
    }),
    runSemantic(userId, q, PER_BRANCH_LIMIT).catch((err) => {
      console.warn(`[documents.search] semantic branch failed: ${err?.message ?? err}`);
      return [] as SearchHit[];
    }),
  ]);
  return reciprocalRankFusion([fts, semantic], RRF_K).slice(0, limit);
}

async function runFts(userId: number, q: string, limit: number): Promise<SearchHit[]> {
  const rows = await db.execute<{ document_id: number; rank: number }>(sql`
    SELECT
      id AS document_id,
      ts_rank(text_tsv, plainto_tsquery('german', ${q})) AS rank
    FROM documents
    WHERE user_id = ${userId}
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

async function runSemantic(userId: number, q: string, limit: number): Promise<SearchHit[]> {
  const embeddings = await embedTexts([q]);
  if (embeddings.length === 0) return [];
  const vec = embeddings[0];
  const literal = `[${vec.join(",")}]`;

  // `<=>` is pgvector's cosine *distance*: 0 = identical, 2 = opposite.
  // GROUP BY picks the closest chunk per document.
  const rows = await db.execute<{ document_id: number; distance: number }>(sql`
    SELECT de.document_id, MIN(de.embedding <=> ${literal}::vector) AS distance
    FROM document_embeddings de
    JOIN documents d ON d.id = de.document_id
    WHERE d.user_id = ${userId}
    GROUP BY de.document_id
    ORDER BY distance ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    document_id: Number(r.document_id),
    // Convert cosine distance to similarity so higher = better, matching fts_rank semantics.
    score: 1 - Number(r.distance),
    semantic_distance: Number(r.distance),
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
