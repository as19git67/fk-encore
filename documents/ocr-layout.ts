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

/**
 * A vertical whitespace corridor has to be at least this many times the local
 * text height before it reads as a column boundary rather than a wide word gap.
 */
const COLUMN_CORRIDOR_FACTOR = 4;

/**
 * A corridor spanning fewer rows than this is not a column. Two rows with a gap
 * between them are a table header and its values far more often than they are
 * two independent blocks.
 */
const MIN_BAND_ROWS = 3;

/**
 * The share of a band's rows that have content on BOTH sides of the corridor,
 * above which the band is treated as a table and left joined.
 *
 * This is what separates the two cases that look identical to a gap detector.
 * In a table nearly every row reaches across — that is what a row *is*, and
 * splitting it would put "Datum" and the date it heads into different lines,
 * which `extractAlignedColumnDate` reads by their shared column. Two blocks
 * printed side by side have their own line rhythms and their own vertical
 * extents, so most rows touch only one side.
 */
const TABLE_ROW_CORRESPONDENCE = 0.6;

/**
 * Both columns have to be running over at least this many rows before the
 * corridor between them counts as a column boundary.
 *
 * Without it a single line with a wide gap inside it — a salutation, a spaced
 * heading — forms a band with whatever short rows precede it, and the
 * correspondence test waves it through: most rows fail to reach across not
 * because there are two columns but because they are short. Measured, that
 * split "Sehr geehrte" from "Damen und Herren,".
 */
const MIN_SIDE_ROWS = 2;

interface Interval {
  from: number;
  to: number;
}

/**
 * A lone punctuation mark is a scan artefact, not content. The page edges of a
 * scanned letter routinely produce a column of stray "|" and "!" marks, and
 * they are enough to make a row look like it reaches across a corridor — which
 * would keep a band alive far past the two columns that justify it. They are
 * still rendered; they just do not get a vote on where the columns are.
 */
function isContent(word: OcrWord): boolean {
  const text = word.text.trim();
  return text.length > 1 || /[\p{L}\p{N}]/u.test(text);
}

/** The horizontal gaps no word of rows `from`..`to` reaches into. */
function freeIntervals(rows: OcrWord[][], from: number, to: number): Interval[] {
  const spans: Interval[] = [];
  for (let i = from; i <= to; i++) {
    for (const word of rows[i]) {
      if (isContent(word)) spans.push({ from: word.left, to: word.right });
    }
  }
  if (spans.length === 0) return [];
  spans.sort((a, b) => a.from - b.from);

  const gaps: Interval[] = [];
  let cursor = spans[0].to;
  for (const span of spans) {
    if (span.from > cursor) gaps.push({ from: cursor, to: span.from });
    cursor = Math.max(cursor, span.to);
  }
  return gaps;
}

/** Median word height over a set of rows — the unit the corridor scales with. */
function medianHeight(rows: OcrWord[][], from: number, to: number): number {
  const heights: number[] = [];
  for (let i = from; i <= to; i++) {
    for (const word of rows[i]) heights.push(Math.max(1, word.bottom - word.top));
  }
  if (heights.length === 0) return 1;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

/** Share of rows in the band with words on both sides of `splitAt`. */
function rowCorrespondence(
  rows: OcrWord[][], from: number, to: number, splitAt: number,
): number {
  let both = 0;
  for (let i = from; i <= to; i++) {
    if (reachesAcross(rows[i], splitAt)) both++;
  }
  return both / (to - from + 1);
}

/** True when this row has real content on both sides of the corridor. */
function reachesAcross(row: OcrWord[], splitAt: number): boolean {
  const content = row.filter(isContent);
  return (
    content.some((w) => w.right <= splitAt) && content.some((w) => w.left >= splitAt)
  );
}

/**
 * Split runs of rows that are really two blocks printed side by side, and emit
 * each block's rows in turn instead of interleaved.
 *
 * `buildVisualRows` groups by baseline, which is right for a table and wrong
 * for a letterhead: on a German business letter the recipient's address window
 * sits to the left of the sender's contact block, the two share baselines, and
 * the reconstruction merged them into single lines. The address block and the
 * company's phone number ended up on the same line, which is what the
 * classifier and the deterministic sender scan then had to read.
 *
 * Tesseract's own `block_num` looked like the answer and is not: measured on a
 * production insurance letter it put the return-address line and the right-hand
 * column's postcode line in one block, and the recipient's name in a block
 * with fragments of the contact column. The geometry it derives those blocks
 * from is sounder than the blocks themselves — between the two columns runs a
 * corridor no word reaches into, and it ends exactly where the body text starts
 * spanning the full width. That corridor is what this looks for.
 *
 * Deliberately one level deep and driven by the widest corridor: this is not a
 * general page-segmentation pass, it is the two-column letterhead. A band is
 * only split when it spans at least MIN_BAND_ROWS rows and its rows mostly do
 * NOT reach across the corridor — see TABLE_ROW_CORRESPONDENCE.
 */
export function splitColumnBands(rows: OcrWord[][]): OcrWord[][] {
  if (rows.length < MIN_BAND_ROWS) return rows;

  const out: OcrWord[][] = [];
  let i = 0;
  while (i < rows.length) {
    let bandEnd = -1;
    let splitAt = -1;

    // Grow the band while a corridor survives across all of its rows. The
    // intersection can only shrink, so the first row that closes it ends the
    // band — and that is the row where the body text starts spanning the page.
    for (let j = i + MIN_BAND_ROWS - 1; j < rows.length; j++) {
      const unit = medianHeight(rows, i, j);
      const wide = freeIntervals(rows, i, j)
        .filter((gap) => gap.to - gap.from >= COLUMN_CORRIDOR_FACTOR * unit);
      if (wide.length === 0) break;
      // The corridor already chosen has to survive. Without this the band grows
      // on into the body text, where the two columns have long since merged but
      // some unrelated gap — the margin, an indent — is still open, and the
      // split jumps to that one. Measured on a production letter this made the
      // pass separate the page's edge artefacts and leave the address block
      // exactly as merged as it was.
      const usable = splitAt < 0
        ? wide
        : wide.filter((gap) => gap.from <= splitAt && splitAt <= gap.to);
      if (usable.length === 0) break;
      const widest = usable.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
      bandEnd = j;
      splitAt = (widest.from + widest.to) / 2;
    }

    // Everything is judged over the corridor's full extent, and only then
    // trimmed for output. Measuring after the trim would be circular: the trim
    // ends the band on a row that reaches across, which is exactly the quantity
    // the correspondence test is trying to estimate.
    const corridorEnd = bandEnd;
    let leftRows = 0;
    let rightRows = 0;
    for (let k = i; k <= corridorEnd; k++) {
      const content = rows[k].filter(isContent);
      if (content.some((w) => w.right <= splitAt)) leftRows++;
      if (content.some((w) => w.left >= splitAt)) rightRows++;
    }

    // Past the last row that reaches across, the corridor is just empty page.
    // Splitting there would move text below it above text that precedes it —
    // on a real letter that moved the date line below the salutation.
    while (bandEnd > i && !reachesAcross(rows[bandEnd], splitAt)) bandEnd--;

    if (
      corridorEnd - i + 1 < MIN_BAND_ROWS ||
      leftRows < MIN_SIDE_ROWS ||
      rightRows < MIN_SIDE_ROWS ||
      rowCorrespondence(rows, i, corridorEnd, splitAt) >= TABLE_ROW_CORRESPONDENCE
    ) {
      out.push(rows[i]);
      i++;
      continue;
    }

    for (const side of [
      (w: OcrWord) => w.right <= splitAt,
      (w: OcrWord) => w.left > splitAt,
    ]) {
      for (let k = i; k <= bandEnd; k++) {
        const part = rows[k].filter(side);
        if (part.length > 0) out.push(part);
      }
    }
    i = bandEnd + 1;
  }
  return out;
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
  return splitColumnBands(buildVisualRows(words))
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
 * Mean per-word recognition confidence (0..100) over a TSV pass, or null when
 * it recognized nothing. Tesseract scores every word it emits, and the average
 * is a good summary of "did this page read like language" — text recognized
 * sideways still produces words, but with confidences far below an upright
 * page's. `ocr-preprocess.ts` uses that gap to check a rotation it isn't sure
 * about; kept here because this module owns the TSV column layout.
 *
 * The structural rows (page/block/paragraph/line) carry conf -1 and are
 * skipped along with blank text, so only real words count.
 */
export function meanWordConfidence(tsv: string): number | null {
  const lines = tsv.split(/\r?\n/);
  if (lines.length === 0) return null;
  const header = lines[0].split("\t");
  const iLevel = header.indexOf("level");
  const iConf = header.indexOf("conf");
  const iText = header.indexOf("text");
  if (iLevel < 0 || iConf < 0 || iText < 0) return null;

  let sum = 0;
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if (cells.length <= iText) continue;
    if (Number(cells[iLevel]) !== TSV_WORD_LEVEL) continue;
    if (!cells[iText].trim()) continue;
    const conf = Number(cells[iConf]);
    if (!Number.isFinite(conf) || conf < 0) continue;
    sum += conf;
    count++;
  }
  return count > 0 ? sum / count : null;
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
