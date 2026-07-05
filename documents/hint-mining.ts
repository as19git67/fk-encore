/**
 * Weekly mining job: analyse reviewed documents and generate hint
 * improvement suggestions for tax-sections and categories.
 *
 * Data source: only reviewed documents (attributes_reviewed / tax_reviewed).
 * Output: rows in `document_hint_suggestions` (one open row per target),
 *         plus category-gap suggestions in `document_category_suggestions`.
 *
 * Pure aggregation — no LLM, no embedding, no network calls.
 */

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  documentCategories,
  documentCategorySuggestions,
  documentHintSuggestions,
  documentTaxSections,
  documents,
} from "../db/schema";
import { normalizeForMatch } from "./sender-rules";
import { TAX_SECTIONS, isValidTaxSectionSlug } from "./tax-sections";
import log from "encore.dev/log";

// ─── Thresholds ──────────────────────────────────────────────────────────────

const MIN_REVIEWED_DOCS = 30;
const MAX_EXAMPLES = 20;
const MINING_MARKER = "auto-mining:";
const MAX_KEYWORDS_PER_SECTION = 8;
const MAX_SENDERS_PER_SECTION = 10;

// ─── Row shapes ──────────────────────────────────────────────────────────────

interface ReviewedDocRow {
  id: number;
  sender: string | null;
  title: string | null;
  extracted_text: string | null;
  category_slug: string | null;
}

interface DocTaxRow {
  document_id: number;
  tax_section: string;
  sender: string | null;
}

interface ConfusionRow {
  id: number;
  sender: string | null;
  ai_category_slug: string | null;
  reviewed_category_slug: string | null;
}

// ─── TF-IDF keyword extraction ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem",
  "einer", "und", "oder", "aber", "mit", "von", "zu", "in", "auf", "an",
  "für", "bei", "nach", "aus", "als", "wie", "ist", "sind", "war", "hat",
  "haben", "wird", "werden", "kann", "ihr", "sie", "ich", "wir", "nicht",
  "auch", "nur", "noch", "zum", "zur", "über", "unter", "sich", "dass",
  "bis", "durch", "per", "vom", "beim", "seit", "ohne", "vor", "alle",
  "alle", "diese", "dieser", "dieses", "kein", "keine", "mehr", "sehr",
  "schon", "wenn", "dann", "denn", "hier", "dort", "bitte", "mfg",
  "freundlichen", "grüßen", "geehrte", "damen", "herren", "betreff",
  "eur", "euro", "datum",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zäöüß0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !STOP_WORDS.has(t));
}

export interface TfIdfEntry {
  term: string;
  tfidf: number;
}

/**
 * Compute the top-N keywords for a corpus of texts (one per document) using
 * TF-IDF. `corpusTexts` is the set of texts belonging to one section/category;
 * `allTexts` is every reviewed document's text (for IDF).
 */
export function topKeywords(
  corpusTexts: string[],
  allTexts: string[],
  maxN: number,
): TfIdfEntry[] {
  if (corpusTexts.length === 0 || allTexts.length === 0) return [];

  const df = new Map<string, number>();
  for (const text of allTexts) {
    const seen = new Set(tokenize(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = allTexts.length;

  const tf = new Map<string, number>();
  let totalTokens = 0;
  for (const text of corpusTexts) {
    for (const t of tokenize(text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      totalTokens++;
    }
  }
  if (totalTokens === 0) return [];

  const entries: TfIdfEntry[] = [];
  for (const [term, count] of tf) {
    const termDf = df.get(term) ?? 1;
    const idf = Math.log(N / termDf);
    entries.push({ term, tfidf: (count / totalTokens) * idf });
  }

  entries.sort((a, b) => b.tfidf - a.tfidf);
  return entries.slice(0, maxN);
}

// ─── Confusion pairs ─────────────────────────────────────────────────────────

export interface ConfusionPair {
  ai_slug: string;
  reviewed_slug: string;
  count: number;
  example_ids: number[];
}

/**
 * Find (AI category ≠ reviewed category) patterns from documents that have
 * been both AI-classified and human-reviewed.
 */
export function buildConfusionPairs(rows: readonly ConfusionRow[]): ConfusionPair[] {
  const map = new Map<string, { count: number; ids: number[] }>();
  for (const r of rows) {
    const ai = r.ai_category_slug?.trim().toLowerCase();
    const rev = r.reviewed_category_slug?.trim().toLowerCase();
    if (!ai || !rev || ai === rev) continue;
    const key = `${ai}→${rev}`;
    const entry = map.get(key) ?? { count: 0, ids: [] };
    entry.count++;
    if (entry.ids.length < MAX_EXAMPLES) entry.ids.push(r.id);
    map.set(key, entry);
  }
  return [...map.entries()]
    .filter(([, v]) => v.count >= 2)
    .map(([key, v]) => {
      const [ai_slug, reviewed_slug] = key.split("→");
      return { ai_slug, reviewed_slug, count: v.count, example_ids: v.ids };
    })
    .sort((a, b) => b.count - a.count);
}

// ─── Sender aggregation per section ──────────────────────────────────────────

export interface SenderFrequency {
  sender: string;
  count: number;
}

export function topSenders(
  rows: readonly { sender: string | null }[],
  maxN: number,
): SenderFrequency[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = r.sender?.trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxN);
}

// ─── Draft hint builder ──────────────────────────────────────────────────────

export function buildDraftHint(params: {
  sectionName: string;
  senders: SenderFrequency[];
  keywords: TfIdfEntry[];
}): string {
  const parts: string[] = [];
  if (params.senders.length > 0) {
    parts.push(
      `Typische Absender: ${params.senders.map((s) => s.sender).join(", ")}.`,
    );
  }
  if (params.keywords.length > 0) {
    parts.push(
      `Schlüsselwörter: ${params.keywords.map((k) => k.term).join(", ")}.`,
    );
  }
  if (parts.length === 0) return "";
  return parts.join(" ");
}

// ─── Main mining logic ───────────────────────────────────────────────────────

export interface MiningResult {
  reviewed_doc_count: number;
  tax_section_hints: number;
  category_gap_suggestions: number;
  confusion_pairs_found: number;
  skipped_insufficient_data: boolean;
}

export async function runHintMining(): Promise<MiningResult> {
  const result: MiningResult = {
    reviewed_doc_count: 0,
    tax_section_hints: 0,
    category_gap_suggestions: 0,
    confusion_pairs_found: 0,
    skipped_insufficient_data: false,
  };

  // 1. Count reviewed docs — bail if insufficient
  const countRow = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.status, "ready"),
        eq(documents.attributes_reviewed, true),
      ),
    );
  const reviewedCount = countRow[0]?.cnt ?? 0;
  result.reviewed_doc_count = reviewedCount;

  if (reviewedCount < MIN_REVIEWED_DOCS) {
    log.info("hint-mining: skipped — insufficient reviewed docs", {
      reviewed: reviewedCount,
      min: MIN_REVIEWED_DOCS,
    });
    result.skipped_insufficient_data = true;
    return result;
  }

  // 2. Load reviewed documents with their categories
  const reviewedDocs = await dbAll<ReviewedDocRow>(
    db
      .select({
        id: documents.id,
        sender: documents.sender,
        title: documents.title,
        extracted_text: documents.extracted_text,
        category_slug: documentCategories.slug,
      })
      .from(documents)
      .leftJoin(documentCategories, eq(documentCategories.id, documents.category_id))
      .where(
        and(
          eq(documents.status, "ready"),
          eq(documents.attributes_reviewed, true),
        ),
      ),
  );

  // 3. Load tax-reviewed docs with their sections
  const taxDocs = await dbAll<DocTaxRow>(
    db
      .select({
        document_id: documentTaxSections.document_id,
        tax_section: documentTaxSections.tax_section,
        sender: documents.sender,
      })
      .from(documentTaxSections)
      .innerJoin(documents, eq(documents.id, documentTaxSections.document_id))
      .where(
        and(
          eq(documents.status, "ready"),
          eq(documents.tax_reviewed, true),
        ),
      ),
  );

  // Build text corpus for IDF
  const allTexts = reviewedDocs
    .map((d) => [d.title ?? "", d.extracted_text ?? ""].join(" ").trim())
    .filter((t) => t.length > 0);

  // ── Tax-section hint suggestions ──────────────────────────────────────

  const docsBySection = new Map<string, DocTaxRow[]>();
  for (const row of taxDocs) {
    const slug = row.tax_section?.trim().toLowerCase();
    if (!slug || !isValidTaxSectionSlug(slug)) continue;
    const list = docsBySection.get(slug) ?? [];
    list.push(row);
    docsBySection.set(slug, list);
  }

  // We also need document texts per section for TF-IDF
  const reviewedById = new Map(reviewedDocs.map((d) => [d.id, d]));

  for (const [slug, sectionDocs] of docsBySection) {
    if (sectionDocs.length < 3) continue;

    const senders = topSenders(sectionDocs, MAX_SENDERS_PER_SECTION);
    const corpusTexts = sectionDocs
      .map((d) => {
        const doc = reviewedById.get(d.document_id);
        return doc
          ? [doc.title ?? "", doc.extracted_text ?? ""].join(" ").trim()
          : "";
      })
      .filter((t) => t.length > 0);
    const keywords = topKeywords(corpusTexts, allTexts, MAX_KEYWORDS_PER_SECTION);

    const section = TAX_SECTIONS.find((s) => s.slug === slug);
    const draft = buildDraftHint({
      sectionName: section?.name ?? slug,
      senders,
      keywords,
    });
    if (!draft) continue;

    const exampleIds = sectionDocs.slice(0, MAX_EXAMPLES).map((d) => d.document_id);
    await upsertHintSuggestion({
      kind: "tax-section",
      targetSlug: slug,
      draftHint: draft,
      rationale: `Aus ${sectionDocs.length} steuerlich geprüften Dokumenten abgeleitet.`,
      exampleIds,
    });
    result.tax_section_hints++;
  }

  // ── Category-gap suggestions (sonstiges senders) ──────────────────────

  const sonstigesDocs = reviewedDocs.filter(
    (d) => d.category_slug === "sonstiges",
  );
  if (sonstigesDocs.length >= 3) {
    const senderCounts = new Map<string, { count: number; ids: number[] }>();
    for (const d of sonstigesDocs) {
      const key = normalizeForMatch(d.sender);
      if (!key) continue;
      const entry = senderCounts.get(key) ?? { count: 0, ids: [] };
      entry.count++;
      if (entry.ids.length < MAX_EXAMPLES) entry.ids.push(d.id);
      senderCounts.set(key, entry);
    }

    const openSuggestions = await dbAll<{
      id: number;
      rationale: string | null;
      example_document_ids: number[];
    }>(
      db
        .select({
          id: documentCategorySuggestions.id,
          rationale: documentCategorySuggestions.rationale,
          example_document_ids: documentCategorySuggestions.example_document_ids,
        })
        .from(documentCategorySuggestions)
        .where(eq(documentCategorySuggestions.status, "open")),
    );
    const existingMarkers = new Set(
      openSuggestions
        .map((s) => s.rationale ?? "")
        .filter((r) => r.startsWith(MINING_MARKER) || r.startsWith("auto-sender:")),
    );

    for (const [key, { count, ids }] of senderCounts) {
      if (count < 3) continue;
      const marker = `${MINING_MARKER}${key}`;
      const alreadyExists =
        existingMarkers.has(marker) ||
        existingMarkers.has(`auto-sender:${key}`);
      if (alreadyExists) continue;

      const sampleDoc = sonstigesDocs.find(
        (d) => normalizeForMatch(d.sender) === key,
      );
      const senderName = sampleDoc?.sender?.trim() ?? key;

      await db.insert(documentCategorySuggestions).values({
        suggested_name: senderName.slice(0, 120),
        parent_slug: null,
        example_document_ids: ids,
        rationale: `${marker} — ${count} geprüfte Dokumente von „${senderName}" in „Sonstiges"; ggf. eigene Kategorie anlegen.`,
        status: "open",
      });
      result.category_gap_suggestions++;
    }
  }

  // ── Confusion pairs ───────────────────────────────────────────────────

  // We need docs that were AI-classified AND then reviewed to a different
  // category. The `classification_confidence` being set indicates AI ran.
  // `attributes_reviewed = true` means the user confirmed/changed it.
  // We compare current category (reviewed) with what the AI originally
  // picked. Since we don't store the original AI category separately,
  // we approximate: docs with attributes_reviewed=true AND
  // classification_confidence < 0.9 likely had a different AI assignment.
  // For a first pass, we just log the confusion pairs from the current
  // sender-rules: senders whose docs consistently land in one category
  // but the AI picks another.
  //
  // For now, add confusion info to the rationale of tax-section hints.
  // A full confusion matrix is a future enhancement.

  // Group reviewed docs by category for category-level TF-IDF hints
  const docsByCategory = new Map<string, ReviewedDocRow[]>();
  for (const d of reviewedDocs) {
    const slug = d.category_slug?.trim().toLowerCase();
    if (!slug || slug === "sonstiges") continue;
    const list = docsByCategory.get(slug) ?? [];
    list.push(d);
    docsByCategory.set(slug, list);
  }

  for (const [slug, catDocs] of docsByCategory) {
    if (catDocs.length < 5) continue;

    const senders = topSenders(catDocs, MAX_SENDERS_PER_SECTION);
    const corpusTexts = catDocs
      .map((d) => [d.title ?? "", d.extracted_text ?? ""].join(" ").trim())
      .filter((t) => t.length > 0);
    const keywords = topKeywords(corpusTexts, allTexts, MAX_KEYWORDS_PER_SECTION);

    const draft = buildDraftHint({
      sectionName: slug,
      senders,
      keywords,
    });
    if (!draft) continue;

    const exampleIds = catDocs.slice(0, MAX_EXAMPLES).map((d) => d.id);
    await upsertHintSuggestion({
      kind: "category",
      targetSlug: slug,
      draftHint: draft,
      rationale: `Aus ${catDocs.length} geprüften Dokumenten in Kategorie „${slug}" abgeleitet.`,
      exampleIds,
    });
  }

  log.info("hint-mining: completed", {
    reviewed: reviewedCount,
    tax_hints: result.tax_section_hints,
    category_gaps: result.category_gap_suggestions,
  });

  return result;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function upsertHintSuggestion(params: {
  kind: "tax-section" | "category";
  targetSlug: string;
  draftHint: string;
  rationale: string;
  exampleIds: number[];
}): Promise<void> {
  const existing = await dbAll<{ id: number; status: string }>(
    db
      .select({ id: documentHintSuggestions.id, status: documentHintSuggestions.status })
      .from(documentHintSuggestions)
      .where(
        and(
          eq(documentHintSuggestions.kind, params.kind),
          eq(documentHintSuggestions.target_slug, params.targetSlug),
          eq(documentHintSuggestions.status, "open"),
        ),
      ),
  );

  if (existing.length > 0) {
    await db
      .update(documentHintSuggestions)
      .set({
        draft_hint: params.draftHint,
        rationale: params.rationale,
        example_document_ids: params.exampleIds,
        updated_at: new Date().toISOString(),
      })
      .where(eq(documentHintSuggestions.id, existing[0].id));
  } else {
    await db.insert(documentHintSuggestions).values({
      kind: params.kind,
      target_slug: params.targetSlug,
      draft_hint: params.draftHint,
      rationale: params.rationale,
      example_document_ids: params.exampleIds,
      status: "open",
    });
  }
}
