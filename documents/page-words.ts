/**
 * Where each word of a document stands on its page (#1531, prerequisite of
 * stage 6 of documentation/plans/ki-assistent.md).
 *
 * Text extraction knows the boxes at the moment it reads a page — Tesseract's
 * TSV for a scan, pdf.js's text items for a born-digital page — and used to
 * drop them once the layout text was built. `text_extract` now writes them to
 * `document_page_words` in the same transaction as `extracted_text`, so
 * finding where a value stands ("the purchase price, on which pages?") never
 * needs OCR to run again.
 *
 * Coordinates are stored in the page's own unit — pixels of the rasterized
 * page for a scan (after the rotation OCR applied, which is also the
 * orientation of the served sandwich PDF), points for a born-digital page —
 * and converted to the 0..1 rectangles `document_collection_members.redactions`
 * uses only when a box is asked for.
 *
 * Pure: storing and loading live in `page-words-store.ts`, so the extraction
 * code that builds the words does not pull in the database.
 */

import fs from "node:fs";
import type { OcrWord } from "./ocr-layout";
import type { PdfTextItem } from "./pdf-text-layout";

/** One word with its box, top-left origin, in the page's unit. */
export interface StoredWord {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Tesseract's 0..100 confidence; absent for a text-layer word. */
  confidence?: number;
}

export interface PageWords {
  /** 1-based. */
  page: number;
  width: number;
  height: number;
  unit: "px" | "pt";
  /** Degrees the page was turned before reading (OCR) or its /Rotate (text layer). */
  rotation: number;
  /** In reading order: visual rows top to bottom, words left to right. */
  words: StoredWord[];
}

/** A rectangle in 0..1 page coordinates, as redactions store them. */
export interface TextBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TextBoxSearch =
  | { status: "ok"; boxes: TextBox[] }
  /** Extracted before positions were kept; the backfill or a re-extraction fills it. */
  | { status: "no_words"; boxes: [] };

// ── building ──────────────────────────────────────────────────────────────

/** The corrected OCR rows of one page, flattened in reading order. */
export function wordsFromOcrRows(rows: readonly OcrWord[][]): StoredWord[] {
  const words: StoredWord[] = [];
  for (const row of rows) {
    for (const w of row) {
      const text = w.text.trim();
      if (!text) continue;
      words.push({
        text,
        left: w.left,
        top: w.top,
        right: w.right,
        bottom: w.bottom,
        ...(w.confidence !== undefined && w.confidence >= 0 ? { confidence: Math.round(w.confidence) } : {}),
      });
    }
  }
  return words;
}

/** Share of the font size above the baseline (ascent) and below it (descent). */
const ASCENT = 0.8;
const DESCENT = 0.2;

/**
 * The words of a born-digital page from pdf.js text items. An item is a run
 * of text in one font; it is split at whitespace and its width shared out by
 * character count, which is close enough for a box that has to cover a value.
 * `view` is the page's [x0, y0, x1, y1] in PDF user space (y up).
 */
export function wordsFromPdfItems(items: readonly PdfTextItem[], view: readonly number[]): StoredWord[] {
  const [x0, , , y1] = view;
  const words: StoredWord[] = [];
  for (const item of items) {
    const t = item.transform;
    if (!item.str || !Array.isArray(t) || t.length < 6) continue;
    const x = t[4];
    const baseline = t[5];
    if (!Number.isFinite(x) || !Number.isFinite(baseline)) continue;
    const size = item.height != null && item.height > 0 ? item.height : Math.abs(t[3]) || 1;
    const width = item.width != null && item.width > 0 ? item.width : size * 0.5 * item.str.length;
    const perChar = width / item.str.length;
    const top = y1 - (baseline + size * ASCENT);
    const bottom = y1 - (baseline - size * DESCENT);
    for (const match of item.str.matchAll(/\S+/g)) {
      const start = match.index ?? 0;
      words.push({
        text: match[0],
        left: x - x0 + start * perChar,
        top,
        right: x - x0 + (start + match[0].length) * perChar,
        bottom,
      });
    }
  }
  return words;
}

/** Width and height of a PNG from its header, without decoding it. */
export async function pngSize(path: string): Promise<{ width: number; height: number } | null> {
  const handle = await fs.promises.open(path, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

// ── finding ───────────────────────────────────────────────────────────────

const CURRENCY = /^(?:€|eur|euro|euros?)$/i;

/** A word that is only a currency sign or code. Not via normalizeToken, which strips "€". */
function isCurrency(word: StoredWord): boolean {
  return CURRENCY.test(word.text.trim().replace(/[.:,;)]+$/, "").replace(/^\(+/, ""));
}
/** Currency signs and codes glued to a number: "€450.000", "450.000,00EUR". */
const GLUED_CURRENCY = /^(?:€|eur(?:o)?)\s*|\s*(?:€|eur(?:o)?)$/gi;

/**
 * The value of an amount as printed: "450.000,00", "450.000", "450.000,-",
 * "450000", "€ 450.000" or "450,000.00". Null for anything else — a date, a
 * phone number, a word.
 */
export function amountValue(raw: string): number | null {
  let s = raw.trim().replace(GLUED_CURRENCY, "").trim();
  // "450.000,-" / "450.000,--" / "450.000,—": whole euros.
  s = s.replace(/[,.](?:-{1,2}|—|–)$/, "");
  if (!s) return null;
  let normalized: string;
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s) || /^-?\d+(?:,\d{1,2})?$/.test(s)) {
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s) || /^-?\d+\.\d{1,2}$/.test(s)) {
    normalized = s.replace(/,/g, "");
  } else {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeToken(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Whether `b` continues the line `a` stands on, close enough to be one phrase. */
function adjacent(a: StoredWord, b: StoredWord): boolean {
  const height = Math.max(a.bottom - a.top, b.bottom - b.top, 1);
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (overlap < 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top)) return false;
  const gap = b.left - a.right;
  return gap > -0.5 * height && gap < 3 * height;
}

function boxOf(page: PageWords, words: readonly StoredWord[]): TextBox {
  const left = Math.min(...words.map((w) => w.left));
  const top = Math.min(...words.map((w) => w.top));
  const right = Math.max(...words.map((w) => w.right));
  const bottom = Math.max(...words.map((w) => w.bottom));
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp(left / page.width);
  const y = clamp(top / page.height);
  return {
    page: page.page,
    x: round(x),
    y: round(y),
    w: round(clamp(right / page.width) - x),
    h: round(clamp(bottom / page.height) - y),
  };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Longest run of words an amount may be split into ("450 000,00", "EUR 450.000,-"). */
const MAX_AMOUNT_WORDS = 3;

/**
 * Where `query` stands on the pages, one box per occurrence, adjacent words
 * merged. An amount matches in every printed form of the same value, with a
 * currency sign or code next to it included in the box; anything else matches
 * as a phrase, case- and punctuation-insensitive.
 */
export function findBoxes(pages: readonly PageWords[], query: string): TextBox[] {
  const amount = amountValue(query);
  const phrase = query.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (amount === null && !phrase.length) return [];
  const boxes: TextBox[] = [];
  for (const page of pages) {
    const words = page.words;
    for (let i = 0; i < words.length; i++) {
      const end = amount !== null ? matchAmount(words, i, amount) : matchPhrase(words, i, phrase);
      if (end < 0) continue;
      let from = i;
      let to = end;
      if (amount !== null) {
        if (from > 0 && isCurrency(words[from - 1]) && adjacent(words[from - 1], words[from])) from--;
        if (to + 1 < words.length && isCurrency(words[to + 1]) && adjacent(words[to], words[to + 1])) to++;
      }
      boxes.push(boxOf(page, words.slice(from, to + 1)));
      i = to;
    }
  }
  return boxes;
}

/** The index of the last word of an amount starting at `i`, or -1. */
function matchAmount(words: readonly StoredWord[], i: number, value: number): number {
  let joined = "";
  for (let k = i; k < words.length && k < i + MAX_AMOUNT_WORDS; k++) {
    if (k > i && !adjacent(words[k - 1], words[k])) break;
    // A currency code opens the run only as part of a longer one.
    joined += words[k].text;
    if (!/\d/.test(words[i].text) && k === i) continue;
    if (amountValue(joined) === value) return k;
  }
  return -1;
}

function matchPhrase(words: readonly StoredWord[], i: number, phrase: readonly string[]): number {
  for (let k = 0; k < phrase.length; k++) {
    const w = words[i + k];
    if (!w || normalizeToken(w.text) !== phrase[k]) return -1;
    if (k > 0 && !adjacent(words[i + k - 1], w)) return -1;
  }
  return i + phrase.length - 1;
}
