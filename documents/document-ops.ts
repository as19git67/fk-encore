/**
 * Core operations the worker and API endpoints share.
 *
 * Split out of `documents.ts` so the worker can run its pipeline
 * (text-extract → classify → embed) without importing the Encore API
 * layer.
 */

import { and, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentTagLinks,
  documentTags,
  documents,
} from "../db/schema";
import { extractPdfText } from "./text-extract";
import {
  assertPathUnderDocumentsRoot,
} from "./documents.service";
import {
  classifyDocument,
  embedTexts,
  type Classification,
  type TaxonomyEntry,
} from "./llm-client";
import { flattenTaxonomy } from "./taxonomy";

/** Maximum characters of extracted text we feed the classifier. */
const CLASSIFY_TEXT_LIMIT = parseInt(
  process.env.DOCUMENTS_CLASSIFY_CHAR_LIMIT ?? "6000",
  10,
);

/** Approx characters per embedding chunk. */
const EMBED_CHUNK_CHARS = parseInt(
  process.env.DOCUMENTS_EMBED_CHUNK_CHARS ?? "1500",
  10,
);

/** Max chunks embedded per document — guardrail against huge PDFs. */
const EMBED_MAX_CHUNKS = parseInt(
  process.env.DOCUMENTS_EMBED_MAX_CHUNKS ?? "32",
  10,
);

/** Confidence below which a document is flagged as a taxonomy-suggestion candidate. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

type DocumentRow = typeof documents.$inferSelect;

/** Fetch the document row or throw. Used by every worker job. */
async function getDocumentOrThrow(id: number): Promise<DocumentRow> {
  const row = await dbFirst<DocumentRow>(
    db.select().from(documents).where(eq(documents.id, id)),
  );
  if (!row) throw new Error(`document ${id} not found`);
  return row;
}

/**
 * Job: `text_extract`.
 * Reads the PDF from disk, extracts text (with OCR fallback), and
 * stores it on the row. Moves the document into `classifying` state
 * so the UI shows accurate progress.
 */
export async function runTextExtract(documentId: number): Promise<void> {
  const row = await getDocumentOrThrow(documentId);
  assertPathUnderDocumentsRoot(row.disk_path);

  await db
    .update(documents)
    .set({ status: "extracting" })
    .where(eq(documents.id, documentId));

  const result = await extractPdfText(row.disk_path);
  const text = result.text ?? "";

  await db
    .update(documents)
    .set({
      extracted_text: text.length === 0 ? null : text,
      status: "classifying",
    })
    .where(eq(documents.id, documentId));
}

/**
 * Job: `classify`.
 * Feeds the extracted text + taxonomy tree to the LLM, persists the
 * returned category/title/tags on the document row, and upserts the
 * tag join rows. Defers (throws caller's DeferJobError) when the text
 * hasn't been extracted yet.
 */
export async function runClassify(documentId: number): Promise<{ classification: Classification; lowConfidence: boolean } | { deferred: true }> {
  const row = await getDocumentOrThrow(documentId);
  const text = (row.extracted_text ?? "").trim();
  if (text.length === 0) {
    return { deferred: true };
  }

  const taxonomy = await loadTaxonomyForClassifier();
  const clipped = text.slice(0, CLASSIFY_TEXT_LIMIT);
  const classification = await classifyDocument({ text: clipped, taxonomy });

  const catSlug = classification.category_slug;
  const cat = await dbFirst<{ id: number }>(
    db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, catSlug)),
  );

  await db
    .update(documents)
    .set({
      category_id: cat?.id ?? null,
      title: classification.title || row.title || row.original_filename,
      doc_date: classification.doc_date,
      sender: classification.sender,
      summary: classification.summary,
      classification_confidence: classification.confidence,
      status: "ready",
    })
    .where(eq(documents.id, documentId));

  await replaceTagLinks(documentId, classification.tags);

  const lowConfidence = classification.confidence < LOW_CONFIDENCE_THRESHOLD;
  return { classification, lowConfidence };
}

/**
 * Job: `embed`.
 * Slices the extracted text into ~1500-char chunks, embeds each via
 * the LLM service, and upserts into `document_embeddings`. Skips
 * documents with no text (embeddings on an empty string are useless).
 */
export async function runEmbed(documentId: number): Promise<{ chunks: number } | { deferred: true }> {
  const row = await getDocumentOrThrow(documentId);
  const text = (row.extracted_text ?? "").trim();
  if (text.length === 0) return { deferred: true };

  const chunks = chunkText(text, EMBED_CHUNK_CHARS).slice(0, EMBED_MAX_CHUNKS);
  if (chunks.length === 0) return { chunks: 0 };

  const embeddings = await embedTexts(chunks);
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `embed: LLM returned ${embeddings.length} vectors for ${chunks.length} chunks`,
    );
  }

  // Replace any existing chunks for this document so re-classification
  // produces a consistent view.
  await db.execute(sql`DELETE FROM document_embeddings WHERE document_id = ${documentId}`);

  for (let i = 0; i < chunks.length; i++) {
    const vec = embeddings[i];
    const literal = `[${vec.join(",")}]`;
    await db.execute(sql`
      INSERT INTO document_embeddings (document_id, chunk_idx, embedding)
      VALUES (${documentId}, ${i}, ${literal}::vector)
    `);
  }

  return { chunks: chunks.length };
}

/**
 * Mark a document as failed. Called by the worker after a job has
 * exhausted retries so the UI can surface the error.
 */
export async function markDocumentFailed(documentId: number, _reason: string): Promise<void> {
  await db
    .update(documents)
    .set({ status: "failed" })
    .where(eq(documents.id, documentId));
}

async function loadTaxonomyForClassifier(): Promise<TaxonomyEntry[]> {
  const rows = await db
    .select({
      slug: documentCategories.slug,
      name: documentCategories.name,
      parent_id: documentCategories.parent_id,
      id: documentCategories.id,
    })
    .from(documentCategories);

  const byId = new Map<number, { slug: string; name: string }>();
  for (const r of rows) byId.set(r.id, { slug: r.slug, name: r.name });

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    parent_slug: r.parent_id != null ? byId.get(r.parent_id)?.slug ?? null : null,
  }));
}

async function replaceTagLinks(documentId: number, tagNames: readonly string[]): Promise<void> {
  await db
    .delete(documentTagLinks)
    .where(eq(documentTagLinks.document_id, documentId));

  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const inserted = await db
      .insert(documentTags)
      .values({ name })
      .onConflictDoNothing()
      .returning({ id: documentTags.id });
    let tagId: number | undefined = inserted[0]?.id;
    if (tagId === undefined) {
      const found = await dbFirst<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(eq(documentTags.name, name)),
      );
      tagId = found?.id;
    }
    if (tagId === undefined) continue;

    await db
      .insert(documentTagLinks)
      .values({ document_id: documentId, tag_id: tagId })
      .onConflictDoNothing();
  }
}

/**
 * Split `text` into chunks of roughly `maxChars` characters, preferring
 * paragraph boundaries so a chunk rarely ends mid-sentence.
 */
function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current.length === 0) {
      current = p;
    } else if (current.length + p.length + 2 <= maxChars) {
      current = `${current}\n\n${p}`;
    } else {
      chunks.push(current);
      current = p;
    }
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Exported for tests / seed completeness checks. */
export { flattenTaxonomy };
