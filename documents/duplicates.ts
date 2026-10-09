/**
 * Near-duplicate documents (#1481): find them by content, merge them without
 * losing anybody's work.
 *
 * Why they exist: the stored original is immutable, but what the app serves
 * is not always the original — the searchable "sandwich" PDF and the upright
 * copy live under `_ocr/<id>.pdf` and are what the download hands out. A file
 * taken from there and put back into the inbox has a new `sha256`, so the
 * unique constraint waves it through, and the corpus holds the same letter
 * twice.
 *
 * How they are found: cheaply first, then expensively. Two documents in the
 * same owner scope with the same page count and either the same date, the
 * same correspondent or chunk embeddings within a hair of each other are a
 * *candidate* pair; the pair is *confirmed* by the trigram Jaccard of their
 * normalised texts, which has to clear `DUPLICATE_MIN_SCORE`. A sandwich copy
 * of an OCR'd scan reads almost identically; an upright copy reads
 * identically. Confirmed pairs land in `document_duplicate_candidates` so a
 * pair someone dismissed is never proposed again.
 *
 * How they are merged: the *keeper* stays, the *loser* goes, but everything
 * attached to the loser moves first — tags, collection memberships, subject
 * persons, tax sections, finance links, follow-ups, and pinned attributes the
 * keeper lacks. The rows are re-pointed generically by walking every foreign
 * key onto `documents.id` in the catalogue, so a table added later cannot be
 * forgotten silently; a row the keeper already has (unique violation) is
 * dropped, because the keeper's own row is the one to keep. Deletion then
 * runs the same steps as a manual delete.
 */

import fs from "fs";
import path from "path";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { documentDuplicateCandidates, documents } from "../db/schema";
import { assertPathUnderDocumentsRoot, pruneEmptyDirs } from "./documents.service";
import { withDocumentLock } from "./document-lock";
import { dropTaxLinks } from "./relocate";
import { removeThumbnail } from "./thumbnail";
import { removeOcrPdf } from "./ocr-pdf";

console.log("[boot] documents/duplicates.ts: all imports resolved");

/** Trigram Jaccard a pair has to reach to count as the same document. */
export const DUPLICATE_MIN_SCORE = parseFloat(process.env.DOCUMENTS_DUPLICATE_MIN_SCORE ?? "0.85");
/** Cosine distance between two chunk embeddings that counts as "the same page". */
export const DUPLICATE_EMBEDDING_MAX_DISTANCE = parseFloat(
  process.env.DOCUMENTS_DUPLICATE_EMBEDDING_MAX_DISTANCE ?? "0.08",
);
/** Texts shorter than this carry too little to compare; such pairs are skipped. */
const MIN_TEXT_LENGTH = 40;

// ─── Text similarity ────────────────────────────────────────────────────────

/** Lower-case, letters and digits only, single spaces: what OCR noise leaves alike. */
export function normalizeForSimilarity(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 3) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of the two texts' trigram sets, 0..1. */
export function trigramJaccard(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** The name `relocate.ts` gives a file: `…__<8 hex of sha256>.pdf`. */
export function looksLikeSpeakingName(filename: string): boolean {
  return /__[0-9a-f]{8}\.[a-z0-9]+$/i.test(filename);
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export interface DuplicateEvidence {
  pages_a: number | null;
  pages_b: number | null;
  same_date: boolean;
  same_correspondent: boolean;
  embedding_hit: boolean;
  text_source_a: string | null;
  text_source_b: string | null;
  speaking_name_a: boolean;
  speaking_name_b: boolean;
  size_a: number;
  size_b: number;
}

interface CandidateRow {
  id: number;
  user_id: number;
  visibility: string;
  group_id: number | null;
  original_filename: string;
  size_bytes: number;
  pages_total: number | null;
  doc_date: string | null;
  correspondent_slug: string | null;
  text_source: string | null;
  extracted_text: string | null;
  uploaded_at: string | null;
}

const candidateColumns = {
  id: documents.id,
  user_id: documents.user_id,
  visibility: documents.visibility,
  group_id: documents.group_id,
  original_filename: documents.original_filename,
  size_bytes: documents.size_bytes,
  pages_total: documents.pages_total,
  doc_date: documents.doc_date,
  correspondent_slug: documents.correspondent_slug,
  text_source: documents.text_source,
  extracted_text: documents.extracted_text,
  uploaded_at: documents.uploaded_at,
};

/** Same owner scope: same uploader for private documents, same group for shared ones. */
function sameScope(a: CandidateRow, b: CandidateRow): boolean {
  if (a.visibility === "group" || b.visibility === "group") {
    return a.visibility === b.visibility && a.group_id != null && a.group_id === b.group_id;
  }
  return a.user_id === b.user_id;
}

/**
 * Cheap prefilter in SQL: pairs that share a page count and a date or a
 * correspondent. Restricted to `anchorId` when given (one document against
 * the corpus, for the import-time check), otherwise the whole corpus.
 */
async function metadataCandidatePairs(anchorId: number | null): Promise<Array<[number, number]>> {
  const anchorCond = anchorId == null ? sql`TRUE` : sql`(a.id = ${anchorId} OR b.id = ${anchorId})`;
  const rows = await db.execute<{ a: number; b: number }>(sql`
    SELECT a.id AS a, b.id AS b
    FROM documents a
    JOIN documents b
      ON b.id > a.id
     AND b.pages_total IS NOT DISTINCT FROM a.pages_total
     AND (
       (a.visibility = 'private' AND b.visibility = 'private' AND a.user_id = b.user_id)
       OR (a.visibility = 'group' AND b.visibility = 'group' AND a.group_id = b.group_id)
     )
     AND (
       (a.doc_date IS NOT NULL AND a.doc_date = b.doc_date)
       OR (a.correspondent_slug IS NOT NULL AND a.correspondent_slug = b.correspondent_slug)
     )
    WHERE a.extracted_text IS NOT NULL AND b.extracted_text IS NOT NULL
      AND ${anchorCond}
  `);
  return rows.rows.map((r) => [Number(r.a), Number(r.b)]);
}

/**
 * Embedding prefilter: the first chunk of one document within a hair of the
 * first chunk of another. One chunk is enough for a prefilter — the text
 * comparison decides — and keeps this a single index probe per document.
 */
async function embeddingCandidatePairs(anchorId: number | null): Promise<Array<[number, number]>> {
  if (!(DUPLICATE_EMBEDDING_MAX_DISTANCE > 0)) return [];
  const anchorCond = anchorId == null ? sql`TRUE` : sql`o.document_id = ${anchorId}`;
  try {
    const rows = await db.execute<{ a: number; b: number }>(sql`
      SELECT LEAST(o.document_id, n.document_id) AS a,
             GREATEST(o.document_id, n.document_id) AS b
      FROM document_embeddings o
      CROSS JOIN LATERAL (
        SELECT de.document_id
        FROM document_embeddings de
        WHERE de.chunk_idx = 0 AND de.document_id <> o.document_id
          AND de.embedding <=> o.embedding <= ${DUPLICATE_EMBEDDING_MAX_DISTANCE}
        ORDER BY de.embedding <=> o.embedding ASC
        LIMIT 5
      ) n
      WHERE o.chunk_idx = 0 AND ${anchorCond}
    `);
    return rows.rows.map((r) => [Number(r.a), Number(r.b)]);
  } catch (err: any) {
    console.warn(`[documents.duplicates] embedding prefilter failed: ${err?.message ?? err}`);
    return [];
  }
}

export interface ScoredPair {
  a: CandidateRow;
  b: CandidateRow;
  score: number;
  evidence: DuplicateEvidence;
}

/**
 * Score every candidate pair by text, keeping those above the threshold.
 * Separated from persistence so a test can look at the scoring alone.
 */
export async function findDuplicatePairs(
  anchorId: number | null,
  minScore = DUPLICATE_MIN_SCORE,
): Promise<ScoredPair[]> {
  const meta = await metadataCandidatePairs(anchorId);
  const emb = await embeddingCandidatePairs(anchorId);
  const embSet = new Set(emb.map(([a, b]) => `${a}:${b}`));
  const pairKeys = new Map<string, [number, number]>();
  for (const [a, b] of [...meta, ...emb]) pairKeys.set(`${a}:${b}`, [a, b]);
  if (pairKeys.size === 0) return [];

  const ids = [...new Set([...pairKeys.values()].flat())];
  const rows = await dbAll<CandidateRow>(
    db.select(candidateColumns).from(documents).where(inArray(documents.id, ids)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const normalized = new Map<number, string>();
  const textOf = (r: CandidateRow): string => {
    let n = normalized.get(r.id);
    if (n === undefined) {
      n = normalizeForSimilarity(r.extracted_text);
      normalized.set(r.id, n);
    }
    return n;
  };

  const out: ScoredPair[] = [];
  for (const [key, [aId, bId]] of pairKeys) {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b || !sameScope(a, b)) continue;
    const ta = textOf(a);
    const tb = textOf(b);
    if (ta.length < MIN_TEXT_LENGTH || tb.length < MIN_TEXT_LENGTH) continue;
    // Lengths far apart cannot be the same document; skip the expensive part.
    if (Math.min(ta.length, tb.length) / Math.max(ta.length, tb.length) < 0.5) continue;
    const score = trigramJaccard(ta, tb);
    if (score < minScore) continue;
    out.push({
      a,
      b,
      score,
      evidence: {
        pages_a: a.pages_total,
        pages_b: b.pages_total,
        same_date: a.doc_date != null && a.doc_date === b.doc_date,
        same_correspondent: a.correspondent_slug != null && a.correspondent_slug === b.correspondent_slug,
        embedding_hit: embSet.has(key),
        text_source_a: a.text_source,
        text_source_b: b.text_source,
        speaking_name_a: looksLikeSpeakingName(a.original_filename),
        speaking_name_b: looksLikeSpeakingName(b.original_filename),
        size_a: a.size_bytes,
        size_b: b.size_bytes,
      },
    });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

export interface DuplicateScanResponse {
  /** Pairs above the threshold in this run. */
  found: number;
  /** Of those, newly recorded as open. */
  new_open: number;
  /** Already known (open, merged or dismissed) and left as they were. */
  already_known: number;
}

/** Record the pairs; an existing row (whatever its status) is left alone except for a fresher score while open. */
export async function recordDuplicatePairs(pairs: ScoredPair[]): Promise<DuplicateScanResponse> {
  let newOpen = 0;
  let known = 0;
  for (const p of pairs) {
    const existing = await dbFirst<{ id: number; status: string }>(
      db
        .select({ id: documentDuplicateCandidates.id, status: documentDuplicateCandidates.status })
        .from(documentDuplicateCandidates)
        .where(
          and(
            eq(documentDuplicateCandidates.document_a_id, p.a.id),
            eq(documentDuplicateCandidates.document_b_id, p.b.id),
          ),
        ),
    );
    if (existing) {
      known += 1;
      if (existing.status === "open") {
        await db
          .update(documentDuplicateCandidates)
          .set({ score: p.score, evidence: p.evidence as unknown as Record<string, unknown> })
          .where(eq(documentDuplicateCandidates.id, existing.id));
      }
      continue;
    }
    await db.insert(documentDuplicateCandidates).values({
      document_a_id: p.a.id,
      document_b_id: p.b.id,
      score: p.score,
      evidence: p.evidence as unknown as Record<string, unknown>,
      status: "open",
    });
    newOpen += 1;
  }
  return { found: pairs.length, new_open: newOpen, already_known: known };
}

/**
 * Import-time check: after text extraction, see whether the new document
 * reads like one already there. Never blocks the pipeline — a failure here
 * is logged and the document proceeds.
 */
export async function checkForDuplicatesOf(documentId: number): Promise<void> {
  try {
    const pairs = await findDuplicatePairs(documentId);
    if (pairs.length === 0) return;
    const res = await recordDuplicatePairs(pairs);
    if (res.new_open > 0) {
      console.log(
        `[documents.duplicates] document ${documentId}: ${res.new_open} possible duplicate(s) recorded`,
      );
    }
  } catch (err: any) {
    console.warn(`[documents.duplicates] check for ${documentId} failed: ${err?.message ?? err}`);
  }
}

// ─── Keeper rule ────────────────────────────────────────────────────────────

/**
 * Which of the two stays by default: the original bytes. A scan that needed
 * OCR (`text_source = 'ocr'`) next to one that had a text layer is the
 * signature of "original scan vs. its re-imported sandwich", and the scan is
 * the original. Otherwise the earlier import (lower id).
 */
export function defaultKeeper(
  a: { id: number; text_source: string | null },
  b: { id: number; text_source: string | null },
): number {
  const aOcr = a.text_source === "ocr" || a.text_source === "mixed";
  const bOcr = b.text_source === "ocr" || b.text_source === "mixed";
  if (aOcr && !bOcr && b.text_source === "text_layer") return a.id;
  if (bOcr && !aOcr && a.text_source === "text_layer") return b.id;
  return Math.min(a.id, b.id);
}

// ─── Merge ──────────────────────────────────────────────────────────────────

type ForeignKeyRef = {
  table_name: string;
  column_name: string;
};

/** Every column in the schema that points at `documents.id`, from the catalogue. */
export async function foreignKeysOntoDocuments(): Promise<ForeignKeyRef[]> {
  const rows = await db.execute<ForeignKeyRef>(sql`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = current_schema()
      AND ccu.table_name = 'documents'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name, kcu.column_name
  `);
  return rows.rows;
}

/**
 * Tables whose rows belong to the loser's *file*, not to the user's work on
 * the document: derived data the keeper computes for itself. Dropped, never
 * re-pointed.
 */
const DERIVED_TABLES = new Set([
  "document_embeddings",
  "document_scan_queue",
  "document_receipt_extraction",
]);

/** Columns the merge itself owns; left to the explicit logic below. */
const MERGE_OWNED = new Set(["document_duplicate_candidates"]);

export interface MergeResult {
  keeper_id: number;
  loser_id: number;
  /** Rows re-pointed to the keeper, per table. */
  moved: Record<string, number>;
  /** Rows dropped because the keeper already had the equivalent, per table. */
  dropped: Record<string, number>;
  /** Pinned attributes copied from the loser onto the keeper. */
  attributes_copied: boolean;
  tax_copied: boolean;
}

/**
 * Merge `loserId` into `keeperId`. Both locked; the data moves in one
 * transaction, the loser's files are removed afterwards (a file that
 * lingers is harmless, a row that lingers is not).
 */
export async function mergeDocuments(keeperId: number, loserId: number): Promise<MergeResult> {
  if (keeperId === loserId) throw APIError.invalidArgument("keeper and loser are the same document");
  const [first, second] = keeperId < loserId ? [keeperId, loserId] : [loserId, keeperId];
  return withDocumentLock(first, () => withDocumentLock(second, () => mergeLocked(keeperId, loserId)));
}

async function mergeLocked(keeperId: number, loserId: number): Promise<MergeResult> {
  const keeper = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.id, keeperId)),
  );
  const loser = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.id, loserId)),
  );
  if (!keeper) throw APIError.notFound(`keeper ${keeperId} not found`);
  if (!loser) throw APIError.notFound(`loser ${loserId} not found`);

  const fks = await foreignKeysOntoDocuments();
  const result: MergeResult = {
    keeper_id: keeperId,
    loser_id: loserId,
    moved: {},
    dropped: {},
    attributes_copied: false,
    tax_copied: false,
  };

  // Tax hardlinks under `_steuer/` point at the loser's file; drop them before
  // the row goes, as the manual delete does.
  try {
    await dropTaxLinks(loserId);
  } catch (err) {
    console.warn(`[documents.duplicates] merge: dropTaxLinks(${loserId}) failed: ${(err as Error).message}`);
  }

  await db.transaction(async (tx) => {
    // 1. Pinned attributes: the loser's human work wins only where the keeper
    //    has none of its own.
    if (loser.attributes_reviewed && !keeper.attributes_reviewed) {
      await tx
        .update(documents)
        .set({
          title: loser.title,
          doc_date: loser.doc_date,
          sender: loser.sender,
          document_number: loser.document_number,
          summary: loser.summary,
          category_id: loser.category_id,
          category_source: loser.category_source,
          document_type: loser.document_type,
          attributes_reviewed: true,
        })
        .where(eq(documents.id, keeperId));
      result.attributes_copied = true;
    }
    if (loser.tax_reviewed && !keeper.tax_reviewed) {
      await tx
        .update(documents)
        .set({
          tax_relevant: loser.tax_relevant,
          tax_year: loser.tax_year,
          tax_year_confidence: loser.tax_year_confidence,
          tax_reviewed: true,
          tax_review_needed: loser.tax_review_needed,
          tax_return_person_id: loser.tax_return_person_id,
        })
        .where(eq(documents.id, keeperId));
      result.tax_copied = true;
    }
    // Notes are appended, never overwritten; the folder fills a gap only.
    const mergedNotes =
      loser.notes && loser.notes.trim().length > 0
        ? keeper.notes && keeper.notes.trim().length > 0
          ? `${keeper.notes}\n\n${loser.notes}`
          : loser.notes
        : undefined;
    if (mergedNotes !== undefined || (!keeper.source_folder && loser.source_folder)) {
      await tx
        .update(documents)
        .set({
          ...(mergedNotes !== undefined ? { notes: mergedNotes } : {}),
          ...(!keeper.source_folder && loser.source_folder ? { source_folder: loser.source_folder } : {}),
        })
        .where(eq(documents.id, keeperId));
    }

    // 2. Every row that points at the loser. Derived rows go; the rest moves,
    //    row by row inside a savepoint so a unique violation (the keeper
    //    already has that tag, that membership, that link) drops just that row.
    for (const fk of fks) {
      if (MERGE_OWNED.has(fk.table_name)) continue;
      const table = sql.identifier(fk.table_name);
      const column = sql.identifier(fk.column_name);
      if (DERIVED_TABLES.has(fk.table_name)) {
        const del = await tx.execute(sql`DELETE FROM ${table} WHERE ${column} = ${loserId}`);
        result.dropped[fk.table_name] = (result.dropped[fk.table_name] ?? 0) + Number(del.rowCount ?? 0);
        continue;
      }
      // ctid identifies each row without assuming a primary key.
      const rows = await tx.execute<{ ctid: string }>(
        sql`SELECT ctid::text AS ctid FROM ${table} WHERE ${column} = ${loserId}`,
      );
      for (const r of rows.rows) {
        try {
          await tx.execute(sql`SAVEPOINT merge_row`);
          await tx.execute(
            sql`UPDATE ${table} SET ${column} = ${keeperId} WHERE ctid = ${r.ctid}::tid AND ${column} = ${loserId}`,
          );
          await tx.execute(sql`RELEASE SAVEPOINT merge_row`);
          result.moved[fk.table_name] = (result.moved[fk.table_name] ?? 0) + 1;
        } catch (err: any) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT merge_row`);
          // drizzle wraps the driver error; the SQLSTATE sits on the cause.
          const code = err?.code ?? err?.cause?.code;
          if (code !== "23505") throw err; // only a unique violation is expected
          await tx.execute(sql`DELETE FROM ${table} WHERE ctid = ${r.ctid}::tid`);
          result.dropped[fk.table_name] = (result.dropped[fk.table_name] ?? 0) + 1;
        }
      }
    }

    // 3. The pair rows: this pair becomes merged with the keeper named; other
    //    open pairs involving the loser are moot, as their other side now
    //    faces the keeper and the next scan will say whether that holds.
    const [aId, bId] = keeperId < loserId ? [keeperId, loserId] : [loserId, keeperId];
    await tx
      .update(documentDuplicateCandidates)
      .set({ status: "merged", keeper_id: keeperId, decided_at: sql`now()` })
      .where(
        and(
          eq(documentDuplicateCandidates.document_a_id, aId),
          eq(documentDuplicateCandidates.document_b_id, bId),
        ),
      );
    await tx
      .delete(documentDuplicateCandidates)
      .where(
        and(
          eq(documentDuplicateCandidates.status, "open"),
          or(
            eq(documentDuplicateCandidates.document_a_id, loserId),
            eq(documentDuplicateCandidates.document_b_id, loserId),
          ),
        ),
      );

    // 4. The loser's row. Remaining references cascade or set null by their
    //    own FK rules (the pair rows above, SET NULL).
    await tx.delete(documents).where(eq(documents.id, loserId));
  });

  // 5. The loser's files: best-effort, like the manual delete.
  try {
    assertPathUnderDocumentsRoot(loser.disk_path);
    await fs.promises.unlink(loser.disk_path).catch(() => {});
    await pruneEmptyDirs(path.dirname(loser.disk_path));
  } catch (err) {
    console.warn(`[documents.duplicates] merge: unlink ${loser.disk_path} failed: ${(err as Error).message}`);
  }
  await removeThumbnail(loserId);
  await removeOcrPdf(loserId);

  console.log(
    `[documents.duplicates] merged ${loserId} into ${keeperId}: moved ${JSON.stringify(result.moved)}, dropped ${JSON.stringify(result.dropped)}`,
  );
  return result;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

function requireAdmin(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.documents");
  requirePermission(authData, "data.manage");
}

/** Scan the corpus for near-duplicate pairs and record the new ones as open. */
export const scanDuplicates = api(
  { expose: true, method: "POST", path: "/documents/duplicates/scan", auth: true },
  async (): Promise<DuplicateScanResponse> => {
    requireAdmin();
    const pairs = await findDuplicatePairs(null);
    return recordDuplicatePairs(pairs);
  },
);

export interface DuplicateSideDTO {
  id: number;
  title: string | null;
  original_filename: string;
  doc_date: string | null;
  sender: string | null;
  correspondent_display: string | null;
  uploaded_at: string | null;
  size_bytes: number;
  pages_total: number | null;
  text_source: string | null;
  attributes_reviewed: boolean;
  tax_reviewed: boolean;
  source_folder: string | null;
}

export interface DuplicatePairDTO {
  id: number;
  score: number;
  evidence: DuplicateEvidence;
  status: string;
  a: DuplicateSideDTO;
  b: DuplicateSideDTO;
  /** The side the default rule would keep. */
  suggested_keeper_id: number;
  created_at: string;
}

export interface ListDuplicatesResponse {
  items: DuplicatePairDTO[];
}

const sideColumns = {
  id: documents.id,
  title: documents.title,
  original_filename: documents.original_filename,
  doc_date: documents.doc_date,
  sender: documents.sender,
  correspondent_display: documents.correspondent_display,
  uploaded_at: documents.uploaded_at,
  size_bytes: documents.size_bytes,
  pages_total: documents.pages_total,
  text_source: documents.text_source,
  attributes_reviewed: documents.attributes_reviewed,
  tax_reviewed: documents.tax_reviewed,
  source_folder: documents.source_folder,
};

/** Open pairs for review, highest score first. */
export const listDuplicates = api(
  { expose: true, method: "GET", path: "/documents/duplicates", auth: true },
  async (): Promise<ListDuplicatesResponse> => {
    requireAdmin();
    const pairs = await dbAll<typeof documentDuplicateCandidates.$inferSelect>(
      db
        .select()
        .from(documentDuplicateCandidates)
        .where(eq(documentDuplicateCandidates.status, "open"))
        .orderBy(desc(documentDuplicateCandidates.score), desc(documentDuplicateCandidates.id)),
    );
    const ids = [...new Set(pairs.flatMap((p) => [p.document_a_id, p.document_b_id]).filter((x): x is number => x != null))];
    const sides = ids.length
      ? await dbAll<DuplicateSideDTO>(db.select(sideColumns).from(documents).where(inArray(documents.id, ids)))
      : [];
    const byId = new Map(sides.map((s) => [s.id, s]));
    const items: DuplicatePairDTO[] = [];
    for (const p of pairs) {
      const a = p.document_a_id != null ? byId.get(p.document_a_id) : undefined;
      const b = p.document_b_id != null ? byId.get(p.document_b_id) : undefined;
      if (!a || !b) continue; // one side gone: nothing left to decide
      items.push({
        id: p.id,
        score: p.score,
        evidence: p.evidence as unknown as DuplicateEvidence,
        status: p.status,
        a,
        b,
        suggested_keeper_id: defaultKeeper(a, b),
        created_at: p.created_at,
      });
    }
    return { items };
  },
);

/** Open pairs that involve one document — for the notice on its detail page. */
export const listDuplicatesForDocument = api(
  { expose: true, method: "GET", path: "/documents/:id/duplicates", auth: true },
  async ({ id }: { id: number }): Promise<{ other_ids: number[] }> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.documents");
    requirePermission(authData, "documents.view");
    const rows = await dbAll<{ a: number | null; b: number | null }>(
      db
        .select({ a: documentDuplicateCandidates.document_a_id, b: documentDuplicateCandidates.document_b_id })
        .from(documentDuplicateCandidates)
        .where(
          and(
            eq(documentDuplicateCandidates.status, "open"),
            or(eq(documentDuplicateCandidates.document_a_id, id), eq(documentDuplicateCandidates.document_b_id, id)),
          ),
        ),
    );
    const others = rows
      .map((r) => (r.a === id ? r.b : r.a))
      .filter((x): x is number => x != null);
    return { other_ids: others };
  },
);

export interface MergeDuplicateRequest {
  id: number;
  /** Which side stays; defaults to the rule in `defaultKeeper`. */
  keeper_id?: number;
}

export const mergeDuplicate = api(
  { expose: true, method: "POST", path: "/documents/duplicates/:id/merge", auth: true },
  async (req: MergeDuplicateRequest): Promise<MergeResult> => {
    requireAdmin();
    const pair = await dbFirst<typeof documentDuplicateCandidates.$inferSelect>(
      db.select().from(documentDuplicateCandidates).where(eq(documentDuplicateCandidates.id, req.id)),
    );
    if (!pair || pair.status !== "open") throw APIError.notFound("open duplicate pair not found");
    if (pair.document_a_id == null || pair.document_b_id == null) {
      throw APIError.failedPrecondition("one side of the pair no longer exists");
    }
    const sides = await dbAll<{ id: number; text_source: string | null }>(
      db
        .select({ id: documents.id, text_source: documents.text_source })
        .from(documents)
        .where(inArray(documents.id, [pair.document_a_id, pair.document_b_id])),
    );
    if (sides.length !== 2) throw APIError.failedPrecondition("one side of the pair no longer exists");
    const keeperId = req.keeper_id ?? defaultKeeper(sides[0]!, sides[1]!);
    if (keeperId !== pair.document_a_id && keeperId !== pair.document_b_id) {
      throw APIError.invalidArgument("keeper_id is not part of this pair");
    }
    const loserId = keeperId === pair.document_a_id ? pair.document_b_id : pair.document_a_id;
    return mergeDocuments(keeperId, loserId);
  },
);

export const dismissDuplicate = api(
  { expose: true, method: "POST", path: "/documents/duplicates/:id/dismiss", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    requireAdmin();
    const updated = await db
      .update(documentDuplicateCandidates)
      .set({ status: "dismissed", decided_at: sql`now()` })
      .where(and(eq(documentDuplicateCandidates.id, id), eq(documentDuplicateCandidates.status, "open")))
      .returning({ id: documentDuplicateCandidates.id });
    if (updated.length === 0) throw APIError.notFound("open duplicate pair not found");
    return { success: true };
  },
);
