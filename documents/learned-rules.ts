/**
 * Correction → classification learning loop.
 *
 * Background: manual corrections (a human editing a document's category, tax
 * sections, tags, or Bezugspersonen) were previously only *protected* from
 * being overwritten on re-classify — they never fed back into the
 * classification of *future* documents. This module closes that loop.
 *
 * The signal is the document `sender`: for a private household the sender is a
 * near-deterministic predictor of the category (see `sender-rules.ts`, which
 * hand-codes the same insight). Instead of hand-coding, we *learn* per-user
 * sender→X mappings from the ground truth the user has already produced:
 *
 *   - category       ← documents with `attributes_reviewed = true`
 *   - tax sections   ← documents with `tax_reviewed = true`
 *   - tax role       ← documents with `tax_reviewed = true`, per sender AND
 *                      document type (the same bank sends the
 *                      Jahressteuerbescheinigung and the Erträgnisaufstellung)
 *   - tags           ← tag links with `source = 'user'`
 *   - Bezugspersonen ← subject-person links with `source = 'user'`
 *
 * At classify time we build an in-memory index keyed by the normalized sender
 * and look up the current document's sender. The lookup feeds three outputs in
 * `runClassify`:
 *   1. a deterministic category override (long tail the hand rules don't cover),
 *   2. extra tax sections / tags / subject persons the user consistently files,
 *   3. (indirectly) fewer low-confidence review pings for known senders.
 *
 * Everything is best-effort and computed from existing tables — no migration.
 * The pure aggregation/merge helpers are unit-tested in learned-rules.test.ts.
 */

import { and, eq, isNotNull, ne } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  documentCategories,
  documentSubjectPersons,
  documentTagLinks,
  documentTags,
  documentTaxSections,
  documents,
} from "../db/schema";
import { normalizeForMatch } from "./sender-rules";
import { isTaxRole, isValidTaxSectionSlug, type TaxRole } from "./tax-sections";
import type { TaxAssignment } from "./llm-client";

// ─── Thresholds ────────────────────────────────────────────────────────────
//
// Deliberately conservative: a learned signal must reflect a *repeated* manual
// decision, not a one-off, before it influences a new document. A single
// correction should not become a rule.

/** Reviewed docs a sender needs before its dominant category is trusted. */
const MIN_CATEGORY_SUPPORT = 3;
/** Share of the sender's reviewed docs the top category must reach. */
const CATEGORY_DOMINANCE = 0.75;
/** Reviewed docs a (sender, tax_section) pair needs before it is applied. */
const MIN_TAX_SUPPORT = 2;
/** Max learned tax sections applied per sender. */
const MAX_TAX_SECTIONS = 3;
/** Docs a (sender, user-tag) pair needs before the tag is applied. */
const MIN_TAG_SUPPORT = 2;
/**
 * Reviewed docs a (sender, document type) pair needs before its tax role is
 * applied — and they must all agree. Two pinned "Bezug" on the bank's
 * Erträgnisaufstellung make the third one a Bezug; one is a one-off
 * (documentation/plans/steuer-belegrolle.md, stage 3).
 */
const MIN_TAX_ROLE_SUPPORT = 2;
/** Share of a sender's user-tagged docs a tag must appear on to be learned. */
const TAG_DOMINANCE = 0.6;
/** Max learned tags applied per sender. */
const MAX_TAGS = 5;
/** Docs a (sender, subject-person) pair needs before the person is applied. */
const MIN_PERSON_SUPPORT = 2;
/** Confidence stamped on a learned tax section (below a strong LLM hit). */
export const LEARNED_TAX_CONFIDENCE = 0.75;

// ─── Row shapes (as returned by the SQL below) ───────────────────────────────

export interface SenderCategoryRow {
  sender: string | null;
  category_slug: string;
}
export interface SenderTaxRow {
  sender: string | null;
  tax_section: string;
}
export interface SenderTaxRoleRow {
  sender: string | null;
  /** Dokumentart facet slug, or null when untyped. */
  document_type: string | null;
  tax_role: string;
}
export interface SenderTagRow {
  sender: string | null;
  tag: string;
  document_id: number;
}
export interface SenderPersonRow {
  sender: string | null;
  subject_person_id: number;
}

// ─── In-memory index ─────────────────────────────────────────────────────────

export interface LearnedCategory {
  slug: string;
  /** Number of reviewed docs from this sender. */
  support: number;
  /** Fraction of those docs in `slug` (0..1). */
  share: number;
}

export interface SenderMemoryEntry {
  category: LearnedCategory | null;
  /** Tax section slugs the user consistently files for this sender. */
  taxSections: string[];
  /**
   * Tax role the user consistently pins for this sender, keyed by document
   * type slug ("" for untyped). Only unanimous decisions with enough support.
   */
  taxRoles: Record<string, TaxRole>;
  /** Content tags the user consistently adds for this sender. */
  tags: string[];
  /** Subject-person ids the user consistently links for this sender. */
  subjectPersonIds: number[];
}

/** Normalized-sender → learned signals. */
export type LearnedMemory = Map<string, SenderMemoryEntry>;

function ensureEntry(memory: LearnedMemory, key: string): SenderMemoryEntry {
  let e = memory.get(key);
  if (!e) {
    e = { category: null, taxSections: [], taxRoles: {}, tags: [], subjectPersonIds: [] };
    memory.set(key, e);
  }
  return e;
}

/**
 * Aggregate the four ground-truth row sets into a per-sender index. Pure so the
 * ranking/threshold logic is unit-tested without a database.
 */
export function buildLearnedMemory(inputs: {
  categories: readonly SenderCategoryRow[];
  taxSections: readonly SenderTaxRow[];
  taxRoles?: readonly SenderTaxRoleRow[];
  tags: readonly SenderTagRow[];
  persons: readonly SenderPersonRow[];
}): LearnedMemory {
  const memory: LearnedMemory = new Map();

  // Tax role: per (sender, document type), the one role every reviewed
  // document carries — once there are enough of them. A split decision
  // teaches nothing.
  const roleCounts = new Map<string, Map<string, Map<TaxRole, number>>>();
  for (const r of inputs.taxRoles ?? []) {
    const key = normalizeForMatch(r.sender);
    const role = r.tax_role?.trim().toLowerCase();
    if (!key || !isTaxRole(role)) continue;
    const typeKey = taxRoleTypeKey(r.document_type);
    const byType = roleCounts.get(key) ?? new Map<string, Map<TaxRole, number>>();
    const counts = byType.get(typeKey) ?? new Map<TaxRole, number>();
    counts.set(role, (counts.get(role) ?? 0) + 1);
    byType.set(typeKey, counts);
    roleCounts.set(key, byType);
  }
  for (const [key, byType] of roleCounts) {
    for (const [typeKey, counts] of byType) {
      if (counts.size !== 1) continue;
      const [role, n] = [...counts.entries()][0]!;
      if (n < MIN_TAX_ROLE_SUPPORT) continue;
      ensureEntry(memory, key).taxRoles[typeKey] = role;
    }
  }

  // Category: pick the dominant reviewed category per sender.
  const catBySender = new Map<string, Map<string, number>>();
  for (const r of inputs.categories) {
    const key = normalizeForMatch(r.sender);
    const slug = r.category_slug?.trim().toLowerCase();
    if (!key || !slug) continue;
    const counts = catBySender.get(key) ?? new Map<string, number>();
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
    catBySender.set(key, counts);
  }
  for (const [key, counts] of catBySender) {
    let total = 0;
    let topSlug = "";
    let topN = 0;
    for (const [slug, n] of counts) {
      total += n;
      if (n > topN) {
        topN = n;
        topSlug = slug;
      }
    }
    const share = total > 0 ? topN / total : 0;
    if (total >= MIN_CATEGORY_SUPPORT && share >= CATEGORY_DOMINANCE) {
      ensureEntry(memory, key).category = { slug: topSlug, support: total, share };
    }
  }

  // Tax sections: keep sections filed for the sender at least MIN_TAX_SUPPORT
  // times, most-frequent first, capped.
  applyTopCounts(
    inputs.taxSections,
    (r) => r.tax_section?.trim().toLowerCase(),
    MIN_TAX_SUPPORT,
    MAX_TAX_SECTIONS,
    (key, values) => {
      ensureEntry(memory, key).taxSections = values.filter((s) => isValidTaxSectionSlug(s));
    },
  );

  // Tags: recurring user-added tags for the sender, filtered by dominance so
  // type-specific tags (e.g. "wertpapierkauf" on purchase docs) don't bleed
  // onto unrelated document types from the same sender.
  const tagBySender = new Map<string, { docIds: Set<number>; tagDocs: Map<string, Set<number>> }>();
  for (const r of inputs.tags) {
    const key = normalizeForMatch(r.sender);
    const tag = r.tag?.trim().toLowerCase();
    if (!key || !tag || !Number.isInteger(r.document_id)) continue;
    let entry = tagBySender.get(key);
    if (!entry) {
      entry = { docIds: new Set(), tagDocs: new Map() };
      tagBySender.set(key, entry);
    }
    entry.docIds.add(r.document_id);
    const docs = entry.tagDocs.get(tag) ?? new Set<number>();
    docs.add(r.document_id);
    entry.tagDocs.set(tag, docs);
  }
  for (const [key, { docIds, tagDocs }] of tagBySender) {
    const total = docIds.size;
    const tags = [...tagDocs.entries()]
      .filter(([, docs]) => docs.size >= MIN_TAG_SUPPORT && docs.size / total >= TAG_DOMINANCE)
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAGS)
      .map(([tag]) => tag);
    if (tags.length > 0) ensureEntry(memory, key).tags = tags;
  }

  // Subject persons: recurring user-linked Bezugspersonen for the sender.
  const personCounts = new Map<string, Map<number, number>>();
  for (const r of inputs.persons) {
    const key = normalizeForMatch(r.sender);
    if (!key || !Number.isInteger(r.subject_person_id)) continue;
    const counts = personCounts.get(key) ?? new Map<number, number>();
    counts.set(r.subject_person_id, (counts.get(r.subject_person_id) ?? 0) + 1);
    personCounts.set(key, counts);
  }
  for (const [key, counts] of personCounts) {
    const ids = [...counts.entries()]
      .filter(([, n]) => n >= MIN_PERSON_SUPPORT)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([id]) => id);
    if (ids.length > 0) ensureEntry(memory, key).subjectPersonIds = ids;
  }

  return memory;
}

/** Shared helper: count string values per normalized sender, keep the ones at
 *  or above `minSupport`, most-frequent first, capped at `max`. */
function applyTopCounts<T extends { sender: string | null }>(
  rows: readonly T[],
  pick: (row: T) => string | undefined,
  minSupport: number,
  max: number,
  assign: (key: string, values: string[]) => void,
): void {
  const bySender = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = normalizeForMatch(r.sender);
    const value = pick(r);
    if (!key || !value) continue;
    const counts = bySender.get(key) ?? new Map<string, number>();
    counts.set(value, (counts.get(value) ?? 0) + 1);
    bySender.set(key, counts);
  }
  for (const [key, counts] of bySender) {
    const values = [...counts.entries()]
      .filter(([, n]) => n >= minSupport)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, max)
      .map(([value]) => value);
    if (values.length > 0) assign(key, values);
  }
}

/** Memory key for a document type: the slug, or "" when untyped. */
export function taxRoleTypeKey(documentType: string | null | undefined): string {
  return documentType?.trim().toLowerCase() ?? "";
}

/** The tax role the user consistently pins for this sender and document
 *  type, or null when nothing was learned for the pair. */
export function resolveLearnedTaxRole(
  learned: SenderMemoryEntry | null,
  documentType: string | null | undefined,
): TaxRole | null {
  if (!learned) return null;
  return learned.taxRoles[taxRoleTypeKey(documentType)] ?? null;
}

/**
 * Apply a learned role to the classifier's result. The user's decision wins
 * over the model, the matrix and the text rules — with the invariants kept:
 * a `beleg` needs sections (none → the learned role is not applied), a
 * `keine` has none.
 */
export function applyLearnedTaxRole(
  current: { taxRole: TaxRole; taxSections: readonly TaxAssignment[] },
  learnedRole: TaxRole | null,
): { taxRole: TaxRole; taxSections: TaxAssignment[]; matched: boolean } {
  const unchanged = { taxRole: current.taxRole, taxSections: [...current.taxSections], matched: false };
  if (!learnedRole || learnedRole === current.taxRole) return unchanged;
  if (learnedRole === "keine") return { taxRole: "keine", taxSections: [], matched: true };
  if (current.taxSections.length === 0) return unchanged;
  return { taxRole: learnedRole, taxSections: [...current.taxSections], matched: true };
}

/** Look up the learned signals for a document's sender. */
export function resolveLearned(
  memory: LearnedMemory,
  sender: string | null | undefined,
): SenderMemoryEntry | null {
  const key = normalizeForMatch(sender);
  if (!key) return null;
  return memory.get(key) ?? null;
}

// ─── Pure merge helpers (applied in runClassify) ─────────────────────────────

/** Union the classifier's tax sections with the learned ones (valid slugs the
 *  LLM didn't already emit), stamped with a moderate confidence. */
export function mergeLearnedTaxSections(
  current: readonly TaxAssignment[],
  learned: SenderMemoryEntry | null,
): TaxAssignment[] {
  if (!learned || learned.taxSections.length === 0) return [...current];
  const have = new Set(current.map((s) => s.slug));
  const out = [...current];
  for (const slug of learned.taxSections) {
    if (have.has(slug) || !isValidTaxSectionSlug(slug)) continue;
    have.add(slug);
    out.push({ slug, confidence: LEARNED_TAX_CONFIDENCE });
  }
  return out;
}

/** Append learned content tags, de-duplicated case-insensitively. */
export function mergeLearnedTags(
  current: readonly string[],
  learned: SenderMemoryEntry | null,
): string[] {
  if (!learned || learned.tags.length === 0) return [...current];
  const out = [...current];
  const seen = new Set(current.map((t) => t.trim().toLowerCase()));
  for (const tag of learned.tags) {
    const n = tag.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(tag);
  }
  return out;
}

/** Union the deterministically-detected subject persons with the learned ones. */
export function mergeLearnedPersonIds(
  detectedIds: readonly number[],
  learned: SenderMemoryEntry | null,
): number[] {
  if (!learned || learned.subjectPersonIds.length === 0) return [...detectedIds];
  return [...new Set([...detectedIds, ...learned.subjectPersonIds])];
}

/** Relation tags for the learned subject persons, so a person the user
 *  consistently links for this sender gets their tag even when the name is
 *  garbled/absent in the OCR text. */
export function learnedRelationTags(
  learned: SenderMemoryEntry | null,
  subjectPersons: readonly { id: number; relation_tag: string }[],
): string[] {
  if (!learned || learned.subjectPersonIds.length === 0) return [];
  const byId = new Map(subjectPersons.map((p) => [p.id, p.relation_tag]));
  const out: string[] = [];
  for (const id of learned.subjectPersonIds) {
    const rt = byId.get(id)?.trim();
    if (rt) out.push(rt);
  }
  return out;
}

// ─── DB loader ───────────────────────────────────────────────────────────────

/**
 * Build the learned memory for a user from human-reviewed / user-curated
 * documents. Best-effort: any failure yields an empty memory so classification
 * degrades to the plain LLM + hand-rule path. `excludeDocumentId` keeps the
 * document being classified from learning from its own (possibly reviewed)
 * prior state.
 */
export async function loadLearnedMemory(
  userId: number,
  excludeDocumentId: number,
): Promise<LearnedMemory> {
  try {
    const [categories, taxSections, taxRoles, tags, persons] = await Promise.all([
      dbAll<SenderCategoryRow>(
        db
          .select({ sender: documents.sender, category_slug: documentCategories.slug })
          .from(documents)
          .innerJoin(documentCategories, eq(documentCategories.id, documents.category_id))
          .where(
            and(
              eq(documents.user_id, userId),
              eq(documents.attributes_reviewed, true),
              ne(documents.id, excludeDocumentId),
              isNotNull(documents.sender),
            ),
          ),
      ),
      dbAll<SenderTaxRow>(
        db
          .select({ sender: documents.sender, tax_section: documentTaxSections.tax_section })
          .from(documentTaxSections)
          .innerJoin(documents, eq(documents.id, documentTaxSections.document_id))
          .where(
            and(
              eq(documents.user_id, userId),
              eq(documents.tax_reviewed, true),
              ne(documents.id, excludeDocumentId),
              isNotNull(documents.sender),
            ),
          ),
      ),
      dbAll<SenderTaxRoleRow>(
        db
          .select({
            sender: documents.sender,
            document_type: documents.document_type,
            tax_role: documents.tax_role,
          })
          .from(documents)
          .where(
            and(
              eq(documents.user_id, userId),
              eq(documents.tax_reviewed, true),
              ne(documents.id, excludeDocumentId),
              isNotNull(documents.sender),
            ),
          ),
      ),
      dbAll<SenderTagRow>(
        db
          .select({
            sender: documents.sender,
            tag: documentTags.name,
            document_id: documents.id,
          })
          .from(documentTagLinks)
          .innerJoin(documents, eq(documents.id, documentTagLinks.document_id))
          .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
          .where(
            and(
              eq(documents.user_id, userId),
              eq(documentTagLinks.source, "user"),
              ne(documents.id, excludeDocumentId),
              isNotNull(documents.sender),
            ),
          ),
      ),
      dbAll<SenderPersonRow>(
        db
          .select({
            sender: documents.sender,
            subject_person_id: documentSubjectPersons.subject_person_id,
          })
          .from(documentSubjectPersons)
          .innerJoin(documents, eq(documents.id, documentSubjectPersons.document_id))
          .where(
            and(
              eq(documents.user_id, userId),
              eq(documentSubjectPersons.source, "user"),
              ne(documents.id, excludeDocumentId),
              isNotNull(documents.sender),
            ),
          ),
      ),
    ]);
    return buildLearnedMemory({ categories, taxSections, taxRoles, tags, persons });
  } catch (err) {
    console.warn(
      `[documents] loadLearnedMemory(user=${userId}) failed: ${(err as Error).message}`,
    );
    return new Map();
  }
}
