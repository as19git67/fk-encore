/**
 * Which kind of securities paper a document is, when the rules cannot tell
 * (documentation/plans/wertpapier-stamm.md, stage 3).
 *
 * The settlement and statement readers only look at papers whose wording
 * the rules recognise ("Wertpapierabrechnung", "Depotauszug", …). A bank
 * that words its papers differently ("Ihre Order wurde ausgeführt",
 * "Übersicht Ihrer Anlagen") falls through both. Such a paper — one with a
 * security identifier and securities wording, but none of the headings —
 * is shown to the model once: which kind of paper is it? The answer is
 * kept in finance_document_paper_llm and routes the paper:
 *
 *   trade | dividend | tax → the settlement reader (enrichPendingDocuments)
 *   statement             → the statement reader (enrichPendingStatements)
 *   other                 → nothing
 *
 * The readers then read the paper as they read any other; the master
 * (stage 1) still decides whether anything is booked.
 */

import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccountHolding,
  financeDepotDocumentIgnore,
  financeDepotTransactionDocument,
  financeDocumentPaperLlm,
} from "../db/schema";
import {
  INSURANCE_PATTERN,
  looksLikeInsurancePaper,
  SETTLEMENT_CANDIDATE_PATTERN,
} from "./depot-settlement-parser";
import { looksLikeSecuritiesPaper, type LlmMode } from "./depot-settlement-reader";
import { STATEMENT_CANDIDATE_PATTERN } from "./depot-statement-parser";
import { classifySecuritiesPaper, LlmServiceUnavailableError } from "./llm-client";

console.log("[boot] finance/depot-paper-type.ts: all imports resolved");

export const PAPER_TYPES = ["trade", "dividend", "tax", "statement", "other"] as const;
export type ModelPaperType = (typeof PAPER_TYPES)[number];

/** The types the settlement reader handles. */
export const SETTLEMENT_PAPER_TYPES: ModelPaperType[] = ["trade", "dividend", "tax"];

/** The model's answer → a paper type; anything unknown is "other". */
export function parsePaperType(raw: Record<string, unknown>): ModelPaperType {
  const v = typeof raw.paper_type === "string" ? raw.paper_type.trim().toLowerCase() : "";
  return (PAPER_TYPES as readonly string[]).includes(v) ? (v as ModelPaperType) : "other";
}

/** The stored answer for a document, null when the model was not asked. */
export async function storedPaperType(documentId: number): Promise<ModelPaperType | null> {
  const [row] = await db
    .select({ paper_type: financeDocumentPaperLlm.paper_type })
    .from(financeDocumentPaperLlm)
    .where(eq(financeDocumentPaperLlm.document_id, documentId))
    .limit(1);
  return (row?.paper_type as ModelPaperType | undefined) ?? null;
}

/** Documents the model took for one of these kinds of paper — the readers' extra candidates. */
export function documentsOfPaperType(types: ModelPaperType[]) {
  return db
    .select({ id: financeDocumentPaperLlm.document_id })
    .from(financeDocumentPaperLlm)
    .where(inArray(financeDocumentPaperLlm.paper_type, types));
}

const STATEMENT_RE = new RegExp(STATEMENT_CANDIDATE_PATTERN, "i");
const CANDIDATE_RE = new RegExp(SETTLEMENT_CANDIDATE_PATTERN, "i");

/**
 * Worth the question: an identifier and securities wording, no heading the
 * rules know, and not insurance paperwork. The rules' own readers take the
 * papers they recognise; this is for the rest.
 */
export function needsPaperType(text: string | null): boolean {
  if (!text) return false;
  if (CANDIDATE_RE.test(text) || STATEMENT_RE.test(text)) return false;
  if (looksLikeInsurancePaper(text)) return false;
  return looksLikeSecuritiesPaper(text);
}

/**
 * The kind of paper the model takes the document for, asking it once.
 * Null when the paper does not need the question, or the model was not
 * reachable (it is asked again on the next run).
 */
export async function paperTypeOf(documentId: number, text: string | null, mode: LlmMode = "allow"): Promise<ModelPaperType | null> {
  const stored = await storedPaperType(documentId);
  if (stored) return stored;
  if (mode !== "allow" || !needsPaperType(text)) return null;
  try {
    const raw = await classifySecuritiesPaper(text!);
    const paperType = parsePaperType(raw);
    await db
      .insert(financeDocumentPaperLlm)
      .values({ document_id: documentId, paper_type: paperType, values: raw })
      .onConflictDoUpdate({
        target: financeDocumentPaperLlm.document_id,
        set: { paper_type: paperType, values: raw, created_at: new Date().toISOString() },
      });
    return paperType;
  } catch (err) {
    if (!(err instanceof LlmServiceUnavailableError)) {
      console.warn(`[finance] paper type LLM read failed for document=${documentId}:`, (err as Error).message);
    }
    return null;
  }
}

export interface PaperTypeStats {
  documents_examined: number;
  /** Taken for a settlement, a credit note or a tax notice. */
  settlements: number;
  /** Taken for a depot statement. */
  statements: number;
  other: number;
  /** The model was not reachable: asked again on the next run. */
  unanswered: number;
  next_before: number | null;
}

/** An ISIN, or a prefixed WKN, as Postgres finds it (`~`, case-sensitive for the ISIN). */
const ISIN_SQL = String.raw`\m[A-Z]{2}[A-Z0-9]{9}[0-9]\M`;
const WKN_SQL = String.raw`(WKN|WPKNR|WP-?KENN)[.:[:space:]/]+[A-Z0-9]{6}`;

/**
 * Ask the model about every ready document that has an identifier but no
 * wording the rules recognise and was not asked yet. Paged like the
 * readers: newest first, `next_before` continues. Writes only answers —
 * the readers pick the papers up through `documentsOfPaperType`.
 */
export async function classifyPendingPapers(
  limit = 200,
  page: { before?: number | null; budgetMs?: number } = {},
): Promise<PaperTypeStats> {
  const stats: PaperTypeStats = { documents_examined: 0, settlements: 0, statements: 0, other: 0, unanswered: 0, next_before: null };

  const asked = db.select({ id: financeDocumentPaperLlm.document_id }).from(financeDocumentPaperLlm);
  const ignored = db.select({ id: financeDepotDocumentIgnore.document_id }).from(financeDepotDocumentIgnore);
  const linked = db.select({ id: financeDepotTransactionDocument.document_id }).from(financeDepotTransactionDocument);
  const stored = db
    .select({ id: financeAccountHolding.document_id })
    .from(financeAccountHolding)
    .where(isNotNull(financeAccountHolding.document_id));

  const pageSize = Math.max(1, Math.min(limit, 1000));
  const conditions = [
    eq(documents.status, "ready"),
    isNotNull(documents.extracted_text),
    sql`(${documents.extracted_text} ~ ${ISIN_SQL} OR ${documents.extracted_text} ~* ${WKN_SQL})`,
    sql`${documents.extracted_text} !~* ${`(${SETTLEMENT_CANDIDATE_PATTERN})`}`,
    sql`${documents.extracted_text} !~* ${`(${STATEMENT_CANDIDATE_PATTERN})`}`,
    sql`${documents.extracted_text} !~* ${`(${INSURANCE_PATTERN})`}`,
    notInArray(documents.id, asked),
    notInArray(documents.id, ignored),
    notInArray(documents.id, linked),
    notInArray(documents.id, stored),
  ];
  if (page.before != null) conditions.push(sql`${documents.id} < ${page.before}`);

  const found = await db
    .select({ id: documents.id, text: documents.extracted_text })
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.id))
    .limit(pageSize + 1);
  const candidates = found.slice(0, pageSize);
  stats.next_before = found.length > pageSize ? candidates[candidates.length - 1]!.id : null;

  const started = Date.now();
  for (const [i, c] of candidates.entries()) {
    if (i > 0 && page.budgetMs !== undefined && Date.now() - started >= page.budgetMs) {
      stats.next_before = candidates[i - 1]!.id;
      break;
    }
    // The SQL found an identifier; the securities wording is checked here.
    if (!needsPaperType(c.text)) continue;
    stats.documents_examined++;
    const t = await paperTypeOf(c.id, c.text, "allow");
    if (t === null) stats.unanswered++;
    else if (t === "statement") stats.statements++;
    else if (t === "other") stats.other++;
    else stats.settlements++;
  }
  return stats;
}
