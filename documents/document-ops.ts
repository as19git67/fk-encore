/**
 * Core operations the worker and API endpoints share.
 *
 * Split out of `documents.ts` so the worker can run its pipeline
 * (text-extract → classify → embed) without importing the Encore API
 * layer.
 */

import fs from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentReceiptExtraction,
  documentSubjectPersons,
  documentTagLinks,
  documentTags,
  documentTaxSections,
  documents,
} from "../db/schema";
import { createReceiptAutoTransaction } from "../finance/receipt-booking";
import {
  extractReceipt,
  extractReceiptItems,
  isReceiptOcrHealthy,
  ReceiptOcrUnavailableError,
} from "./receipt-ocr-client";
import { extractPdfText, PdfPasswordRequiredError } from "./text-extract";
import { buildThumbnail } from "./thumbnail";
import { removeOcrPdf, writeOcrPdf } from "./ocr-pdf";
import { deleteJobsForDocument } from "./scan-queue";
import { checkReceiptEnrichment, createSuggestionsForDocument } from "../finance/document-match.service";
import {
  assertPathUnderDocumentsRoot,
} from "./documents.service";
import { relocateDocument } from "./relocate";
import {
  classifyDocument,
  embedTexts,
  type Classification,
  type TaxAssignment,
  type TaxSectionRequestEntry,
  type TaxonomyEntry,
} from "./llm-client";
import { loadEffectiveTaxSections } from "./tax-hint-overrides";
import { loadSubjectPersonsForMatch } from "./subject-persons";
import { flattenTaxonomy, taxonomyHints } from "./taxonomy";
import { matchSenderRule } from "./sender-rules";
import { buildClassifyExamples } from "./few-shot";
import {
  detectSubjectPersonIds,
  extractDocumentNumber,
  extractReferenceNumberTags,
  isSubjectPersonSender,
  reconcileSubjectPersonTags,
} from "./metadata-extract";
import { realtime, push } from "~encore/clients";

console.log("[boot] documents/document-ops.ts: all imports resolved");

type DocumentStatus = "pending" | "extracting" | "classifying" | "ready" | "failed" | "encrypted";

/**
 * Fire-and-forget realtime notification for a document status change.
 * Errors are swallowed — the scan pipeline must not break when the
 * realtime service is unavailable.
 */
async function publishStatusChanged(
  documentId: number,
  ownerUserId: number,
  status: DocumentStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await realtime.publishEvent({
      userIds: [String(ownerUserId)],
      channel: "documents",
      type: "status.changed",
      resourceId: String(documentId),
      payload: { status, ...extra },
    });
  } catch (err) {
    console.warn(
      `[documents] realtime publish failed for doc=${documentId} status=${status}: ${(err as Error).message}`,
    );
  }
}

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

/**
 * Characters of overlap between consecutive chunks. The previous
 * implementation produced strictly disjoint chunks, which meant a
 * sentence split across the boundary lost half its context to either
 * chunk and degraded recall on phrases like "Vermieterbescheinigung
 * für 2024" if "Vermieterbescheinigung" ended one chunk and "2024"
 * started the next. ~150 chars (≈25–30 words) is the rule-of-thumb
 * sweet spot in retrieval literature: enough to bridge a sentence,
 * cheap in storage (≈10 % more chunks).
 *
 * Set to 0 to disable overlap entirely; the chunker falls back to
 * the historical disjoint behaviour.
 */
const EMBED_CHUNK_OVERLAP_CHARS = parseInt(
  process.env.DOCUMENTS_EMBED_CHUNK_OVERLAP_CHARS ?? "150",
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
  await publishStatusChanged(documentId, row.user_id, "extracting");

  // Warm the preview-thumbnail cache while we already hold the PDF on
  // disk. Best-effort: a failed render must never block text extraction.
  await buildThumbnail(documentId, row.disk_path).catch(() => null);

  let result;
  try {
    result = await extractPdfText(row.disk_path, {
      forceOcr: row.force_ocr ?? false,
    });
  } catch (err) {
    if (err instanceof PdfPasswordRequiredError) {
      // The file needs an open password we don't have. Park it in the
      // `encrypted` state so the UI can prompt for the password, and drop
      // the downstream classify/embed jobs so they don't spin deferring on
      // a document that will never have extracted text until it's unlocked.
      await db
        .update(documents)
        .set({ status: "encrypted", last_error: null })
        .where(eq(documents.id, documentId));
      await publishStatusChanged(documentId, row.user_id, "encrypted");
      await deleteJobsForDocument(documentId);
      return;
    }
    throw err;
  }
  const text = result.text ?? "";

  // Persist (or clear) the searchable OCR sidecar so the viewer and the
  // download endpoint can serve a version with a selectable text layer.
  // A born-digital PDF returns no sidecar; remove any stale one left over
  // from a previous file (e.g. after replaceDocumentFile reuses the id).
  try {
    if (result.searchablePdf && result.searchablePdf.length > 0) {
      await writeOcrPdf(documentId, result.searchablePdf);
    } else {
      await removeOcrPdf(documentId);
    }
  } catch (err) {
    console.warn(
      `[documents] persisting OCR sidecar for doc=${documentId} failed: ${(err as Error).message}`,
    );
  }

  await db
    .update(documents)
    .set({
      extracted_text: text.length === 0 ? null : text,
      status: "classifying",
    })
    .where(eq(documents.id, documentId));
  await publishStatusChanged(documentId, row.user_id, "classifying");
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
  const effectiveSections = await loadEffectiveTaxSections();
  const tax_sections: TaxSectionRequestEntry[] = effectiveSections.map((s) => ({
    slug: s.slug,
    name: s.name,
    group: s.group,
    hint: s.hint,
  }));
  const subjectPersons = await loadSubjectPersonsForMatch(row.user_id);
  const subject_persons = subjectPersons.map(({ full_name, relation_tag }) => ({
    full_name,
    relation_tag,
  }));
  // Retrieval-augmented few-shot: anchor the LLM with the nearest already-
  // classified documents of this household. Best-effort — degrades to plain
  // zero-shot when the embedder is down or no prior corpus exists.
  const examples = await buildClassifyExamples({
    documentId,
    userId: row.user_id,
    text: clipped,
  });
  const classification = await classifyDocument({
    text: clipped,
    taxonomy,
    tax_sections,
    subject_persons,
    examples,
  });

  // Deterministic metadata cleanup (see metadata-extract.ts, #664):
  // 1. The document number comes only from an explicit "#1234" marker; the
  //    LLM's free-form guess (often a contract/insurance number) is dropped.
  classification.document_number = extractDocumentNumber(clipped);
  // 2. A recipient/Bezugsperson is never the sender — drop it if the
  //    classifier echoed a known subject person into the sender field.
  if (isSubjectPersonSender(classification.sender, subject_persons)) {
    classification.sender = null;
  }
  // 3. Labelled contract/insurance/order numbers become searchable tags (the
  //    '#'-only document number no longer carries them).
  const referenceTags = extractReferenceNumberTags(clipped);
  if (referenceTags.length > 0) {
    classification.tags = [...classification.tags, ...referenceTags];
  }
  // 4. Deterministically link the Bezugspersonen mentioned in the text.
  const subjectPersonIds = detectSubjectPersonIds(clipped, subjectPersons);
  // 5. Person identity is deterministic, not the LLM's guess: strip any
  //    Bezugspersonen relation tag the classifier hallucinated (e.g. a
  //    sibling/parent not actually named in the document) and ensure the
  //    detected persons' relation tags are present.
  classification.tags = reconcileSubjectPersonTags(
    classification.tags,
    subjectPersons,
    subjectPersonIds,
  );

  // Deterministic sender → category routing (see sender-rules.ts). A known
  // recurring institution overrides the LLM's category guess, which otherwise
  // funnels most documents into the generic "finanzen-rechnungen" bucket.
  const ruleSlug = matchSenderRule({
    sender: classification.sender,
    title: classification.title,
    text: clipped,
  });
  if (ruleSlug && ruleSlug !== classification.category_slug) {
    console.log(
      `[documents] sender rule override(${documentId}): ` +
        `"${classification.sender}" ${classification.category_slug} → ${ruleSlug}`,
    );
  }
  const catSlug = ruleSlug ?? classification.category_slug;
  const cat = await dbFirst<{ id: number }>(
    db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, catSlug)),
  );

  const patch: Partial<typeof documents.$inferInsert> = {
    status: "ready",
  };
  // Only overwrite the human-editable attributes when the user has not pinned
  // them via the edit dialog. `attributes_reviewed=true` means a human has
  // asserted these values and the classifier must not undo them (mirrors the
  // `tax_reviewed` guard below for the tax fields).
  if (!row.attributes_reviewed) {
    patch.category_id = cat?.id ?? null;
    patch.title = classification.title || row.title || row.original_filename;
    patch.doc_date = classification.doc_date;
    patch.sender = classification.sender;
    patch.document_number = classification.document_number;
    patch.summary = classification.summary;
    patch.classification_confidence = classification.confidence;
  }
  // Only overwrite tax fields when the user has not pinned them via the
  // /documents/:id/tax endpoint. `tax_reviewed=true` means the human has
  // asserted the ground truth and the classifier must not undo it.
  if (!row.tax_reviewed) {
    patch.tax_relevant = classification.tax_relevant;
    patch.tax_year = classification.tax_year;
    patch.tax_year_confidence = classification.tax_year_confidence;
  }

  await db.update(documents).set(patch).where(eq(documents.id, documentId));
  // Advisory only: a document becoming OCR-ready must not delay the pipeline.
  void createSuggestionsForDocument(documentId).catch(err => console.error(`[documents] finance matching failed for document=${documentId}:`, err));
  void checkReceiptEnrichment(documentId).catch(err => console.error(`[documents] receipt enrichment check failed for document=${documentId}:`, err));

  // Report the category the document actually carries now: the fresh guess
  // when applied, or the pinned existing one when attributes are reviewed.
  let effectiveCatSlug: string | null = catSlug;
  if (row.attributes_reviewed) {
    effectiveCatSlug =
      row.category_id == null
        ? null
        : (
            await dbFirst<{ slug: string }>(
              db
                .select({ slug: documentCategories.slug })
                .from(documentCategories)
                .where(eq(documentCategories.id, row.category_id)),
            )
          )?.slug ?? null;
  }
  await publishStatusChanged(documentId, row.user_id, "ready", {
    category_slug: effectiveCatSlug,
    confidence: classification.confidence,
  });

  await replaceTagLinks(documentId, classification.tags);
  await replaceAiSubjectPersons(documentId, subjectPersonIds);

  if (!row.tax_reviewed) {
    await replaceAiTaxSections(documentId, classification.tax_sections);
  }

  // The classifier filled in category / doc_date / sender / title / tax
  // metadata — everything the speaking path depends on. Move the file
  // to its canonical location now (and rebuild the `_steuer/` view).
  try {
    await relocateDocument(documentId);
  } catch (err) {
    console.warn(
      `[documents] relocate after classify(${documentId}) failed: ${(err as Error).message}`,
    );
  }

  // A reviewed document's attributes weren't touched, so there is nothing to
  // flag for review even if the (ignored) guess was low-confidence.
  const lowConfidence =
    !row.attributes_reviewed && classification.confidence < LOW_CONFIDENCE_THRESHOLD;
  if (lowConfidence) {
    // Best-effort — push must never block the pipeline.
    push
      .notifyDocumentReview({
        userId: row.user_id,
        kind: "low_confidence",
        documentId,
        documentTitle: classification.title || row.title || row.original_filename,
        reason: null,
      })
      .catch((err: unknown) =>
        console.warn(
          `[documents] notifyDocumentReview(low_confidence,${documentId}) failed: ${(err as Error).message}`,
        ),
      );
  }
  return { classification, lowConfidence };
}

/**
 * Replace the AI-source tax-section rows for a document.
 *
 * User-source rows (`source='user'`) are left untouched so a re-classify
 * does not wipe out a manual override. The composite primary key
 * `(document_id, tax_section)` means a slug that exists with source='user'
 * will block an AI insert via `onConflictDoNothing`, which is the
 * behaviour we want.
 */
async function replaceAiTaxSections(
  documentId: number,
  assignments: readonly TaxAssignment[],
): Promise<void> {
  await db
    .delete(documentTaxSections)
    .where(
      and(
        eq(documentTaxSections.document_id, documentId),
        eq(documentTaxSections.source, "ai"),
      ),
    );

  for (const a of assignments) {
    await db
      .insert(documentTaxSections)
      .values({
        document_id: documentId,
        tax_section: a.slug,
        confidence: a.confidence,
        source: "ai",
      })
      .onConflictDoNothing();
  }
}

/**
 * Replace the AI-source Bezugsperson links for a document. Like the tax
 * sections, user-source rows (`source='user'`) are left untouched so a manual
 * assignment survives a re-classify; the composite primary key blocks an AI
 * insert over an existing user row via `onConflictDoNothing`.
 */
async function replaceAiSubjectPersons(
  documentId: number,
  subjectPersonIds: readonly number[],
): Promise<void> {
  await db
    .delete(documentSubjectPersons)
    .where(
      and(
        eq(documentSubjectPersons.document_id, documentId),
        eq(documentSubjectPersons.source, "ai"),
      ),
    );

  for (const id of subjectPersonIds) {
    await db
      .insert(documentSubjectPersons)
      .values({ document_id: documentId, subject_person_id: id, source: "ai" })
      .onConflictDoNothing();
  }
}

/**
 * Job: `embed`.
 * Slices the extracted text into ~1500-char chunks, embeds each via
 * the LLM service, and upserts into `document_embeddings`. Skips
 * documents with no text (embeddings on an empty string are useless).
 *
 * The first chunk is prefixed with a `Tags: …` line whenever the
 * document has any tags. This gives semantic search a hit on
 * subject-person tags like `mutter` even though those words do not
 * appear in the OCR text. Tag changes after the initial embed do not
 * automatically re-embed — re-classify the document if a tag-based
 * search query should pick it up.
 */
export async function runEmbed(documentId: number): Promise<{ chunks: number } | { deferred: true }> {
  const row = await getDocumentOrThrow(documentId);
  const text = (row.extracted_text ?? "").trim();
  if (text.length === 0) return { deferred: true };

  const chunks = chunkText(text, EMBED_CHUNK_CHARS, EMBED_CHUNK_OVERLAP_CHARS)
    .slice(0, EMBED_MAX_CHUNKS);
  if (chunks.length === 0) return { chunks: 0 };

  const tagNames = await loadDocumentTagNames(documentId);
  if (tagNames.length > 0) {
    chunks[0] = `Tags: ${tagNames.join(", ")}\n\n${chunks[0]}`;
  }

  // `kind: "passage"` is the default but spelt out so the asymmetric
  // contract with the search-side `embedTexts(_, "query")` call is
  // visible at this site.
  const embeddings = await embedTexts(chunks, "passage");
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
    // The literal is parsed as `vector` regardless of whether the column
    // is `vector(768)` (pgvector < 0.7) or `halfvec(768)` (after migration
    // 0054 on pgvector >= 0.7). pgvector defines an implicit assignment
    // cast vector → halfvec, so the INSERT works against both column
    // types without runtime introspection.
    await db.execute(sql`
      INSERT INTO document_embeddings (document_id, chunk_idx, chunk_text, embedding)
      VALUES (${documentId}, ${i}, ${chunks[i]}, ${literal}::vector)
    `);
  }

  return { chunks: chunks.length };
}

/**
 * Mark a document as failed. Called by the worker after a job has
 * exhausted retries so the UI can surface the error.
 */
export async function markDocumentFailed(documentId: number, reason: string): Promise<void> {
  const row = await dbFirst<{ user_id: number; title: string | null; original_filename: string }>(
    db
      .select({
        user_id: documents.user_id,
        title: documents.title,
        original_filename: documents.original_filename,
      })
      .from(documents)
      .where(eq(documents.id, documentId)),
  );
  await db
    .update(documents)
    .set({ status: "failed", last_error: reason })
    .where(eq(documents.id, documentId));
  if (row) {
    await publishStatusChanged(documentId, row.user_id, "failed", { reason });
    push
      .notifyDocumentReview({
        userId: row.user_id,
        kind: "failed",
        documentId,
        documentTitle: row.title ?? row.original_filename,
        reason,
      })
      .catch((err: unknown) =>
        console.warn(
          `[documents] notifyDocumentReview(failed,${documentId}) failed: ${(err as Error).message}`,
        ),
      );
  }
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

  // Hints live in the seed taxonomy (prompt-only, no DB column) and are
  // merged in by slug so borderline documents land in the right bucket.
  const hints = taxonomyHints();

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    parent_slug: r.parent_id != null ? byId.get(r.parent_id)?.slug ?? null : null,
    hint: hints.get(r.slug),
  }));
}

async function loadDocumentTagNames(documentId: number): Promise<string[]> {
  const rows = await db
    .select({ name: documentTags.name })
    .from(documentTagLinks)
    .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
    .where(eq(documentTagLinks.document_id, documentId))
    .orderBy(documentTags.name);
  return rows.map((r) => r.name);
}

/**
 * Replace the AI-suggested tag links of a document.
 *
 * Only `source='ai'` rows are touched: human-curated (`source='user'`) tags
 * survive a re-classify. The `onConflictDoNothing` on the (document_id,
 * tag_id) primary key means an AI tag that the user has already pinned stays
 * a user row rather than being demoted to 'ai'. Exported for tests.
 */
export async function replaceTagLinks(documentId: number, tagNames: readonly string[]): Promise<void> {
  await db
    .delete(documentTagLinks)
    .where(
      and(
        eq(documentTagLinks.document_id, documentId),
        eq(documentTagLinks.source, "ai"),
      ),
    );

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
      .values({ document_id: documentId, tag_id: tagId, source: "ai" })
      .onConflictDoNothing();
  }
}

/**
 * Split `text` into chunks of roughly `maxChars` characters, preferring
 * paragraph boundaries so a chunk rarely ends mid-sentence. When
 * `overlapChars > 0`, each non-leading chunk starts with the trailing
 * `overlapChars`-window of its predecessor (snapped to a whitespace
 * boundary so words aren't sliced) — this keeps phrases that straddle
 * a chunk boundary recoverable from at least one of the two chunks.
 *
 * Exported for unit tests.
 */
export function chunkText(text: string, maxChars: number, overlapChars: number = 0): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";

  // Tail of `s` of about `overlapChars` characters, snapped forward to
  // the next whitespace so we don't slice mid-word. Returns the empty
  // string when overlap is disabled or the source is shorter than the
  // overlap window (in which case carrying the whole string would just
  // duplicate the previous chunk wholesale).
  const tail = (s: string): string => {
    if (overlapChars <= 0 || s.length <= overlapChars) return "";
    const start = s.length - overlapChars;
    const ws = s.indexOf(" ", start);
    if (ws !== -1 && ws < s.length - 1) return s.slice(ws + 1);
    return s.slice(start);
  };

  for (const p of paragraphs) {
    if (current.length === 0) {
      current = p;
    } else if (current.length + p.length + 2 <= maxChars) {
      current = `${current}\n\n${p}`;
    } else {
      chunks.push(current);
      const carry = tail(current);
      current = carry.length > 0 ? `${carry}\n\n${p}` : p;
    }
    while (current.length > maxChars) {
      // Hard split inside an over-long single paragraph.
      const cut = current.slice(0, maxChars);
      chunks.push(cut);
      const carry = tail(cut);
      current = carry + current.slice(maxChars);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Replace every tax-section assignment for a document with a user-supplied
 * set. Used by `POST /documents/:id/tax` when the caller overrides the
 * classifier. All previous rows (AI and user) are removed so the override
 * is authoritative.
 */
export async function replaceUserTaxSections(
  documentId: number,
  slugs: readonly string[],
): Promise<void> {
  await db
    .delete(documentTaxSections)
    .where(eq(documentTaxSections.document_id, documentId));

  const seen = new Set<string>();
  for (const slug of slugs) {
    const s = slug.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    await db
      .insert(documentTaxSections)
      .values({
        document_id: documentId,
        tax_section: s,
        confidence: 1,
        source: "user",
      })
      .onConflictDoNothing();
  }
}

/** Exported for tests / seed completeness checks. */
export { flattenTaxonomy };

// ─── Receipt-OCR background job ───────────────────────────────────────────────

/** Amount threshold for automatic booking (plan decision §3). */
const RECEIPT_AUTO_BOOK_MIN = 0;
const RECEIPT_AUTO_BOOK_MAX = 999;

/**
 * Return today's date as YYYY-MM-DD in local server time.
 * Used to cap the booking date so a receipt can never be booked in the future.
 */
function localTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Job: `receipt_ocr`.
 *
 * Runs only for documents captured via the `receipt-capture` endpoint
 * with an `X-Account-Id` header (i.e. `receipt_ocr_state = 'pending'`).
 *
 * Pipeline:
 * 1. Call receipt-ocr-service to extract amount / date / store / items.
 * 2. Persist the raw extraction in `document_receipt_extraction`.
 * 3. If the amount is reliable (>0 and <=999): auto-create a cash transaction.
 * 4. If not reliable: mark the document as `incomplete`.
 *
 * Throws `ReceiptOcrUnavailableError` when the service is down so the
 * worker defers the job (retry with exponential back-off, no permanent failure).
 */
export async function runReceiptOcr(documentId: number): Promise<void> {
  const row = await getDocumentOrThrow(documentId);

  // Guard: only process documents that are waiting for receipt OCR.
  if (row.receipt_ocr_state !== "pending") return;
  if (!row.receipt_account_id) {
    // No account chosen — mark incomplete so UI can notify the user.
    await db.update(documents)
      .set({ receipt_ocr_state: "incomplete" })
      .where(eq(documents.id, documentId));
    return;
  }

  // Health check — defer the job if the service is cold/restarting.
  const healthy = await isReceiptOcrHealthy().catch(() => false);
  if (!healthy) {
    throw new ReceiptOcrUnavailableError("receipt-ocr-service health check failed");
  }

  // Read the stored PDF/image from disk.
  assertPathUnderDocumentsRoot(row.disk_path);
  const buffer = await fs.readFile(row.disk_path);

  // Receipt captures are stored as PDF (image wrapped in PDF by uploadReceiptCapture),
  // but the receipt-ocr service expects an image. Extract the embedded JPEG so the
  // service receives the same data the old synchronous path used to send.
  let ocrBuffer: Buffer = buffer;
  let ocrMimeType = row.mime_type;
  let ocrFilename = row.original_filename;
  if (row.mime_type === "application/pdf") {
    const jpeg = extractJpegFromPdf(buffer);
    if (jpeg) {
      ocrBuffer = jpeg;
      ocrMimeType = "image/jpeg";
      ocrFilename = row.original_filename.replace(/\.pdf$/i, ".jpg");
    }
    // If no JPEG found (genuine PDF receipt), fall through — the service may handle PDFs.
  }

  // Stage 1: core extraction (amount / date / store).
  const core = await extractReceipt(ocrBuffer, ocrFilename, ocrMimeType);

  // Stage 2: line-item extraction — best-effort, failures don't block booking.
  let items: Array<{ name: string; amount: number }> = [];
  if (core.raw_text) {
    try {
      const itemsResult = await extractReceiptItems(core.raw_text);
      items = itemsResult.items;
    } catch (err) {
      console.warn(
        `[documents] receipt items extraction failed for doc=${documentId}: ${(err as Error).message}`,
      );
    }
  }

  // Persist extraction result.
  await db
    .insert(documentReceiptExtraction)
    .values({
      document_id: documentId,
      amount: core.amount != null ? String(core.amount) : null,
      receipt_date: core.date,
      store: core.store,
      items,
      ocr_confidence: core.ocr_confidence,
    })
    .onConflictDoUpdate({
      target: documentReceiptExtraction.document_id,
      set: {
        amount: core.amount != null ? String(core.amount) : null,
        receipt_date: core.date,
        store: core.store,
        items,
        ocr_confidence: core.ocr_confidence,
      },
    });

  // Determine if the amount is reliable enough for auto-booking.
  const reliable =
    core.amount != null &&
    core.amount > RECEIPT_AUTO_BOOK_MIN &&
    core.amount <= RECEIPT_AUTO_BOOK_MAX;

  if (!reliable) {
    await db.update(documents)
      .set({ receipt_ocr_state: "incomplete" })
      .where(eq(documents.id, documentId));
    console.log(
      `[documents] receipt OCR doc=${documentId}: amount=${core.amount} outside reliable range — marked incomplete`,
    );
    // Notify user that receipt was recognised but amount needs manual entry.
    void realtime.publishEvent({
      userIds: [String(row.user_id)],
      channel: "finance",
      type: "receipt.incomplete",
      resourceId: String(documentId),
      payload: { document_id: documentId },
    }).catch(err => console.warn(`[documents] receipt.incomplete realtime failed doc=${documentId}: ${(err as Error).message}`));
    void push.notifyReceiptIncomplete({ userId: row.user_id, documentId })
      .catch(err => console.warn(`[documents] notifyReceiptIncomplete failed doc=${documentId}: ${(err as Error).message}`));
    return;
  }

  // Clamp booking date: use receipt date, fall back to today, never in the future.
  const today = localTodayIso();
  let bookingDate = core.date ?? today;
  if (bookingDate > today) bookingDate = today;

  // Build a purpose string from items (e.g. "Milch, Joghurt, Brot").
  const purpose =
    items.length > 0
      ? items.map((i) => i.name).join(", ").slice(0, 255)
      : null;

  const txId = await createReceiptAutoTransaction({
    documentId,
    accountId: row.receipt_account_id,
    amount: -(core.amount!), // expenses are negative
    bookingDate,
    counterparty: core.store,
    purpose,
    currencyCode: core.currency ?? "EUR",
  });

  if (txId !== null) {
    console.log(
      `[documents] receipt OCR doc=${documentId}: auto-booked tx=${txId} amount=${core.amount} on account=${row.receipt_account_id}`,
    );
    // Notify user that a new transaction was automatically created.
    void realtime.publishEvent({
      userIds: [String(row.user_id)],
      channel: "finance",
      type: "receipt.booked",
      resourceId: String(txId),
      payload: { transaction_id: txId, document_id: documentId, amount: core.amount, store: core.store },
    }).catch(err => console.warn(`[documents] receipt.booked realtime failed doc=${documentId}: ${(err as Error).message}`));
    void push.notifyReceiptBooked({
      userId: row.user_id,
      transactionId: txId,
      documentId,
      amount: core.amount!,
      store: core.store,
    }).catch(err => console.warn(`[documents] notifyReceiptBooked failed doc=${documentId}: ${(err as Error).message}`));
  }
}

/**
 * Extract the embedded JPEG from a hand-crafted receipt PDF (as built by
 * `singleJpegPagePdf` in documents.ts). The receipt-ocr service expects an
 * image, not a PDF wrapper, so we recover the raw JPEG bytes by locating the
 * SOI (FF D8) / EOI (FF D9) markers inside the PDF binary.
 *
 * Returns null for genuine PDFs that don't contain a raw JPEG stream.
 */
function extractJpegFromPdf(pdfBuf: Buffer): Buffer | null {
  let start = -1;
  for (let i = 0; i < pdfBuf.length - 1; i++) {
    if (pdfBuf[i] === 0xff && pdfBuf[i + 1] === 0xd8) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = -1;
  for (let i = pdfBuf.length - 2; i >= start; i--) {
    if (pdfBuf[i] === 0xff && pdfBuf[i + 1] === 0xd9) {
      end = i + 2;
      break;
    }
  }
  if (end === -1) return null;

  return Buffer.from(pdfBuf.subarray(start, end));
}
