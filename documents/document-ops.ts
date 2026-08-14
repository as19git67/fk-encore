/**
 * Core operations the worker and API endpoints share.
 *
 * Split out of `documents.ts` so the worker can run its pipeline
 * (text-extract → classify → embed) without importing the Encore API
 * layer.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
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
import { attachReceiptToExistingTransaction, createReceiptAutoTransaction } from "../finance/receipt-booking";
import { formatReceiptLineItemsNotice } from "../finance/receipt-line-items";
import { enqueueTagSuggestion } from "../finance/tag-queue";
import { triggerTagWorker } from "../finance/tag-worker";
import {
  extractReceipt,
  extractReceiptItems,
  isReceiptOcrHealthy,
  ReceiptOcrUnavailableError,
} from "./receipt-ocr-client";
import { extractPdfText, PdfPasswordRequiredError } from "./text-extract";
import { buildThumbnail, ensureThumbnail, removeThumbnail } from "./thumbnail";
import { ensureSearchablePdf, removeOcrPdf, writeOcrPdf } from "./ocr-pdf";
import { jpegToReceiptPdf } from "./receipt-pdf";
import {
  buildReceiptDocumentCompletion,
  isReliableReceiptAmount,
} from "./receipt-capture";
import { deleteJobsForDocument } from "./scan-queue";
import { checkReceiptEnrichment, createSuggestionsForDocument } from "../finance/document-match.service";
import {
  assertPathUnderDocumentsRoot,
} from "./documents.service";
import { relocateDocument } from "./relocate";
import { withDocumentLock } from "./document-lock";
import {
  classifyDocument,
  embedTexts,
  type Classification,
  type DocumentTypeRequestEntry,
  type TaxAssignment,
  type TaxSectionRequestEntry,
  type TaxonomyEntry,
} from "./llm-client";
import { loadEffectiveTaxSections } from "./tax-hint-overrides";
import { isValidTaxSectionSlug } from "./tax-sections";
import { DOCUMENT_TYPES } from "./document-types";
import { loadRemovedSubjectPersonIds, loadSubjectPersonsForMatch } from "./subject-persons";
import { flattenTaxonomy, taxonomyHints } from "./taxonomy";
import { matchContentRule, matchSenderRule } from "./sender-rules";
import { loadSenderRuleOverrides } from "./sender-rule-overrides";
import { buildClassifyExamples } from "./few-shot";
import {
  learnedRelationTags,
  loadLearnedMemory,
  mergeLearnedPersonIds,
  mergeLearnedTags,
  mergeLearnedTaxSections,
  resolveLearned,
} from "./learned-rules";
import { recordUncategorizedDocument } from "./suggestion-writer";
import {
  applyAgricultureFiscalYearTaxRule,
  applyKirchensteuerBescheidYearTaxRule,
  applyInsuranceAdminTaxRule,
  applyKindergeldTaxRule,
  applySecuritiesSettlementTaxRule,
} from "./tax-rules";
import {
  buildUmlautRestorationMap,
  detectSubjectPersonIds,
  detectSubjectPersonPersonalDeductionReview,
  extractDocumentDate,
  extractDocumentNumber,
  extractReferenceNumberTags,
  isSubjectPersonSender,
  reconcileSubjectPersonTags,
  restoreUmlautSpellings,
} from "./metadata-extract";
import { realtime, push } from "~encore/clients";

console.log("[boot] documents/document-ops.ts: all imports resolved");

type DocumentStatus = "pending" | "extracting" | "classifying" | "ready" | "failed" | "encrypted";

function isWaitingForTextExtraction(status: DocumentStatus): boolean {
  return status === "pending" || status === "extracting";
}

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
 * Re-read `disk_path` fresh from the DB right before opening the file.
 * Guards against TOCTOU races where a concurrent `relocateDocument`
 * moved the file between the initial row fetch and the actual read.
 */
async function freshDiskPath(id: number): Promise<string> {
  const row = await getDocumentOrThrow(id);
  assertPathUnderDocumentsRoot(row.disk_path);
  return row.disk_path;
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
    const currentPath = await freshDiskPath(documentId);
    result = await extractPdfText(currentPath, {
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

  // Settle on the PDF this document will actually be served as: the sandwich
  // just written, or — for a born-digital PDF drawn sideways — a losslessly
  // rotated copy (see ocr-pdf.ts). Doing it here rather than on first view
  // keeps the wait out of the viewer, and lets the preview thumbnail be
  // rebuilt from the same file, so grid and viewer agree on which way is up.
  // The early warm-up above already rendered a thumbnail from the original;
  // this replaces it only when the served PDF turns out to differ.
  try {
    const servedPdf = await ensureSearchablePdf(documentId, await freshDiskPath(documentId));
    if (servedPdf) await buildThumbnail(documentId, servedPdf);
  } catch (err) {
    console.warn(
      `[documents] refreshing preview for doc=${documentId} failed: ${(err as Error).message}`,
    );
  }

  // Receipt captures (identified by a set receipt_ocr_state) run a trimmed
  // pipeline — only text_extract + receipt_ocr, no classify/embed — so
  // text_extract is their terminal step. Settle them on "ready" instead of
  // "classifying"; otherwise they'd hang in "KI-Analyse" forever, because no
  // classify job ever runs to move them on. (receipt_ocr tracks its own
  // progress separately via receipt_ocr_state.)
  const isReceiptCapture = row.receipt_ocr_state != null;
  const nextStatus: DocumentStatus = isReceiptCapture ? "ready" : "classifying";

  await db
    .update(documents)
    .set({
      extracted_text: text.length === 0 ? null : text,
      status: nextStatus,
    })
    .where(eq(documents.id, documentId));
  await publishStatusChanged(documentId, row.user_id, nextStatus);
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
    if (isWaitingForTextExtraction(row.status)) {
      return { deferred: true };
    }
    throw new Error("classify: no extracted text available after text extraction");
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
  // Document-type facet: the fixed vocabulary is sent as the label set so the
  // classifier picks the single best-matching type (see document-types.ts).
  const document_types: DocumentTypeRequestEntry[] = DOCUMENT_TYPES.map((t) => ({
    slug: t.slug,
    name: t.name,
    hint: t.hint,
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
    document_types,
    tax_sections,
    subject_persons,
    examples,
  });

  // Deterministic metadata cleanup (see metadata-extract.ts, #664):
  // 1. The document number comes only from an explicit "#1234" marker; the
  //    LLM's free-form guess (often a contract/insurance number) is dropped.
  classification.document_number = extractDocumentNumber(clipped);
  // 1b. The date: the small model frequently returns null even when the date is
  //     plainly labelled in the text ("Datum: 11.08.14", "Rechnungsdatum
  //     18.01.2021"). Fill it — but never OVERRIDE a date the LLM did produce,
  //     whose nuanced choice (salary month vs. delivery date, …) is better —
  //     from a deterministic label-anchored scan (see metadata-extract.ts).
  if (!classification.doc_date) {
    classification.doc_date = extractDocumentDate(clipped);
  }
  // 2. A recipient/Bezugsperson is never the sender — drop it if the
  //    classifier echoed a known subject person into the sender field.
  if (isSubjectPersonSender(classification.sender, subject_persons)) {
    classification.sender = null;
  }
  // 2b. The small model regularly transliterates umlauts ("pruefung",
  //     "Gebuehrenbescheid") despite the prompt forbidding it. Restore the
  //     spellings that literally occur in the OCR text (dictionary-based, so
  //     "Michael"/"Masse" are never falsely umlautified — see
  //     metadata-extract.ts). Sender is deliberately left untouched: the
  //     learned-rules memory and the sender rules key on the sender string,
  //     and rewriting it would orphan the memory built from earlier documents.
  const umlautMap = buildUmlautRestorationMap(clipped);
  classification.title = restoreUmlautSpellings(classification.title, umlautMap) ?? "";
  classification.summary = restoreUmlautSpellings(classification.summary, umlautMap) ?? "";
  classification.tags = classification.tags.map(
    (t) => restoreUmlautSpellings(t, umlautMap) ?? t,
  );

  // Learned per-user memory from reviewed / user-curated documents, keyed by
  // the now-finalized sender. Drives the category / tax / tag / Bezugsperson
  // enrichment below (see learned-rules.ts). Best-effort — empty on any error.
  const learnedMemory = await loadLearnedMemory(row.user_id, documentId);
  const learned = resolveLearned(learnedMemory, classification.sender);

  // 3. Labelled contract/insurance/order numbers become searchable tags (the
  //    '#'-only document number no longer carries them).
  const referenceTags = extractReferenceNumberTags(clipped);
  if (referenceTags.length > 0) {
    classification.tags = [...classification.tags, ...referenceTags];
  }
  // 3b. Content tags the user consistently files for this sender (learned).
  classification.tags = mergeLearnedTags(classification.tags, learned);

  // 4. Deterministically link the Bezugspersonen mentioned in the text, then
  //    add the ones the user consistently links for this sender (learned) —
  //    catches OCR-garbled names the in-text detector misses. Persons the
  //    user explicitly REMOVED from this document (migration 0138) are
  //    filtered out of both sources: an explicit per-document removal beats
  //    name detection and sender memory alike.
  const detectedPersonIds = detectSubjectPersonIds(clipped, subjectPersons);
  const removedPersonIds = await loadRemovedSubjectPersonIds(documentId);
  const subjectPersonIds = mergeLearnedPersonIds(detectedPersonIds, learned).filter(
    (id) => !removedPersonIds.has(id),
  );
  // A learned person is user-confirmed evidence, so surface their relation tag
  // even when the name is absent from the text; reconcile keeps it because the
  // id is in the confirmed set below.
  classification.tags = [
    ...classification.tags,
    ...learnedRelationTags(learned, subjectPersons),
  ];
  // 5. Person identity is deterministic, not the LLM's guess: strip any
  //    Bezugspersonen relation tag the classifier hallucinated (e.g. a
  //    sibling/parent not actually named in the document) and keep the
  //    detected + learned persons' relation tags.
  classification.tags = reconcileSubjectPersonTags(
    classification.tags,
    subjectPersons,
    subjectPersonIds,
  );

  // 6. Rescue tax-section slugs that the LLM put into tags instead of
  //    tax_sections (e.g. "anlage-n" as a tag on a payslip).
  const rescuedSections: TaxAssignment[] = [];
  classification.tags = classification.tags.filter((tag) => {
    const slug = tag.toLowerCase();
    if (isValidTaxSectionSlug(slug)) {
      if (!classification.tax_sections.some((s) => s.slug === slug)) {
        rescuedSections.push({ slug, confidence: 0.7 });
      }
      return false;
    }
    return true;
  });
  if (rescuedSections.length > 0) {
    classification.tax_sections = [...classification.tax_sections, ...rescuedSections];
    classification.tax_relevant = true;
  }

  // 7. Tax sections the user consistently assigns for this sender (learned).
  //    Reflects the user's own repeated tax_reviewed decisions, so it may make
  //    a document tax-relevant that the LLM marked otherwise.
  const beforeLearnedTax = classification.tax_sections.length;
  classification.tax_sections = mergeLearnedTaxSections(classification.tax_sections, learned);
  if (classification.tax_sections.length > beforeLearnedTax) {
    classification.tax_relevant = true;
  }

  // 7b. Deterministic tax post-rule (see tax-rules.ts): private pension/life/
  //     Riester insurance ADMIN mail (Erhöhungsnachtrag/Statusreport/Dynamik/
  //     Standmitteilung) without an actual §10a/§92 certificate is NOT a tax
  //     document — the small model marks it anyway. Checked against the OCR
  //     text (not the LLM title) so an unreliable "Beitragsbescheinigung" title
  //     can't rescue a Dynamik-Widerspruch.
  {
    const adjusted = applyInsuranceAdminTaxRule({
      text: clipped,
      taxSections: classification.tax_sections,
      taxRelevant: classification.tax_relevant,
    });
    classification.tax_sections = adjusted.taxSections;
    classification.tax_relevant = adjusted.taxRelevant;
  }
  {
    const adjusted = applyKindergeldTaxRule({
      text: clipped,
      taxSections: classification.tax_sections,
      taxRelevant: classification.tax_relevant,
    });
    classification.tax_sections = adjusted.taxSections;
    classification.tax_relevant = adjusted.taxRelevant;
    if (adjusted.matched && classification.tax_year == null) {
      const year = /^(\d{4})-/.exec(classification.doc_date ?? "")?.[1];
      if (year) {
        classification.tax_year = Number(year);
        classification.tax_year_confidence = 0.9;
      }
    }
  }
  // 7b-2. Bank-/Broker-Abrechnung über Kapitalerträge: die ausgewiesene
  //       Kirchensteuer (und die comdirect-Fußnote „… als Sonderausgabe …")
  //       verleitet das Modell dazu, zusätzlich `sonderausgaben` und
  //       `vorsorgeaufwand` zu vergeben. Solche Belege gehören ausschließlich
  //       in die KAP-Sektionen.
  {
    const adjusted = applySecuritiesSettlementTaxRule({
      text: clipped,
      taxSections: classification.tax_sections,
      taxRelevant: classification.tax_relevant,
    });
    if (adjusted.matched) {
      console.log(
        `[documents] securities settlement tax rule(${documentId}): ` +
          `${classification.tax_sections.map((s) => s.slug).join(",") || "-"} → ` +
          `${adjusted.taxSections.map((s) => s.slug).join(",")}`,
      );
    }
    classification.tax_sections = adjusted.taxSections;
    classification.tax_relevant = adjusted.taxRelevant;
  }
  {
    const adjusted = applyAgricultureFiscalYearTaxRule({
      text: clipped,
      taxSections: classification.tax_sections,
      taxYear: classification.tax_year,
      taxYearConfidence: classification.tax_year_confidence,
    });
    classification.tax_year = adjusted.taxYear;
    classification.tax_year_confidence = adjusted.taxYearConfidence;
  }
  // 7c. Kirchensteuerbescheid: the heading names the Veranlagungsjahr, but the
  //     Sonderausgabe counts in the year of the Nachzahlung/Erstattung
  //     (§ 11 EStG). "Kirchensteuerbescheid 2019" issued 19.04.2021 → 2021.
  {
    const adjusted = applyKirchensteuerBescheidYearTaxRule({
      text: clipped,
      docDate: classification.doc_date ?? null,
      taxYear: classification.tax_year,
      taxYearConfidence: classification.tax_year_confidence,
    });
    if (adjusted.matched && adjusted.taxYear !== classification.tax_year) {
      console.log(
        `[documents] Kirchensteuerbescheid year rule(${documentId}): ` +
          `${classification.tax_year} → ${adjusted.taxYear}`,
      );
    }
    classification.tax_year = adjusted.taxYear;
    classification.tax_year_confidence = adjusted.taxYearConfidence;
  }

  // Personal deductions (Sonderausgaben, §35a haushaltsnahe, private
  // health/care costs, ...) usually require the user's own economic burden.
  // A document that concerns a Bezugsperson (e.g. "mutter") can still be a
  // valid tax document when the user paid it, so do not clear the tax
  // sections. Instead, remember the soft signal and apply the confidence
  // lowering after all later confidence bumps (e.g. learned category) ran.
  // Only subject persons explicitly opted in (requires_tax_review, #0137) can
  // trigger the review — most Bezugspersonen (spouse, own children) are
  // dependents the user obviously pays for.
  const reviewOptedInPersonIds = new Set(
    subjectPersons.filter((p) => p.requires_tax_review).map((p) => p.id),
  );
  const subjectPersonDeductionReview = detectSubjectPersonPersonalDeductionReview({
    detectedSubjectPersonIds: subjectPersonIds.filter((id) => reviewOptedInPersonIds.has(id)),
    taxSections: classification.tax_sections,
  });
  const forceTaxReviewConfidence =
    !row.tax_reviewed && subjectPersonDeductionReview.shouldReview;

  // Deterministic sender → category routing (see sender-rules.ts). A known
  // recurring institution overrides the LLM's category guess, which otherwise
  // funnels most documents into the generic "finanzen-rechnungen" bucket.
  // Deterministic CONTENT routing (see content-rules in sender-rules.ts): a
  // document-type keyword (Riester/§92, Kfz-Kasko, Wohngebäude) the small model
  // and the sender-keyed rules can't disambiguate. Highest precedence because
  // it resolves same-sender ambiguity — e.g. Heidelberger issues both a
  // Kapital-Lebensversicherung AND a Riester Rentenversicherung, and the sender
  // rule would force the former.
  const contentSlug = matchContentRule({
    title: classification.title,
    text: clipped,
  });
  const senderRuleOverrides = await loadSenderRuleOverrides();
  const ruleSlug = matchSenderRule(
    {
      sender: classification.sender,
      title: classification.title,
      text: clipped,
    },
    senderRuleOverrides,
  );
  // Learned per-user category fills the long tail the hand-authored rules don't
  // cover: only applied when neither a content nor a sender rule matched, so
  // the rules keep their context-aware precision. See learned-rules.ts.
  const learnedCatSlug =
    !contentSlug && !ruleSlug && learned?.category ? learned.category.slug : null;
  if (contentSlug && contentSlug !== classification.category_slug) {
    console.log(
      `[documents] content rule override(${documentId}): ` +
        `${classification.category_slug} → ${contentSlug}`,
    );
  } else if (!contentSlug && ruleSlug && ruleSlug !== classification.category_slug) {
    console.log(
      `[documents] sender rule override(${documentId}): ` +
        `"${classification.sender}" ${classification.category_slug} → ${ruleSlug}`,
    );
  } else if (
    !contentSlug &&
    !ruleSlug &&
    learnedCatSlug &&
    learnedCatSlug !== classification.category_slug
  ) {
    console.log(
      `[documents] learned category override(${documentId}): ` +
        `"${classification.sender}" ${classification.category_slug} → ${learnedCatSlug} ` +
        `(support=${learned!.category!.support}, share=${learned!.category!.share.toFixed(2)})`,
    );
  }
  const catSlug = contentSlug ?? ruleSlug ?? learnedCatSlug ?? classification.category_slug;
  // A repeated manual filing decision for this sender is the strongest possible
  // signal — treat the result as confident so it neither gets flagged for
  // low-confidence review nor lands in the work-item basket.
  const learnedCategoryApplied = learnedCatSlug != null && catSlug === learnedCatSlug;
  if (learnedCategoryApplied) {
    classification.confidence = Math.max(classification.confidence, 0.9);
  }
  if (forceTaxReviewConfidence) {
    // Do NOT lower classification_confidence here: the category was classified
    // confidently and must not be dragged into the low-confidence work-item
    // basket. The soft "did you actually pay this deductible expense?" signal is
    // carried by the dedicated `tax_review_needed` column (set in the patch
    // below) and surfaced separately in the tax area.
    console.log(
      `[documents] subject-person tax review(${documentId}): ` +
        `${subjectPersonDeductionReview.reviewSlugs.join(", ")}`,
    );
  }
  const cat = await dbFirst<{ id: number }>(
    db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, catSlug)),
  );

  const patch: Partial<typeof documents.$inferInsert> = {
    status: "ready",
  };
  // Only overwrite the human-editable attributes when neither a human nor the
  // Cloud Teacher has asserted them. `attributes_reviewed=true` means a human
  // pinned them; `category_source IN ('cloud','user')` means a trusted source
  // labelled the category and the local classifier must not undo it.
  const categoryProtected =
    row.attributes_reviewed || row.category_source === "cloud" || row.category_source === "user";
  if (!categoryProtected) {
    patch.category_id = cat?.id ?? null;
    patch.title = classification.title || row.title || row.original_filename;
    patch.doc_date = classification.doc_date;
    patch.sender = classification.sender;
    patch.document_number = classification.document_number;
    patch.summary = classification.summary;
    patch.classification_confidence = classification.confidence;
    // Document-type facet follows the same human/cloud-override protection as
    // the other editable attributes. Keep NULL when the classifier returned no
    // valid type rather than forcing a fallback.
    patch.document_type = classification.document_type;
    patch.document_type_confidence = classification.document_type_confidence;
  }
  // Only overwrite tax fields when neither a human nor the Cloud Teacher has
  // pinned them. `tax_reviewed=true` = human asserted; `category_source` in
  // ('cloud','user') = trusted source also wrote the tax metadata.
  const taxProtected = row.tax_reviewed || row.category_source === "cloud" || row.category_source === "user";
  if (!taxProtected) {
    patch.tax_relevant = classification.tax_relevant;
    patch.tax_year = classification.tax_year;
    patch.tax_year_confidence = classification.tax_year_confidence;
    // Carry the subject-person deduction review as its own flag (see above).
    // Follows the same protection rule as the other tax fields so a re-classify
    // clears a stale flag but a trusted source's tax data is never second-guessed.
    patch.tax_review_needed = forceTaxReviewConfidence;
  }

  await db.update(documents).set(patch).where(eq(documents.id, documentId));
  // A document that even after learned + hand rules lands in the catch-all
  // "sonstiges" is evidence the taxonomy may be missing a category for its
  // sender — feed the admin's category-suggestions queue. Best-effort.
  if (!categoryProtected && catSlug === "sonstiges") {
    void recordUncategorizedDocument({ documentId, sender: classification.sender }).catch(
      (err) =>
        console.error(`[documents] category suggestion for document=${documentId} failed:`, err),
    );
  }
  // Advisory only: a document becoming OCR-ready must not delay the pipeline.
  void createSuggestionsForDocument(documentId).catch(err => console.error(`[documents] finance matching failed for document=${documentId}:`, err));
  void checkReceiptEnrichment(documentId).catch(err => console.error(`[documents] receipt enrichment check failed for document=${documentId}:`, err));

  // Report the category the document actually carries now: the fresh guess
  // when applied, or the pinned existing one when the category is protected.
  let effectiveCatSlug: string | null = catSlug;
  if (categoryProtected) {
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

  if (!taxProtected) {
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

  // A protected document's attributes weren't touched, so there is nothing to
  // flag for review even if the (ignored) guess was low-confidence.
  const lowConfidence =
    !categoryProtected && classification.confidence < LOW_CONFIDENCE_THRESHOLD;
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
  if (text.length === 0) {
    if (isWaitingForTextExtraction(row.status)) {
      return { deferred: true };
    }
    return { chunks: 0 };
  }

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
 * 3. For existing-transaction captures: link/enrich the transaction and stop.
 * 4. If the amount is reliable (>0 and <=999): auto-create a cash transaction.
 * 5. If not reliable: mark the document as `incomplete`.
 *
 * Throws `ReceiptOcrUnavailableError` when the service is down so the
 * worker defers the job (retry with exponential back-off, no permanent failure).
 */
export async function runReceiptOcr(documentId: number): Promise<void> {
  const row = await getDocumentOrThrow(documentId);

  // Guard: only process documents that are waiting for receipt OCR.
  if (row.receipt_ocr_state !== "pending") return;
  const existingTransactionId = row.receipt_transaction_id ?? null;
  if (!row.receipt_account_id && !existingTransactionId) {
    // No account chosen — mark incomplete so UI can notify the user.
    await db.update(documents)
      .set({ receipt_ocr_state: "incomplete" })
      .where(eq(documents.id, documentId));
    return;
  }

  // Thumbnail generation is independent from OCR. Receipt captures do not
  // enter text_extract (and therefore never invoke Tesseract), so warm the
  // page preview here before contacting the potentially cold Paddle service.
  await ensureThumbnail(documentId, row.disk_path).catch(() => null);

  // Health check — defer the job if the service is cold/restarting.
  const healthy = await isReceiptOcrHealthy().catch(() => false);
  if (!healthy) {
    throw new ReceiptOcrUnavailableError("receipt-ocr-service health check failed");
  }

  // Re-read disk_path to guard against concurrent relocateDocument.
  const currentPath = await freshDiskPath(documentId);
  const buffer = await fs.readFile(currentPath);

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
  const core = await extractReceipt(
    ocrBuffer,
    ocrFilename,
    ocrMimeType,
    row.uploaded_at,
  );

  // Replace the stored PDF with the service's display preparation: crop,
  // perspective correction, orientation and fine deskew. OCR-only denoising
  // and contrast enhancement stay in Paddle's private working copy.
  // Best-effort: failures here must never block booking.
  if (core.corrected_image && row.mime_type === "application/pdf") {
    try {
      await replaceStoredReceiptImage(row, core.corrected_image);
    } catch (err) {
      console.warn(
        `[documents] replacing corrected receipt image failed for doc=${documentId}: ${(err as Error).message}`,
      );
    }
  }

  // Stage 2: line-item extraction — best-effort, failures don't block booking.
  let items: Array<{ name: string; amount: number }> = [];
  if (core.raw_text) {
    try {
      const itemsResult = await extractReceiptItems(core.raw_text, core.layout_rows);
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
      items,
      ocr_confidence: core.ocr_confidence,
      amount_confidence: core.amount_confidence,
      amount_source: core.amount_source,
    })
    .onConflictDoUpdate({
      target: documentReceiptExtraction.document_id,
      set: {
        amount: core.amount != null ? String(core.amount) : null,
        items,
        ocr_confidence: core.ocr_confidence,
        amount_confidence: core.amount_confidence,
        amount_source: core.amount_source,
      },
  });

  if (existingTransactionId != null) {
    await finalizeReceiptDocument(
      documentId,
      row.user_id,
      core.raw_text,
      { store: core.store, receiptDate: core.date },
    );
    await attachReceiptToExistingTransaction({
      documentId,
      transactionId: existingTransactionId,
      notice: formatReceiptLineItemsNotice(items, core.currency ?? "EUR"),
    });
    try {
      await enqueueTagSuggestion(existingTransactionId, row.user_id, 1);
      triggerTagWorker();
    } catch (err) {
      console.warn(
        `[documents] enqueue tag suggestion for receipt tx=${existingTransactionId} failed: ${(err as Error).message}`,
      );
    }
    console.log(
      `[documents] receipt OCR doc=${documentId}: linked existing tx=${existingTransactionId}`,
    );
    void realtime.publishEvent({
      userIds: [String(row.user_id)],
      channel: "finance",
      type: "receipt.linked",
      resourceId: String(existingTransactionId),
      payload: { transaction_id: existingTransactionId, document_id: documentId },
    }).catch((err: unknown) => console.warn(`[documents] receipt.linked realtime failed doc=${documentId}: ${(err as Error).message}`));
    return;
  }

  const receiptAccountId = row.receipt_account_id;
  if (receiptAccountId == null) {
    await db.update(documents)
      .set({ receipt_ocr_state: "incomplete" })
      .where(eq(documents.id, documentId));
    return;
  }

  // Determine if the amount is reliable enough for auto-booking.
  const reliable = isReliableReceiptAmount(core.amount, core.amount_confidence);

  if (!reliable) {
    await finalizeReceiptDocument(
      documentId,
      row.user_id,
      core.raw_text,
      { store: core.store, receiptDate: core.date },
      "incomplete",
    );
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
    }).catch((err: unknown) => console.warn(`[documents] receipt.incomplete realtime failed doc=${documentId}: ${(err as Error).message}`));
    void push.notifyReceiptIncomplete({ userId: row.user_id, documentId })
      .catch((err: unknown) => console.warn(`[documents] notifyReceiptIncomplete failed doc=${documentId}: ${(err as Error).message}`));
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
    accountId: receiptAccountId,
    amount: -(core.amount!), // expenses are negative
    bookingDate,
    counterparty: core.store,
    purpose,
    notice: formatReceiptLineItemsNotice(items, core.currency ?? "EUR"),
    currencyCode: core.currency ?? "EUR",
  });

  // createReceiptAutoTransaction sets `booked` when it creates a row. A null
  // result means an idempotent/deduplicated booking; keep the document
  // reviewable instead of leaving receipt_ocr_state stuck on `pending`.
  await finalizeReceiptDocument(
    documentId,
    row.user_id,
    core.raw_text,
    { store: core.store, receiptDate: core.date },
    txId === null ? "incomplete" : undefined,
  );

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
    }).catch((err: unknown) => console.warn(`[documents] receipt.booked realtime failed doc=${documentId}: ${(err as Error).message}`));
    void push.notifyReceiptBooked({
      userId: row.user_id,
      transactionId: txId,
      documentId,
      amount: core.amount!,
      store: core.store,
    }).catch((err: unknown) => console.warn(`[documents] notifyReceiptBooked failed doc=${documentId}: ${(err as Error).message}`));
  }
}

/**
 * Complete the document-facing side of receipt processing using PaddleOCR's
 * text. This replaces the old text_extract/Tesseract job and only relocates
 * after all upload-time metadata and OCR output have been persisted.
 */
async function finalizeReceiptDocument(
  documentId: number,
  ownerUserId: number,
  rawText: string,
  metadata: { store: string | null; receiptDate: string | null },
  receiptState?: "incomplete",
): Promise<void> {
  const current = await getDocumentOrThrow(documentId);
  await db.update(documents)
    .set(buildReceiptDocumentCompletion(
      rawText,
      receiptState,
      current.attributes_reviewed ? undefined : metadata,
    ))
    .where(eq(documents.id, documentId));
  await publishStatusChanged(documentId, ownerUserId, "ready");

  // status=ready + the server-assigned `belege` category now produce the
  // final canonical path. No worker retains the upload path at this point.
  try {
    await relocateDocument(documentId);
  } catch (err) {
    console.warn(
      `[documents] relocate after receipt OCR(${documentId}) failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Replace a receipt document's stored PDF with the service-corrected image.
 *
 * The receipt-ocr service returns a cropped, perspective-corrected, upright
 * and deskewed JPEG (base64) retaining the source colour pixels. We wrap it
 * back into the same single-page PDF the upload path produces, overwrite the
 * file in place, and refresh derived artifacts so the viewer shows the sharp
 * prepared scan rather than Paddle's denoised OCR working copy.
 *
 * No-ops silently when the corrected image collides with another document's
 * content (the unique sha256 constraint) — the original file is kept.
 */
async function replaceStoredReceiptImage(
  row: typeof documents.$inferSelect,
  correctedImageB64: string,
): Promise<void> {
  const jpeg = Buffer.from(correctedImageB64, "base64");
  if (jpeg.length === 0) return;

  const pdf = await jpegToReceiptPdf(jpeg);
  const digest = crypto.createHash("sha256").update(pdf).digest("hex");

  // Keep the original if the corrected content already exists as another doc —
  // the unique sha256 constraint would otherwise reject the update.
  const duplicate = await dbFirst<{ id: number }>(
    db.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.sha256, digest), ne(documents.id, row.id))),
  );
  if (duplicate) return;

  // Serialize against any concurrent relocate/replace and re-read the
  // path fresh inside the lock: the `row` snapshot may be stale if a
  // relocate moved the file since this job started.
  const writtenPath = await withDocumentLock(row.id, async () => {
    const diskPath = await freshDiskPath(row.id);
    await fs.writeFile(diskPath, pdf);
    await db.update(documents)
      .set({ sha256: digest, size_bytes: pdf.length })
      .where(eq(documents.id, row.id));
    return diskPath;
  });

  await removeOcrPdf(row.id);
  await removeThumbnail(row.id);

  // Rebuild the thumbnail eagerly from the new file (best-effort).
  await buildThumbnail(row.id, writtenPath).catch(() => {});
}

/**
 * Extract the embedded JPEG from a hand-crafted receipt PDF (as built by
 * `singleJpegPagePdf` in receipt-pdf.ts). The receipt-ocr service expects an
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
