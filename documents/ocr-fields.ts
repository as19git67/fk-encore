/**
 * Label → value pairs, read off the page's geometry.
 *
 * A document tells you what belongs where. `Invoice No.  E0300008SA` is not an
 * implausible token that needs a rule to excuse it — it is an identifier, and
 * the word to its left says so. `Rechnungsdatum  23 aus oz` is not a token that
 * happens to look odd — it is a date that does not parse, and the word to its
 * left says that too.
 *
 * This module builds that pairing once, from the boxes, before anything is
 * judged. It replaces a growing pile of per-shape heuristics with one
 * structure: instead of asking "does this token look wrong?" — a question that
 * needs a new special case for every new document layout — callers ask "the
 * label says what belongs here; does the value satisfy it?"
 *
 * ## Why geometry rather than text
 *
 * `metadata-extract.ts` derives its labels from the *rendered* text, by which
 * point the boxes are gone: it reconstructs from strings what existed as
 * geometry a few steps earlier, and pays for that with whitespace-tolerant
 * regexes that can only guess at column structure. The rows this module reads
 * are the same ones the layout rebuild already produced, with the columns
 * already separated — so a pairing that spans two unrelated columns is
 * impossible by construction rather than by heuristic.
 *
 * ## Scope: round one
 *
 * Deterministic pairing only. No iteration, no model. Three positional
 * patterns cover most German and English office paperwork:
 *
 *   label  value          same row, separated by a column-width gap
 *   label                 label alone on a row, value on the row beneath
 *     value
 *   label₁   label₂       a header row, values aligned beneath each label
 *   value₁   value₂
 *
 * What this round deliberately does *not* do: judge whether a value satisfies
 * its label, resolve the ones that do not, or handle values with no label at
 * all (position, self-identifying format, uniqueness on the page). Those need
 * the pairing to exist first, which is what this is.
 */

import { COLUMN_GAP_FACTOR, type OcrWord } from "./ocr-layout";
import { spanBbox, type SpanBox } from "./ocr-uncertainty";

console.log("[boot] documents/ocr-fields.ts: all imports resolved");

/**
 * What a label says its value should be. Deliberately the same set the vision
 * resolver accepts (`VlmExpectedType`), so a pair can be handed straight to it
 * without a translation layer that would need its own tests.
 */
export type FieldType = "date" | "amount" | "iban" | "document_number" | "text";

export type PairingKind =
  /** `label  value` on one visual row. */
  | "same_row"
  /** Label alone on a row, value on the row beneath it. */
  | "stacked"
  /** A row of headers, values aligned in columns beneath. */
  | "column_header";

export interface FieldPair {
  /** The label as printed, verbatim — callers apply their own vocabulary to it. */
  label: string;
  labelBox: SpanBox;
  valueWords: OcrWord[];
  valueText: string;
  valueBox: SpanBox;
  pairing: PairingKind;
  expectedType: FieldType;
}

// ─── Label vocabulary ─────────────────────────────────────────────────────
//
// Ordered most-specific first: `Rechnungsnummer` must not be read as a date
// because it contains no date word, and `Rechnungsdatum` must not be read as a
// number because it ends in one. Each entry is tried in turn and the first
// match wins.

const LABEL_PATTERNS: ReadonlyArray<{ type: FieldType; re: RegExp }> = [
  // IBAN first: "Kontonummer" would otherwise be swallowed by the number rule.
  { type: "iban", re: /\b(iban|kontonummer|konto\b|bankverbindung)/i },
  // `\w*datum` mirrors metadata-extract.ts's anchor and covers Rechnungsdatum,
  // Belegdatum, Ausstellungsdatum … in one go. The label is returned verbatim,
  // so a caller can still apply that module's non-document-date test
  // (Geburtsdatum, Fälligkeitsdatum) — pairing is not interpretation.
  { type: "date", re: /\b(\w*datum|datum|date|buchungstag|valuta|vom)\b/i },
  {
    type: "amount",
    re: /\b(betrag|summe|gesamt\w*|total|saldo|preis|netto|brutto|zahlbetrag|amount|entgelt)\b/i,
  },
  {
    type: "document_number",
    re: /\b(\w*nummer|\w*-?nr\.?|no\.?|number|referenz|zeichen|aktenzeichen|beleg\w*|id)\b/i,
  },
];

/**
 * The type a label promises, or null when the text does not read as a label.
 *
 * Two independent signals make something a label: it matches the vocabulary,
 * or it ends in a colon. The colon alone yields `text` — `Sachbearbeiter:` is
 * a genuine label with no type expectation, and pairing it is still useful.
 */
export function labelType(text: string): FieldType | null {
  const value = text.trim();
  if (value.length === 0) return null;
  // A label is a label, not a sentence. Anything long enough to be prose is
  // rejected before the vocabulary gets a chance to match a word inside it.
  if (value.length > 40 || value.split(/\s+/).length > 4) return null;

  for (const { type, re } of LABEL_PATTERNS) {
    if (re.test(value)) return type;
  }
  return /:$/.test(value) ? "text" : null;
}

/** Is this a label *and nothing else* — i.e. does it carry no value with it? */
function isLabelOnly(words: OcrWord[]): boolean {
  return labelType(words.map((w) => w.text).join(" ")) !== null;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

function textOf(words: readonly OcrWord[]): string {
  return words.map((w) => w.text).join(" ").trim();
}

function medianHeight(words: readonly OcrWord[]): number {
  const heights = words.map((w) => w.bottom - w.top).sort((a, b) => a - b);
  return heights.length === 0 ? 1 : Math.max(1, heights[Math.floor(heights.length / 2)]);
}

/**
 * Split a row into groups separated by column-width gaps — the same threshold
 * the layout rebuild renders as a column separator, so a group here is exactly
 * what reads as one cell in `extracted_text`.
 */
export function splitRowCells(row: OcrWord[]): OcrWord[][] {
  const cells: OcrWord[][] = [];
  let current: OcrWord[] = [];
  for (const word of row) {
    const previous = current.at(-1);
    if (previous) {
      const unit = Math.max(1, Math.min(word.bottom - word.top, previous.bottom - previous.top));
      if (word.left - previous.right > COLUMN_GAP_FACTOR * unit) {
        cells.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) cells.push(current);
  return cells;
}

// ─── Pairing ──────────────────────────────────────────────────────────────

/**
 * `label  value` on one row.
 *
 * Two shapes, both common: the label in its own cell with the value in the
 * next one (`Rechnungsdatum      23.08.2002`), and a colon-terminated label
 * sharing a cell with its value (`Sachbearbeiter: Muster`). The second needs
 * no gap at all, which is why the colon is treated as a separator in its own
 * right.
 */
function pairSameRow(row: OcrWord[]): FieldPair[] {
  const pairs: FieldPair[] = [];
  const cells = splitRowCells(row);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cellText = textOf(cell);

    // Colon inside the cell: everything up to and including it is the label.
    const colonAt = cell.findIndex((w) => w.text.trim().endsWith(":"));
    if (colonAt >= 0 && colonAt < cell.length - 1) {
      const labelWords = cell.slice(0, colonAt + 1);
      const valueWords = cell.slice(colonAt + 1);
      const type = labelType(textOf(labelWords));
      if (type !== null) {
        pairs.push(makePair(labelWords, valueWords, "same_row", type));
        continue;
      }
    }

    // Label in its own cell, value in the next.
    const type = labelType(cellText);
    if (type === null) continue;
    const next = cells[i + 1];
    if (!next || next.length === 0) continue;
    // The next cell must not itself be a label — that is a header row, handled
    // by `pairColumnHeader`, and pairing two headers with each other would
    // invent a field that is not on the page.
    if (isLabelOnly(next)) continue;
    pairs.push(makePair(cell, next, "same_row", type));
    i++; // the value cell is consumed
  }
  return pairs;
}

/**
 * A label alone on its row, the value on the row beneath, left edges aligned.
 *
 * The alignment test is what keeps this from pairing a label with whatever
 * happens to follow it: on a German business letter the block below a
 * left-aligned label is its value, while a right-hand column's content starts
 * hundreds of pixels away and is rejected.
 */
function pairStacked(labelRow: OcrWord[], valueRow: OcrWord[]): FieldPair | null {
  const label = textOf(labelRow);
  const type = labelType(label);
  if (type === null) return null;

  const labelBox = spanBbox(labelRow);
  const valueBox = spanBbox(valueRow);
  const unit = medianHeight(labelRow);

  // Directly beneath, not three fields further down.
  if (valueBox.top - labelBox.bottom > 1.5 * unit) return null;
  // Left edges within one character width of each other.
  if (Math.abs(valueBox.left - labelBox.left) > unit) return null;
  if (isLabelOnly(valueRow)) return null;

  return makePair(labelRow, valueRow, "stacked", type);
}

/**
 * A header row with several labels, values aligned in columns beneath.
 *
 * Each label owns the horizontal band from its own left edge to the next
 * label's; a value belongs to the label whose band contains its centre. That
 * handles the usual right-aligned amount under a left-aligned header, which a
 * strict left-edge match would miss.
 */
function pairColumnHeader(headerRow: OcrWord[], valueRow: OcrWord[]): FieldPair[] {
  const headers = splitRowCells(headerRow);
  const typed = headers
    .map((cell) => ({ cell, type: labelType(textOf(cell)) }))
    .filter((h): h is { cell: OcrWord[]; type: FieldType } => h.type !== null);
  if (typed.length < 2) return [];

  const headerBox = spanBbox(headerRow);
  const valueBox = spanBbox(valueRow);
  const unit = medianHeight(headerRow);
  if (valueBox.top - headerBox.bottom > 2 * unit) return [];

  const pairs: FieldPair[] = [];
  for (let i = 0; i < typed.length; i++) {
    const from = spanBbox(typed[i].cell).left - unit;
    const to = i + 1 < typed.length ? spanBbox(typed[i + 1].cell).left - unit : Infinity;
    const valueWords = valueRow.filter((w) => {
      const centre = (w.left + w.right) / 2;
      return centre >= from && centre < to;
    });
    if (valueWords.length === 0) continue;
    if (isLabelOnly(valueWords)) continue;
    pairs.push(makePair(typed[i].cell, valueWords, "column_header", typed[i].type));
  }
  return pairs;
}

function makePair(
  labelWords: OcrWord[],
  valueWords: OcrWord[],
  pairing: PairingKind,
  expectedType: FieldType,
): FieldPair {
  return {
    label: textOf(labelWords),
    labelBox: spanBbox(labelWords),
    valueWords,
    valueText: textOf(valueWords),
    valueBox: spanBbox(valueWords),
    pairing,
    expectedType,
  };
}

/**
 * Every label → value pair the page's geometry supports.
 *
 * `rows` are the visual rows the layout rebuild produced, in reading order and
 * with columns already separated. A page with no recognizable labels yields an
 * empty array, which callers read as "no expectations available here" — not as
 * an error.
 */
export function buildFieldMap(rows: OcrWord[][]): FieldPair[] {
  const pairs: FieldPair[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0) continue;

    const sameRow = pairSameRow(row);
    if (sameRow.length > 0) {
      pairs.push(...sameRow);
      continue;
    }

    // Only a row that carries no value of its own can be a header: otherwise
    // the row beneath is the next field, not this one's value.
    const next = rows[i + 1];
    if (!next || next.length === 0) continue;

    const columns = pairColumnHeader(row, next);
    if (columns.length > 0) {
      pairs.push(...columns);
      i++;
      continue;
    }

    const stacked = pairStacked(row, next);
    if (stacked) {
      pairs.push(stacked);
      i++;
    }
  }

  return pairs;
}

/**
 * The pair whose *value* contains `box`, if any — the lookup a consumer needs
 * to ask "what was this span supposed to be?".
 */
export function pairForBox(pairs: readonly FieldPair[], box: SpanBox): FieldPair | null {
  for (const pair of pairs) {
    const v = pair.valueBox;
    const overlapsX = box.left < v.right && box.right > v.left;
    const overlapsY = box.top < v.bottom && box.bottom > v.top;
    if (overlapsX && overlapsY) return pair;
  }
  return null;
}
