/**
 * Layout-aware reconstruction of Tesseract OCR output.
 *
 * Tesseract's plain `txt` output preserves the layout *inside* each block it
 * detected, but emits the blocks one after another in its own reading order.
 * On a scanned form or invoice — several boxed regions side by side, an
 * address block next to a table — that order does not match how a human reads
 * the page: text that sits on the same visual line ends up dozens of lines
 * apart, and unrelated fragments end up adjacent. A concrete case from
 * production: on a doctor's invoice the patient's birth date landed next to
 * the invoice date, while the "geb." label that introduces it stayed behind in
 * another block. The classifier then read the birth year as the document's tax
 * year.
 *
 * The receipt pipeline solved the same problem in `receipt-ocr-service`
 * (`_build_visual_rows` / `_format_visual_row`) by regrouping the recognized
 * boxes into visual rows from their geometry. This module does the same for
 * documents, on top of Tesseract's word-level TSV output: words that share a
 * baseline become one line, ordered left to right, with wide horizontal gaps
 * kept as column separators so a table still reads as a table.
 *
 * Pure and side-effect free — `text-extract.ts` owns running the binary and
 * decides whether to use the reconstruction or Tesseract's own `txt`.
 */

console.log("[boot] documents/ocr-layout.ts: all imports resolved");

/** One recognized word with its pixel bounding box on the page. */
export interface OcrWord {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Two words belong to the same visual row when their baselines differ by less
 * than this fraction of the taller one's height. Baselines (the box bottom)
 * are more stable than box tops when a row mixes font sizes — a bold heading
 * next to small print still shares a baseline.
 */
const ROW_BASELINE_TOLERANCE = 0.35;

/**
 * A horizontal gap wider than this many times the local text height reads as
 * a column break rather than a word space. Matches the receipt service's
 * `_format_visual_row` factor.
 */
const COLUMN_GAP_FACTOR = 2.2;

/** What a column break becomes in the reconstructed text. */
const COLUMN_SEPARATOR = "   ";

/** Tesseract's TSV marks word-level rows with level 5. */
const TSV_WORD_LEVEL = 5;

/**
 * Parse Tesseract's `tsv` output into word boxes, dropping the structural
 * (page/block/paragraph/line) rows and anything without recognizable text.
 * Returns an empty array for output this doesn't understand, so callers can
 * fall back to the plain `txt` rendering.
 */
export function parseTesseractTsv(tsv: string): OcrWord[] {
  const lines = tsv.split(/\r?\n/);
  if (lines.length === 0) return [];

  const header = lines[0].split("\t");
  const col = (name: string) => header.indexOf(name);
  const iLevel = col("level");
  const iLeft = col("left");
  const iTop = col("top");
  const iWidth = col("width");
  const iHeight = col("height");
  const iText = col("text");
  if (iLevel < 0 || iLeft < 0 || iTop < 0 || iWidth < 0 || iHeight < 0 || iText < 0) {
    return [];
  }

  const words: OcrWord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if (cells.length <= iText) continue;
    if (Number(cells[iLevel]) !== TSV_WORD_LEVEL) continue;
    const text = cells[iText].trim();
    if (!text) continue;
    const left = Number(cells[iLeft]);
    const top = Number(cells[iTop]);
    const width = Number(cells[iWidth]);
    const height = Number(cells[iHeight]);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    words.push({ text, left, top, right: left + width, bottom: top + height });
  }
  return words;
}

/**
 * Regroup word boxes into visual rows: words sharing a baseline end up in one
 * row, rows run top to bottom, words inside a row left to right.
 */
export function buildVisualRows(words: OcrWord[]): OcrWord[][] {
  if (words.length === 0) return [];

  interface Row {
    words: OcrWord[];
    /** Mean box bottom of the row's words. */
    baseline: number;
    /** Tallest word in the row — the tolerance scales with it. */
    height: number;
  }

  // Feeding the rows in baseline order keeps the search local: once a row's
  // baseline is far above the current word, no later word can join it either.
  const sorted = [...words].sort((a, b) => a.bottom - b.bottom || a.left - b.left);
  const rows: Row[] = [];

  for (const word of sorted) {
    const height = Math.max(1, word.bottom - word.top);
    let best: Row | null = null;
    let bestDistance = Infinity;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const distance = Math.abs(word.bottom - row.baseline);
      // Rows this far above can no longer take a word, and neither can the
      // ones before them — the input is sorted by baseline.
      if (word.bottom - row.baseline > 3 * Math.max(height, row.height)) break;
      if (distance <= ROW_BASELINE_TOLERANCE * Math.max(height, row.height) && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }

    if (!best) {
      rows.push({ words: [word], baseline: word.bottom, height });
      continue;
    }
    best.words.push(word);
    best.baseline =
      best.words.reduce((sum, w) => sum + w.bottom, 0) / best.words.length;
    best.height = Math.max(best.height, height);
  }

  rows.sort((a, b) => a.baseline - b.baseline);
  return rows.map((row) => [...row.words].sort((a, b) => a.left - b.left));
}

/** Render one visual row, keeping wide gaps as column separators. */
export function formatVisualRow(words: OcrWord[]): string {
  let out = "";
  let previous: OcrWord | null = null;
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    if (previous) {
      const gap = word.left - previous.right;
      const unit = Math.max(
        1,
        Math.min(word.bottom - word.top, previous.bottom - previous.top),
      );
      out += gap > COLUMN_GAP_FACTOR * unit ? COLUMN_SEPARATOR : " ";
    }
    out += text;
    previous = word;
  }
  return out;
}

/**
 * Reconstruct a page's text from its word boxes: one line per visual row, in
 * top-to-bottom order. Returns an empty string when there is nothing to
 * render, which the caller reads as "fall back to Tesseract's own text".
 */
export function layoutTextFromWords(words: OcrWord[]): string {
  return buildVisualRows(words)
    .map(formatVisualRow)
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/** Convenience wrapper: TSV in, layout-reconstructed page text out. */
export function layoutTextFromTsv(tsv: string): string {
  return layoutTextFromWords(parseTesseractTsv(tsv));
}

/**
 * Whether the reconstruction may replace Tesseract's own `txt` rendering.
 *
 * Both strings come out of the same recognition pass, so they must carry the
 * same characters and differ only in arrangement. A materially shorter
 * reconstruction means the TSV was truncated or misparsed — in that case the
 * plain text is the safer output, even with its block ordering.
 */
export function shouldUseLayoutText(layoutText: string, plainText: string): boolean {
  if (layoutText.trim().length === 0) return false;
  const ink = (s: string) => s.replace(/\s+/g, "").length;
  const plainInk = ink(plainText);
  if (plainInk === 0) return true;
  return ink(layoutText) >= 0.9 * plainInk;
}
