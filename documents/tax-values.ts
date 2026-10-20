/**
 * Reading the values off tax evidence (documentation/plans/
 * steuer-ausfuellhilfe.md, stage 2).
 *
 * Once classify has settled a document as `beleg` for one or more sections,
 * the `tax_values` job reads it in two small steps: which kind of evidence
 * it is, among the kinds that fit its sections and document type, and then
 * exactly that kind's fields, each with the number as printed and the line
 * it stands in. The model only reads; the code decides what is kept:
 *
 * - an amount must stand in the text on its own (`amountAnchored`), else it
 *   is stored as `rejected` with the reason, never silently dropped;
 * - a flag is kept only with a quote the text really contains;
 * - the kind's plausibility rules attach a note to values that cannot all
 *   be right;
 * - the owner comes from the household: the Bezugspersonen linked to the
 *   document (`relation_kind` self / spouse / child), never from the model.
 *
 * A re-read replaces `read` and `rejected` rows and leaves what the user
 * confirmed or corrected.
 *
 * What the user corrected is learned (stage 5): when a document of the same
 * sender and kind is read, the latest corrections of that sender's earlier
 * evidence go into the prompt as examples — the number that was read, the
 * number that is right, the line it stands in. Only the same owner's
 * documents teach, so no household sees another's evidence.
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import db from "../db/database";
import {
  documentSubjectPersons,
  documentTaxReading,
  documentTaxSections,
  documentTaxValue,
  documents,
  userSubjectPersons,
} from "../db/schema";
import { amountAnchored, centsColumnAfter, parseGermanAmountCents } from "./tax-amounts";
import {
  checkEvidenceValues,
  evidenceKindsFor,
  type EvidenceField,
  type EvidenceKind,
} from "./tax-evidence-kinds";
import { findFormField, type FormScope } from "./tax-forms/catalogue";
import type { ValueOwner } from "./tax-form-mapping";
import { jsonPrompt } from "./llm-client";
import { findTextBoxes } from "./page-words-store";
import { enqueueDocumentScan } from "./scan-queue";

/** Queue priority: after uploads and their classification, before backfills. */
export const TAX_VALUES_PRIORITY = 5;

/**
 * How much of the text the model sees. Evidence is short (a
 * Lohnsteuerbescheinigung is one page); the cap keeps a long document from
 * filling the context window.
 */
export const MAX_TEXT_CHARS = 12000;

const SYSTEM =
  "Du liest Werte aus deutschen Steuerbelegen. Du antwortest nur mit JSON. " +
  "Du erfindest nichts: steht ein Wert nicht im Text, ist er null. " +
  "Zahlen gibst du genau so an, wie sie im Text stehen.";

// -----------------------------------------------------------------------
// Prompts and their answers (pure)
// -----------------------------------------------------------------------

export function clipText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…gekürzt]` : text;
}

export function buildKindPrompt(kinds: readonly EvidenceKind[], text: string): string {
  const list = kinds.map((k) => `- "${k.key}": ${k.name}. ${k.recognise}`).join("\n");
  return (
    "Welche Art von Steuerbeleg ist dieses Dokument?\n\n" +
    `Mögliche Arten:\n${list}\n\n` +
    'Antworte als {"kind": "<key>"} mit einem der Keys oben, oder {"kind": null}, ' +
    "wenn keine Art passt.\n\n" +
    `Dokument:\n"""\n${clipText(text)}\n"""`
  );
}

/** The kind the model named, if it is one of the candidates. */
export function parseKindAnswer(raw: unknown, kinds: readonly EvidenceKind[]): EvidenceKind | null {
  const key = raw && typeof raw === "object" ? (raw as Record<string, unknown>).kind : null;
  return typeof key === "string" ? kinds.find((k) => k.key === key.trim()) ?? null : null;
}

function describeField(f: EvidenceField): string {
  const what = f.kind === "flag" ? "ja/nein" : "Betrag";
  return `- "${f.key}" (${what}): ${f.label}${f.hint ? ` — ${f.hint}` : ""}`;
}

/** A value the user corrected on an earlier document of the same sender and kind. */
export interface CorrectionExample {
  field: string;
  /** What was read, as printed. */
  printed: string | null;
  /** What is right, in cents. */
  cents: number;
  quote: string | null;
}

const germanAmount = (cents: number) =>
  (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The corrections as the prompt states them; fields the kind does not have are left out. */
export function describeCorrections(kind: EvidenceKind, examples: readonly CorrectionExample[]): string {
  const lines = examples.flatMap((e) => {
    const f = field(kind, e.field);
    if (!f || f.kind !== "amount") return [];
    const read = e.printed ? `gelesen wurde "${e.printed}", ` : "";
    const where = e.quote ? ` (steht in: "${e.quote}")` : "";
    return [`- "${f.key}" (${f.label}): ${read}richtig ist ${germanAmount(e.cents)}${where}`];
  });
  if (!lines.length) return "";
  return (
    "Bei früheren Belegen desselben Absenders hat der Nutzer diese Werte berichtigt. " +
    "Lies die Felder genauso, wenn das Dokument gleich aufgebaut ist; " +
    "die Beträge dort gelten nicht für dieses Dokument:\n" +
    `${lines.join("\n")}\n\n`
  );
}

export function buildValuesPrompt(kind: EvidenceKind, year: number, text: string, examples: readonly CorrectionExample[] = []): string {
  return (
    `Das Dokument ist: ${kind.name} (Steuerjahr ${year}).\n` +
    "Lies diese Felder:\n" +
    `${kind.fields.map(describeField).join("\n")}\n\n` +
    describeCorrections(kind, examples) +
    "Antworte als " +
    '{"values": [{"field": "<key>", "printed": "<Zahl wie gedruckt>", "quote": "<die Zeile, in der sie steht>"}], ' +
    '"flags": [{"field": "<key>", "value": true|false, "quote": "<die Stelle, die es sagt>"}]}.\n' +
    "Nur Felder, die im Text stehen; ein Feld, das fehlt, lässt du weg. " +
    "Beträge in Euro mit Komma, wie gedruckt (z. B. \"1.234,56\"). " +
    "Stehen Euro und Cent in getrennten Spalten (\"1.234  56\"), gehören beide zum Betrag: \"1.234,56\". " +
    "Steht ein Betrag für mehrere Personen getrennt da, nimm den Gesamtbetrag.\n\n" +
    `Dokument:\n"""\n${clipText(text)}\n"""`
  );
}

export type ReadStatus = "read" | "rejected";

export interface ReadValue {
  field: string;
  /** Cents for amounts, 0/1 for flags. */
  value: number;
  printed: string | null;
  quote: string | null;
  status: ReadStatus;
  note: string | null;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function entries(raw: unknown, key: string): Record<string, unknown>[] {
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === "object") : [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The values of an answer, each checked against the text. Fields the kind
 * does not have, and a second answer for a field already read, are ignored.
 */
export function checkReadValues(kind: EvidenceKind, raw: unknown, text: string): ReadValue[] {
  const out: ReadValue[] = [];
  const seen = new Set<string>();
  const fieldOf = (key: unknown) => (typeof key === "string" ? kind.fields.find((f) => f.key === key.trim()) : undefined);

  for (const e of entries(raw, "values")) {
    const field = fieldOf(e.field);
    if (!field || field.kind !== "amount" || seen.has(field.key)) continue;
    const printed = str(e.printed) ?? (typeof e.printed === "number" ? String(e.printed).replace(".", ",") : null);
    if (printed === null) continue;
    seen.add(field.key);
    const quote = str(e.quote);
    const parsed = parseGermanAmountCents(printed);
    if (parsed === null) {
      out.push({ field: field.key, value: 0, printed, quote, status: "rejected", note: "Zahl nicht lesbar" });
      continue;
    }
    let cents = Math.abs(parsed);
    let note: string | null = null;
    // Euro read, Cent column left behind: "48.200 78" read as "48.200".
    const column = printed.includes(",") ? null : centsColumnAfter(text, cents);
    if (column) {
      cents += column;
      note = "Cent aus der Cent-Spalte ergänzt";
    }
    const anchored = amountAnchored(text, cents);
    out.push({
      field: field.key,
      value: cents,
      printed,
      quote,
      status: anchored ? "read" : "rejected",
      note: anchored ? note : "Zahl steht nicht im Text",
    });
  }

  const haystack = squash(text);
  for (const e of entries(raw, "flags")) {
    const field = fieldOf(e.field);
    if (!field || field.kind !== "flag" || seen.has(field.key) || typeof e.value !== "boolean") continue;
    seen.add(field.key);
    const quote = str(e.quote);
    const anchored = quote !== null && haystack.includes(squash(quote));
    out.push({
      field: field.key,
      value: e.value ? 1 : 0,
      printed: null,
      quote,
      status: anchored ? "read" : "rejected",
      note: anchored ? null : "Zitat steht nicht im Text",
    });
  }

  // Pairs that cannot both be right: the values stay, with what to check.
  const kept = Object.fromEntries(out.filter((v) => v.status === "read").map((v) => [v.field, v.value]));
  const reasons = checkEvidenceValues(kind, kept);
  if (reasons.length) {
    const note = `Prüfen: ${reasons.join("; ")}`;
    for (const v of out) if (v.status === "read" && field(kind, v.field)?.kind === "amount") v.note = v.note ? `${v.note}; ${note}` : note;
  }
  return out;
}

const field = (kind: EvidenceKind, key: string) => kind.fields.find((f) => f.key === key);

// -----------------------------------------------------------------------
// Whose value it is (pure)
// -----------------------------------------------------------------------

export interface LinkedPerson {
  id: number;
  relationKind: string;
}

/**
 * The owner of a value, from the form field's scope and the Bezugspersonen
 * linked to the document. A person-scope value of both spouses is `joint`
 * (a shared account); the mapping splits it under joint assessment. A child
 * is named only when exactly one is linked.
 */
export function ownerFor(scope: FormScope | undefined, persons: readonly LinkedPerson[]): ValueOwner {
  const children = persons.filter((p) => p.relationKind === "child");
  if (scope === "child" && children.length === 1) return `child:${children[0]!.id}`;
  if (scope === "return") return "joint";
  const self = persons.some((p) => p.relationKind === "self");
  const spouse = persons.some((p) => p.relationKind === "spouse");
  if (self && spouse) return "joint";
  if (spouse) return "spouse";
  if (self) return "self";
  // Whose it is depends on the assessment: alone it is the user's, jointly
  // it could be either spouse's (tax-form-mapping.ts).
  return "none";
}

/**
 * The owner as the household stands now. Without an "Ich selbst" among the
 * Bezugspersonen no document can name the user, so one that names neither
 * spouse is the user's; with one, it could be either spouse's and stays
 * `none` for the user to assign.
 */
export function householdOwner(
  scope: FormScope | undefined,
  persons: readonly LinkedPerson[],
  householdHasSelf: boolean,
): ValueOwner {
  const owner = ownerFor(scope, persons);
  return owner === "none" && !householdHasSelf ? "self" : owner;
}

// -----------------------------------------------------------------------
// The job
// -----------------------------------------------------------------------

interface EvidenceDocument {
  id: number;
  userId: number;
  correspondent: string | null;
  taxRole: string;
  taxYear: number | null;
  documentType: string | null;
  text: string;
  sections: string[];
}

async function loadEvidenceDocument(documentId: number): Promise<EvidenceDocument | null> {
  const [row] = await db
    .select({
      id: documents.id,
      userId: documents.user_id,
      correspondent: documents.correspondent_slug,
      taxRole: documents.tax_role,
      taxYear: documents.tax_year,
      documentType: documents.document_type,
      text: documents.extracted_text,
    })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!row) return null;
  const sections = await db
    .select({ slug: documentTaxSections.tax_section })
    .from(documentTaxSections)
    .where(eq(documentTaxSections.document_id, documentId));
  return { ...row, text: row.text ?? "", sections: sections.map((s) => s.slug) };
}

/** The kinds a document could be read as; empty when it is no evidence to read. */
export function candidateKinds(doc: Pick<EvidenceDocument, "taxRole" | "taxYear" | "documentType" | "text" | "sections">): EvidenceKind[] {
  if (doc.taxRole !== "beleg" || doc.taxYear === null || !doc.text.trim()) return [];
  return evidenceKindsFor(doc.sections, doc.documentType);
}

async function linkedPersons(documentId: number): Promise<LinkedPerson[]> {
  return db
    .select({ id: userSubjectPersons.id, relationKind: userSubjectPersons.relation_kind })
    .from(documentSubjectPersons)
    .innerJoin(userSubjectPersons, eq(userSubjectPersons.id, documentSubjectPersons.subject_person_id))
    .where(eq(documentSubjectPersons.document_id, documentId));
}

/** The first page an amount stands on, when the word positions are kept. */
async function pageOf(documentId: number, printed: string | null): Promise<number | null> {
  if (!printed) return null;
  const found = await findTextBoxes(documentId, printed).catch(() => null);
  return found?.boxes.length ? Math.min(...found.boxes.map((b) => b.page)) : null;
}

/** At most this many corrections go into one prompt, the latest first. */
export const MAX_CORRECTION_EXAMPLES = 6;

/**
 * The latest correction per field on the owner's other evidence of the same
 * sender and kind. Without a known sender nothing is learned: another
 * issuer prints its certificate differently.
 */
export async function correctionExamples(doc: Pick<EvidenceDocument, "id" | "userId" | "correspondent">, kind: string): Promise<CorrectionExample[]> {
  if (!doc.correspondent) return [];
  const rows = await db
    .select({
      field: documentTaxValue.field_key,
      printed: documentTaxValue.printed,
      cents: documentTaxValue.value,
      quote: documentTaxValue.quote,
    })
    .from(documentTaxValue)
    .innerJoin(documents, eq(documents.id, documentTaxValue.document_id))
    .where(and(
      eq(documentTaxValue.status, "corrected"),
      eq(documentTaxValue.evidence_kind, kind),
      eq(documents.user_id, doc.userId),
      eq(documents.correspondent_slug, doc.correspondent),
      ne(documents.id, doc.id),
    ))
    .orderBy(desc(documentTaxValue.updated_at), desc(documentTaxValue.id))
    .limit(50);
  const out: CorrectionExample[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.field)) continue;
    // A "correction" to the number that was read teaches nothing.
    if (r.printed !== null && parseGermanAmountCents(r.printed) !== null && Math.abs(parseGermanAmountCents(r.printed)!) === Number(r.cents)) continue;
    seen.add(r.field);
    out.push({ field: r.field, printed: r.printed, cents: Number(r.cents), quote: r.quote });
    if (out.length >= MAX_CORRECTION_EXAMPLES) break;
  }
  return out;
}

/** The model's two steps; injectable for tests. */
export interface TaxValueReader {
  pickKind(kinds: readonly EvidenceKind[], text: string): Promise<EvidenceKind | null>;
  readValues(kind: EvidenceKind, year: number, text: string, examples: readonly CorrectionExample[]): Promise<unknown>;
}

export const modelReader: TaxValueReader = {
  async pickKind(kinds, text) {
    // One candidate needs no question: sections and type already decided it.
    if (kinds.length === 1) return kinds[0]!;
    return parseKindAnswer(await jsonPrompt(buildKindPrompt(kinds, text), SYSTEM, 100), kinds);
  },
  readValues(kind, year, text, examples) {
    return jsonPrompt(buildValuesPrompt(kind, year, text, examples), SYSTEM, 1500);
  },
};

export interface TaxValuesResult {
  kind: string | null;
  read: number;
  rejected: number;
}

/**
 * Job: `tax_values`. Reads the values of one evidence document and stores
 * them. A document that is no longer `beleg` (the user changed its role)
 * loses its read values; confirmed and corrected ones stay.
 */
export async function runTaxValues(documentId: number, reader: TaxValueReader = modelReader): Promise<TaxValuesResult | null> {
  const doc = await loadEvidenceDocument(documentId);
  if (!doc) return null;
  const kinds = candidateKinds(doc);
  const kind = kinds.length ? await reader.pickKind(kinds, doc.text) : null;
  const examples = kind ? await correctionExamples(doc, kind.key) : [];
  const values = kind ? checkReadValues(kind, await reader.readValues(kind, doc.taxYear!, doc.text, examples), doc.text) : [];

  const persons = await linkedPersons(documentId);
  const rows = await Promise.all(values.map(async (v) => {
    const formKey = field(kind!, v.field)?.formKey ?? null;
    const scope = formKey ? findFormField(doc.taxYear!, formKey)?.scope : undefined;
    return {
      document_id: documentId,
      tax_year: doc.taxYear!,
      owner: ownerFor(scope, persons),
      evidence_kind: kind!.key,
      field_key: v.field,
      value: v.value,
      printed: v.printed,
      quote: v.quote,
      page: v.status === "read" ? await pageOf(documentId, v.printed) : null,
      status: v.status,
      note: v.note,
    };
  }));

  await db.transaction(async (tx) => {
    await tx
      .delete(documentTaxValue)
      .where(and(eq(documentTaxValue.document_id, documentId), inArray(documentTaxValue.status, ["read", "rejected"])));
    // What the user confirmed or corrected wins over a new reading.
    if (rows.length) await tx.insert(documentTaxValue).values(rows).onConflictDoNothing();
    await tx
      .insert(documentTaxReading)
      .values({ document_id: documentId, evidence_kind: kind?.key ?? null })
      .onConflictDoUpdate({
        target: documentTaxReading.document_id,
        set: { evidence_kind: kind?.key ?? null, read_at: sql`now()` },
      });
  });

  const result = {
    kind: kind?.key ?? null,
    read: values.filter((v) => v.status === "read").length,
    rejected: values.filter((v) => v.status === "rejected").length,
  };
  if (kinds.length) {
    console.log(`[documents] tax_values(${documentId}) — ${result.kind ?? "no kind"}, ${result.read} read, ${result.rejected} rejected`);
  }
  return result;
}

/**
 * Queues the reading after classify, when the document is evidence of a
 * kind we can read — or when it was read before and is no longer, so its
 * old values go.
 */
export async function queueTaxValuesIfEvidence(documentId: number, priority = TAX_VALUES_PRIORITY): Promise<boolean> {
  const doc = await loadEvidenceDocument(documentId);
  if (!doc) return false;
  const wasRead = (await db
    .select({ id: documentTaxReading.document_id })
    .from(documentTaxReading)
    .where(eq(documentTaxReading.document_id, documentId))).length > 0;
  if (!candidateKinds(doc).length && !wasRead) return false;
  await enqueueDocumentScan(documentId, ["tax_values"], priority);
  return true;
}
