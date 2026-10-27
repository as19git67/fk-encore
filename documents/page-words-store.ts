/**
 * Storing and reading `document_page_words` (#1531); the words themselves
 * are built and searched in `page-words.ts`.
 */

import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { documentPageWords } from "../db/schema";
import { cleanWordText, findBoxes, type PageWords, type StoredWord, type TextBoxSearch } from "./page-words";

// ── storing ───────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Replaces a document's rows. Called inside the transaction that writes
 * `extracted_text`, so text search and box search always see the same words.
 */
export async function replacePageWords(tx: Tx, documentId: number, pages: readonly PageWords[]): Promise<void> {
  await tx.delete(documentPageWords).where(eq(documentPageWords.document_id, documentId));
  // The builders clean already; this is the last stop before `jsonb`, so a
  // word from any other source cannot fail the insert either.
  const cleaned = pages.map((p) => ({ ...p, words: cleanWords(p.words) }));
  const rows = cleaned.filter((p) => p.words.length > 0 && p.width > 0 && p.height > 0);
  if (!rows.length) return;
  await tx.insert(documentPageWords).values(rows.map((p) => ({
    document_id: documentId,
    page: p.page,
    width: p.width,
    height: p.height,
    unit: p.unit,
    rotation: p.rotation,
    words: p.words,
  })));
}

function cleanWords(words: readonly StoredWord[]): StoredWord[] {
  const out: StoredWord[] = [];
  for (const w of words) {
    const text = cleanWordText(w.text);
    if (text) out.push(text === w.text ? w : { ...w, text });
  }
  return out;
}

export async function hasPageWords(documentId: number): Promise<boolean> {
  const [row] = await db
    .select({ page: documentPageWords.page })
    .from(documentPageWords)
    .where(eq(documentPageWords.document_id, documentId))
    .limit(1);
  return row !== undefined;
}

export async function loadPageWords(documentId: number): Promise<PageWords[]> {
  const rows = await db
    .select()
    .from(documentPageWords)
    .where(eq(documentPageWords.document_id, documentId))
    .orderBy(asc(documentPageWords.page));
  return rows.map((r) => ({
    page: r.page,
    width: r.width,
    height: r.height,
    unit: r.unit as PageWords["unit"],
    rotation: r.rotation,
    words: r.words as StoredWord[],
  }));
}

/**
 * Where `query` stands in a document. A document extracted before positions
 * were kept says so instead of being OCR'd on the spot: the caller names it,
 * and the backfill or a re-extraction fills it in.
 */
export async function findTextBoxes(documentId: number, query: string): Promise<TextBoxSearch> {
  const pages = await loadPageWords(documentId);
  if (!pages.length) return { status: "no_words", boxes: [] };
  return { status: "ok", boxes: findBoxes(pages, query) };
}
