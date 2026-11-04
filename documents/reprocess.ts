import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  documents,
  documentSubjectPersons,
  documentTagLinks,
  documentTaxSections,
} from "../db/schema";
import { requeueDocument } from "./scan-queue";

/**
 * Re-running the pipeline for documents the caller may see, from one dialog
 * ("Neu klassifizieren"): conservative by default, with three opt-ins.
 *
 * - classify only (default): the extracted text stays, classification and
 *   the embedding run again. A document without text has nothing to classify
 *   from, so it starts with text extraction instead.
 * - `ocr`: the text layer is ignored and the whole pipeline runs with OCR.
 * - `resetAttributes`: what a human pinned about the document — the
 *   attribution pin, a hand-set category, hand-set tags and Bezugspersonen —
 *   goes back to the classifier, so the next run may overwrite it.
 * - `resetTax`: the same for the tax assignment (pin and hand-set sections).
 *
 * Labels from the Cloud Teacher and the receipt capture are not "manual" and
 * stay protected. The caller wakes the workers afterwards.
 */
export interface ReprocessOptions {
  ocr?: boolean;
  resetAttributes?: boolean;
  resetTax?: boolean;
}

export interface ReprocessResult {
  /** Documents that start with text extraction (OCR chosen, or no text yet). */
  extractedFirst: number;
}

export async function reprocessDocuments(
  rows: readonly { id: number; has_text: boolean }[],
  opts: ReprocessOptions = {},
): Promise<ReprocessResult> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { extractedFirst: 0 };
  if (opts.resetAttributes) await resetManualAttributes(ids);
  if (opts.resetTax) await resetManualTax(ids);

  if (opts.ocr) {
    await db
      .update(documents)
      .set({ status: "pending", last_error: null, force_ocr: true })
      .where(inArray(documents.id, ids));
    for (const id of ids) await requeueDocument(id);
    return { extractedFirst: ids.length };
  }
  const { extractedFirst } = await requeueClassifyOnly(rows);
  return { extractedFirst };
}

/** The attribution goes back to the classifier: pin, hand-set category, tags, persons. */
export async function resetManualAttributes(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(documents)
    .set({ attributes_reviewed: false })
    .where(inArray(documents.id, [...ids]));
  await db
    .update(documents)
    .set({ category_source: "ai" })
    .where(and(inArray(documents.id, [...ids]), eq(documents.category_source, "user")));
  await db
    .update(documentTagLinks)
    .set({ source: "ai" })
    .where(and(inArray(documentTagLinks.document_id, [...ids]), eq(documentTagLinks.source, "user")));
  await db
    .update(documentSubjectPersons)
    .set({ source: "ai" })
    .where(
      and(inArray(documentSubjectPersons.document_id, [...ids]), eq(documentSubjectPersons.source, "user")),
    );
}

/** The tax assignment goes back to the classifier: pin and hand-set sections. */
export async function resetManualTax(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(documents)
    .set({ tax_reviewed: false })
    .where(inArray(documents.id, [...ids]));
  await db
    .update(documentTaxSections)
    .set({ source: "ai" })
    .where(and(inArray(documentTaxSections.document_id, [...ids]), eq(documentTaxSections.source, "user")));
}

/**
 * Classify only: the extracted text stays, only classification and the
 * embedding run again; a document without text starts with text extraction.
 */
export async function requeueClassifyOnly(
  rows: readonly { id: number; has_text: boolean }[],
): Promise<{ classified: number; extractedFirst: number }> {
  const withText = rows.filter((r) => r.has_text).map((r) => r.id);
  const withoutText = rows.filter((r) => !r.has_text).map((r) => r.id);
  if (withText.length) {
    await db
      .update(documents)
      .set({ status: "classifying", last_error: null })
      .where(inArray(documents.id, withText));
    for (const id of withText) await requeueDocument(id, ["classify", "embed"]);
  }
  if (withoutText.length) {
    await db
      .update(documents)
      .set({ status: "pending", last_error: null })
      .where(inArray(documents.id, withoutText));
    for (const id of withoutText) await requeueDocument(id);
  }
  return { classified: withText.length, extractedFirst: withoutText.length };
}
