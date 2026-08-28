/**
 * Which parts of a recognized page deserve a second opinion.
 *
 * Tesseract does not fail loudly. It returns `23 aus oz` for a printed
 * `23 AUG 02` with the same shape of output it returns for a perfect line, and
 * everything downstream — the classifier, the deterministic sender/date scans,
 * the embeddings — reads that as fact. This module is the part of the pipeline
 * that says "this bit looks wrong", so the expensive resolvers
 * (`ocr-resolver.ts`) only run where they can help.
 *
 * Three independent signals, deliberately kept separate so each can be
 * measured and tuned on its own:
 *
 *  - **low confidence** — the number Tesseract already writes into its TSV and
 *    that `parseTesseractTsv` now carries through.
 *  - **implausible charset** — a token whose character mix does not occur in
 *    German office documents. `23 aus oz` is not low-confidence enough on its
 *    own on some scans; it *is* obviously wrong as a shape.
 *  - **pattern miss** — a span that almost matches something the pipeline
 *    knows (a date, an amount, an IBAN) but not quite. This is where domain
 *    knowledge enters, and it is plain regex — no model.
 *
 * A fourth reason, `engine_disagreement`, is not produced here: it comes from
 * comparing two OCR engines and is attached by the resolver.
 *
 * Everything in this file is a pure function over word boxes. No I/O, no
 * subprocesses, no service calls — that is what makes it cheap enough to run
 * on every page and testable without fixtures.
 */

import { COLUMN_GAP_FACTOR, type OcrWord } from "./ocr-layout";

console.log("[boot] documents/ocr-uncertainty.ts: all imports resolved");

/** Why a span is suspect. Several can apply at once. */
export type UncertaintyReason =
  | "low_confidence"
  | "implausible_charset"
  | "pattern_miss"
  | "engine_disagreement";

export interface SpanBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A contiguous group of words on one visual row that should be looked at
 * again, with the box a crop would be taken from.
 */
export interface UncertainSpan {
  words: OcrWord[];
  /** Union of the words' boxes, in page pixels. */
  bbox: SpanBox;
  /** The span's text as Tesseract read it. */
  text: string;
  reasons: UncertaintyReason[];
  /** 0..1. Orders spans when the per-document budget cannot take them all. */
  score: number;
}

export interface UncertaintyOptions {
  /**
   * Word confidence below which a word is suspect. Tesseract's scale is
   * 0..100. 70 is deliberately generous: a false positive costs one crop, a
   * false negative costs a wrong character in the stored text.
   */
  confidenceThreshold?: number;
  /** Hard cap on spans returned per page, highest score first. */
  maxSpans?: number;
  /**
   * Smallest box still treated as text, in pixels. Both dimensions must be
   * met. Scale these with `DOCUMENTS_OCR_DPI` if a deployment rasterizes at
   * something other than the default 200.
   */
  minSpanWidth?: number;
  minSpanHeight?: number;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 70;
const DEFAULT_MAX_SPANS = 12;

/**
 * A span smaller than this is a speck, not text.
 *
 * Measured at the pipeline's default 200 dpi, where a printed glyph is roughly
 * 18 px tall and 10 px wide. Scanner noise, JPEG ringing and dust leave boxes
 * of 2x2 to 9x3 px that Tesseract dutifully reads as `.`, `|` or `'` with low
 * confidence. They therefore flag as uncertain, consume the per-page span
 * budget, and — because `overlapRatio` in the resolver normalises by the
 * span's own area — sit fully inside any PaddleOCR line that contains them,
 * matching it at ratio 1.0. One 2x2 px speck drew in an entire unrelated line
 * as its "second reading".
 *
 * The thresholds sit below the smallest legible glyph and above the largest
 * speck seen in production, where 530 of 3440 spans fell under them and none
 * of those was text. They are dimensions rather than an area because a long
 * thin box (a table rule read as punctuation) is just as degenerate as a dot.
 */
const DEFAULT_MIN_SPAN_WIDTH = 4;
const DEFAULT_MIN_SPAN_HEIGHT = 8;

/**
 * Characters Tesseract swaps for one another, as a canonical folding map over
 * the *lowercased* token. Deliberately non-overlapping: a character belongs to
 * exactly one group, so folding is deterministic and order-independent.
 *
 * The set is narrow on purpose. Every pair added here is a pair the resolver
 * will treat as agreement between two engines, so a wrong entry does not make
 * the pipeline noisier — it makes it silently accept a misreading. `g`/`c`/`6`
 * share a shape and belong together; `5` and `8` do not, and must never.
 */
const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries({
    "0": "0", o: "0", q: "0",
    "1": "1", l: "1", i: "1", "|": "1",
    "2": "2", z: "2",
    "5": "5", s: "5",
    "6": "6", g: "6", c: "6",
    "8": "8", b: "8",
    u: "u", v: "u",
  }),
);

/** Letters a misread puts inside an otherwise numeric token. */
const DIGIT_CONFUSABLE_LETTERS = /[oliszbgq]/i;

/** Unit and currency suffixes that legitimately follow digits. */
const UNIT_SUFFIX = /(EUR|CHF|USD|kWh|km|qm|m²|%|€|\$)$/iu;

/** Month names a German document may print, in the forms OCR sees them. */
const MONTH_TOKENS = new Set([
  "jan", "feb", "mar", "mär", "maer", "apr", "mai", "may", "jun", "jul",
  "aug", "sep", "okt", "oct", "nov", "dez", "dec",
  "januar", "februar", "märz", "maerz", "april", "juni", "juli", "august",
  "september", "oktober", "november", "dezember", "march", "june", "july",
  "october", "december",
]);

/** Union box of a word group. */
export function spanBbox(words: OcrWord[]): SpanBox {
  return {
    left: Math.min(...words.map((w) => w.left)),
    top: Math.min(...words.map((w) => w.top)),
    right: Math.max(...words.map((w) => w.right)),
    bottom: Math.max(...words.map((w) => w.bottom)),
  };
}

/**
 * Is this box too small to hold a readable glyph?
 *
 * Applied before a span is emitted at all, so a speck never reaches the
 * resolver: it costs no crop, no model call, and cannot capture a PaddleOCR
 * line it merely happens to sit inside.
 */
export function tooSmallToRead(
  box: SpanBox,
  minWidth = DEFAULT_MIN_SPAN_WIDTH,
  minHeight = DEFAULT_MIN_SPAN_HEIGHT,
): boolean {
  return box.right - box.left < minWidth || box.bottom - box.top < minHeight;
}

/**
 * Fold a string onto its confusable skeleton: every character is replaced by
 * the first member of its group, case is dropped, whitespace and the
 * separators OCR invents or loses (`.`, `-`, `/`) are removed.
 *
 * `23 AUG 02` and `23 AUC 02` fold to the same skeleton — those two engines
 * agree in every way that matters, and neither needs a VLM. `7.500` and
 * `7.800` do not fold together, because `5` and `8` share no shape group. That
 * asymmetry is the whole point: folding must never make two genuinely
 * different *numbers* look equal.
 */
export function confusableFold(text: string): string {
  let out = "";
  for (const char of text.toLowerCase()) {
    if (/\s|[.\-/]/.test(char)) continue;
    out += CONFUSABLE_MAP.get(char) ?? char;
  }
  return out;
}

/**
 * A token whose character mix does not occur in real print.
 *
 * The signal is *mixing*, not the presence of any single character: `AUG02`
 * appears on real documents, and `Str.` is not suspect. What does not happen
 * is a token that switches script mid-word in the way a misread does —
 * lowercase letters embedded in a digit run, or a capital appearing after a
 * lowercase inside one token.
 */
export function hasImplausibleCharset(token: string): boolean {
  const text = token.trim();
  if (text.length < 2) return false;

  // Pure punctuation of any length — a scanned page edge produces runs of
  // these, and they carry no information worth resolving.
  if (/^[^\p{L}\p{N}]+$/u.test(text)) return true;

  // A digit-confusable letter inside a token that is mostly digits: `20,1l`,
  // `7.5O0`. The "mostly digits" test is what keeps `AUG02` — two digits after
  // three letters, a real form — out of it, and the suffix strip is what keeps
  // `20,11EUR` and `5m` out.
  const body = text.replace(UNIT_SUFFIX, "");
  const alnum = body.replace(/[^\p{L}\p{N}]/gu, "");
  const digits = alnum.replace(/\D/g, "").length;
  if (
    alnum.length > 0 &&
    digits / alnum.length >= 0.5 &&
    digits > 0 &&
    DIGIT_CONFUSABLE_LETTERS.test(body)
  ) {
    return true;
  }

  // A capital inside a token that starts lowercase (`aUs`). Restricting this
  // to lowercase-initial tokens is what distinguishes a misread from the real
  // German forms — `GmbH`, `KGaA`, `McDonald` all start with a capital.
  if (/^\p{Ll}{1,2}\p{Lu}/u.test(text)) return true;

  return false;
}

/**
 * A span that nearly matches a shape the pipeline knows. Returns the shape it
 * nearly matched, or null.
 *
 * "Nearly" is the operative word — a span that matches cleanly is not a miss,
 * and a span that resembles nothing is not one either. Only the middle ground
 * is worth a crop.
 */
export function patternMiss(
  text: string,
): "date" | "amount" | "iban" | "document_number" | null {
  const value = text.trim();
  if (!value) return null;

  // ── date ──────────────────────────────────────────────────────────────
  // dd.mm.yyyy / dd.mm.yy — a clean match is not a miss.
  if (/^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})$/.test(value)) return null;
  // `23 AUG 02` and its damaged forms: two digits, a word, two digits.
  const spelled = value.match(/^(\d{1,2})[\s.]+(\p{L}{3,9})\.?[\s.]+(\d{2}|\d{4})$/u);
  if (spelled) {
    const day = Number(spelled[1]);
    const month = spelled[2].toLowerCase();
    if (day >= 1 && day <= 31 && !MONTH_TOKENS.has(month)) return "date";
    return null;
  }
  // A numeric date with one component unreadable (`23.08.0?`, `23.O8.02`).
  if (/^[\dOolISZB?]{1,2}[.\s][\dOolISZB?]{1,2}[.\s][\dOolISZB?]{2,4}$/.test(value)) {
    if (/[OolISZB?]/.test(value)) return "date";
    return null;
  }

  // ── amount ────────────────────────────────────────────────────────────
  // German amount, clean.
  if (/^-?\d{1,3}(\.\d{3})*(,\d{2})?$/.test(value)) return null;
  if (/^-?\d+,\d{2}$/.test(value)) return null;
  // Mostly digits with a decimal comma, but carrying a letter that only a
  // misread puts there.
  if (/^[\d.,]*\d[\d.,]*$/.test(value.replace(/[OolISZB]/g, "0")) && /[OolISZB]/.test(value)) {
    return "amount";
  }

  // ── IBAN ──────────────────────────────────────────────────────────────
  const compact = value.replace(/\s/g, "");
  if (/^[A-Z]{2}\d{20}$/.test(compact)) return null;
  if (/^[A-Z]{2}[\dA-Z]{16,24}$/.test(compact) && /[A-Z]/.test(compact.slice(2))) {
    return "iban";
  }

  // ── document number ───────────────────────────────────────────────────
  // The `#1234` marker `extractDocumentNumber` looks for, with the digits
  // damaged. A clean marker is not a miss.
  if (/^#\d+$/.test(compact)) return null;
  if (/^#[\dOolISZB]{2,}$/.test(compact)) return "document_number";

  return null;
}

/**
 * Two words belong to the same value group when the gap between them is an
 * ordinary word space rather than a column break — the same threshold the
 * layout rebuild uses to decide whether a gap is a separator.
 */
function joinsAcross(left: OcrWord, right: OcrWord): boolean {
  const height = Math.max(left.bottom - left.top, right.bottom - right.top, 1);
  return right.left - left.right <= COLUMN_GAP_FACTOR * height;
}

/**
 * Score a span: how much a second opinion is worth here, 0..1.
 *
 * Weighted so that a span carrying several independent reasons outranks one
 * that is merely a bit below the confidence threshold — the budget should be
 * spent where the evidence is strongest, not where the confidence number
 * happens to be lowest.
 */
function scoreSpan(words: OcrWord[], reasons: UncertaintyReason[], threshold: number): number {
  const measured = words.map((w) => w.confidence).filter((c): c is number => c !== undefined);
  const mean = measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 100;
  // How far below the threshold, normalized. A word at 0 scores 1.
  const confidencePart = Math.max(0, Math.min(1, (threshold - mean) / threshold));
  const reasonPart = Math.min(1, reasons.length / 3);
  return Math.min(1, 0.6 * confidencePart + 0.4 * reasonPart);
}

/**
 * Find the spans on a page that deserve a second opinion.
 *
 * `rows` are the visual rows the layout rebuild already produced, so spans
 * never straddle a column boundary — a crop containing halves of two unrelated
 * columns would ask the resolver an unanswerable question.
 */
export function findUncertainSpans(
  rows: OcrWord[][],
  options: UncertaintyOptions = {},
): UncertainSpan[] {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
  const minWidth = options.minSpanWidth ?? DEFAULT_MIN_SPAN_WIDTH;
  const minHeight = options.minSpanHeight ?? DEFAULT_MIN_SPAN_HEIGHT;
  const spans: UncertainSpan[] = [];

  for (const row of rows) {
    const flagged = row.map((word) => {
      const reasons = new Set<UncertaintyReason>();
      if (word.confidence !== undefined && word.confidence < threshold) {
        reasons.add("low_confidence");
      }
      if (hasImplausibleCharset(word.text)) reasons.add("implausible_charset");
      return reasons;
    });

    let i = 0;
    while (i < row.length) {
      if (flagged[i].size === 0) {
        i++;
        continue;
      }
      // Grow the span over adjacent words, flagged or not, as long as they
      // belong to the same value group. `23` in `23 aus oz` is read correctly
      // and carries no reason of its own, but cropping without it would hand
      // the resolver a fragment.
      let start = i;
      while (start > 0 && joinsAcross(row[start - 1], row[start])) start--;
      let end = i;
      while (end + 1 < row.length && joinsAcross(row[end], row[end + 1])) end++;

      const words = row.slice(start, end + 1);
      const reasons = new Set<UncertaintyReason>();
      for (let k = start; k <= end; k++) for (const r of flagged[k]) reasons.add(r);

      const text = words.map((w) => w.text).join(" ");
      if (patternMiss(text) !== null) reasons.add("pattern_miss");

      const bbox = spanBbox(words);
      if (tooSmallToRead(bbox, minWidth, minHeight)) {
        i = end + 1;
        continue;
      }

      spans.push({
        words,
        bbox,
        text,
        reasons: [...reasons],
        score: scoreSpan(words, [...reasons], threshold),
      });
      i = end + 1;
    }
  }

  return spans.sort((a, b) => b.score - a.score).slice(0, maxSpans);
}
