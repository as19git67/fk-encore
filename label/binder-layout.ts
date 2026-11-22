/**
 * Binder labels ("Ordneretiketten"): the layout of an A4 sheet with four
 * wide spine labels of 192 × 61 mm, and of the Markdown text on each.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `label/binder-layout.ts` (the PDF,
 * label/binder-sheet.ts) and `frontend/src/utils/binderLayout.ts` (the
 * preview). `label/binder.test.ts` fails when they differ. Both sides lay the
 * text out with this code and differ only in how they measure a word (pdfkit
 * on the server, a canvas in the browser, both with Roboto), so the preview
 * breaks lines where the PDF does.
 *
 * The sheet carries one label per row, edge to edge: 4 × 61 mm = 244 mm,
 * leaving 26.5 mm at top and bottom, and 192 mm across, leaving 9 mm left
 * and right (Avery Zweckform L4761 and the REX sheets of the same size).
 *
 * A label holds a little Markdown: headings (`#`, `##`, `###`) for the big
 * words on the spine, paragraphs with **bold**, *italic* and ~~strike~~,
 * lists and rules (`---`). A single line break is a line break: on a label
 * every line is meant where it is. A word wider than the label sets its
 * whole paragraph smaller instead of being cut, down to `MIN_SIZE`.
 *
 * Two directions:
 *   - `across`: readable while the file stands on the shelf. The text runs
 *     across the 61 mm of the spine; on the sheet it is turned a quarter to
 *     the left, so the top of the text is the left end of the label.
 *   - `along`: the text runs along the 192 mm, as it lies on the sheet.
 * Text starts at the top of a standing label and is centred vertically on a
 * lying one. What does not fit is cut at the edge of the label.
 */

import { Lexer, type Token, type Tokens } from "marked";

export const BINDER_SHEET = {
  name: "Ordneretiketten 192 × 61 mm",
  labels: 4,
  pageWidthPt: 595.28,
  pageHeightPt: 841.89,
  labelWidthMm: 192,
  labelHeightMm: 61,
  marginLeftMm: 9,
  marginTopMm: 26.5,
  rowGapMm: 0,
  paddingMm: 4,
} as const;

/** Font sizes and spacing in pt. */
export const BINDER_TEXT = {
  body: 14,
  headings: [30, 22, 17, 14, 14, 14] as const,
  /** Smallest size a paragraph shrinks to for a long word. */
  minSize: 8,
  /** Line height as a multiple of the font size. */
  lineHeight: 1.25,
  /** Space after a block, as a share of its font size. */
  blockGap: 0.35,
  listIndent: 14,
  /** Roboto's ascender and descender in em, to place the baseline in a line. */
  ascent: 0.928,
  descent: 0.244,
} as const;

export const MAX_LABEL_TEXT = 2000;

export type BinderDirection = "across" | "along";
export type BinderAlign = "left" | "center";

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
}

/** Width of `text` in pt at `size` pt in the given style. */
export type MeasureText = (text: string, style: TextStyle, size: number) => number;

const PT_PER_MM = 72 / 25.4;

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

export interface BinderLabelBox {
  index: number;
  /** Top-left corner on the sheet in pt, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the four labels sit on the sheet. */
export function layoutBinderSheet(): BinderLabelBox[] {
  const width = mmToPt(BINDER_SHEET.labelWidthMm);
  const height = mmToPt(BINDER_SHEET.labelHeightMm);
  const pitch = mmToPt(BINDER_SHEET.labelHeightMm + BINDER_SHEET.rowGapMm);
  const left = mmToPt(BINDER_SHEET.marginLeftMm);
  const top = mmToPt(BINDER_SHEET.marginTopMm);
  return Array.from({ length: BINDER_SHEET.labels }, (_, index) => ({
    index,
    x: left,
    y: top + index * pitch,
    width,
    height,
  }));
}

/** The text area of a label in its own upright frame, in pt. */
export function contentFrame(direction: BinderDirection): { width: number; height: number } {
  const pad = 2 * mmToPt(BINDER_SHEET.paddingMm);
  const long = mmToPt(BINDER_SHEET.labelWidthMm) - pad;
  const short = mmToPt(BINDER_SHEET.labelHeightMm) - pad;
  return direction === "across" ? { width: short, height: long } : { width: long, height: short };
}

// ---------- Markdown → blocks ----------

export interface Run extends TextStyle {
  text: string;
  strike?: boolean;
}

export interface Block {
  runs: Run[];
  size: number;
  /** A list marker ("•", "1.") hung in front of the text. */
  marker?: string;
  /** A horizontal rule instead of text. */
  rule?: boolean;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function inlineRuns(tokens: readonly Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inlineRuns((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "link":
        out.push(...inlineRuns((t as Tokens.Link).tokens, style));
        break;
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "text": {
        const text = t as Tokens.Text;
        if (text.tokens?.length) out.push(...inlineRuns(text.tokens, style));
        else out.push({ ...style, text: decodeEntities(text.text) });
        break;
      }
      default:
        // codespan, escape, html, image: print what was written.
        out.push({ ...style, text: decodeEntities((t as { text?: string }).text ?? t.raw) });
    }
  }
  return out;
}

/**
 * The label's Markdown as a flat list of blocks. Quotes print as their
 * text, tables as their cells in a line: a spine has no room for more.
 */
export function binderBlocks(markdown: string): Block[] {
  const out: Block[] = [];
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
          break;
        case "heading": {
          const h = token as Tokens.Heading;
          const size = BINDER_TEXT.headings[Math.min(Math.max(h.depth, 1), 6) - 1] ?? BINDER_TEXT.body;
          out.push({ runs: inlineRuns(h.tokens, { bold: true }), size });
          break;
        }
        case "paragraph":
          out.push({ runs: inlineRuns((token as Tokens.Paragraph).tokens), size: BINDER_TEXT.body });
          break;
        case "text": {
          const t = token as Tokens.Text;
          out.push({
            runs: t.tokens?.length ? inlineRuns(t.tokens) : [{ text: decodeEntities(t.text) }],
            size: BINDER_TEXT.body,
          });
          break;
        }
        case "list": {
          const list = token as Tokens.List;
          const start = typeof list.start === "number" ? list.start : 1;
          list.items.forEach((item, i) => {
            const marker = list.ordered ? `${start + i}.` : "•";
            const runs: Run[] = [];
            for (const child of item.tokens) {
              if (child.type !== "text" && child.type !== "paragraph") continue;
              const c = child as Tokens.Text;
              if (runs.length) runs.push({ text: "\n" });
              runs.push(...(c.tokens?.length ? inlineRuns(c.tokens) : [{ text: decodeEntities(c.text) }]));
            }
            out.push({ runs, size: BINDER_TEXT.body, marker });
          });
          break;
        }
        case "blockquote":
          walk((token as Tokens.Blockquote).tokens);
          break;
        case "hr":
          out.push({ runs: [], size: BINDER_TEXT.body, rule: true });
          break;
        case "table": {
          const table = token as Tokens.Table;
          for (const row of [table.header, ...table.rows]) {
            const cells = row.map((cell) => inlineRuns(cell.tokens).map((r) => r.text).join(""));
            out.push({ runs: [{ text: cells.join("  ") }], size: BINDER_TEXT.body });
          }
          break;
        }
        default: {
          const text = decodeEntities((token as { text?: string }).text ?? token.raw).trim();
          out.push({ runs: [{ text }], size: BINDER_TEXT.body });
        }
      }
    }
  };
  walk(new Lexer({ gfm: true, breaks: true }).lex(markdown));
  return out
    .map((b) => ({ ...b, runs: b.runs.filter((r) => r.text.length > 0) }))
    .filter((b) => b.rule || b.runs.length > 0);
}

// ---------- Blocks → lines ----------

/** Text drawn at one place in one style; `x` and `baseline` in the frame. */
export interface Piece extends TextStyle {
  text: string;
  x: number;
  width: number;
  baseline: number;
  size: number;
  strike?: boolean;
}

export interface Rule {
  y: number;
}

export interface LabelLayout {
  pieces: Piece[];
  rules: Rule[];
  /** Height of the text from its first line to its last, in pt. */
  height: number;
  /** True when the text is taller than the label and gets cut. */
  overflow: boolean;
}

interface Atom extends TextStyle {
  kind: "word" | "space" | "break";
  text: string;
  strike?: boolean;
}

function atomsOf(runs: Run[]): Atom[] {
  const atoms: Atom[] = [];
  for (const run of runs) {
    const style = { bold: run.bold, italic: run.italic, strike: run.strike };
    for (const part of run.text.split(/(\n| +)/)) {
      if (!part) continue;
      if (part === "\n") atoms.push({ ...style, kind: "break", text: "" });
      else if (part.trim() === "") atoms.push({ ...style, kind: "space", text: " " });
      else atoms.push({ ...style, kind: "word", text: part });
    }
  }
  return atoms;
}

function sameStyle(a: TextStyle & { strike?: boolean }, b: TextStyle & { strike?: boolean }): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike;
}

/** The block's size, made smaller until its widest word fits. */
function fittedSize(atoms: Atom[], size: number, width: number, measure: MeasureText): number {
  let widest = 0;
  for (const a of atoms) if (a.kind === "word") widest = Math.max(widest, measure(a.text, a, size));
  if (widest <= width || widest === 0) return size;
  const fitted = Math.floor(((size * width) / widest) * 2) / 2;
  return Math.max(BINDER_TEXT.minSize, Math.min(size, fitted));
}

/** Splits a word that is wider than the line even at the smallest size. */
function splitWord(atom: Atom, size: number, width: number, measure: MeasureText): Atom[] {
  const parts: Atom[] = [];
  let current = "";
  for (const char of Array.from(atom.text)) {
    if (current && measure(current + char, atom, size) > width) {
      parts.push({ ...atom, text: current });
      current = char;
    } else {
      current += char;
    }
  }
  if (current) parts.push({ ...atom, text: current });
  return parts;
}

interface LineItem extends TextStyle {
  text: string;
  width: number;
  strike?: boolean;
}

/** Breaks the atoms into lines of at most `width`. */
function breakLines(atoms: Atom[], size: number, width: number, measure: MeasureText): LineItem[][] {
  const lines: LineItem[][] = [[]];
  let lineWidth = 0;
  let space: Atom | null = null;
  const words: Atom[] = [];
  for (const a of atoms) {
    if (a.kind === "word" && measure(a.text, a, size) > width) words.push(...splitWord(a, size, width, measure));
    else words.push(a);
  }
  for (const a of words) {
    const line = lines[lines.length - 1]!;
    if (a.kind === "break") {
      lines.push([]);
      lineWidth = 0;
      space = null;
      continue;
    }
    if (a.kind === "space") {
      if (line.length) space = a;
      continue;
    }
    const w = measure(a.text, a, size);
    const spaceWidth = space && line.length ? measure(" ", space, size) : 0;
    if (line.length && lineWidth + spaceWidth + w > width) {
      lines.push([{ text: a.text, width: w, bold: a.bold, italic: a.italic, strike: a.strike }]);
      lineWidth = w;
      space = null;
      continue;
    }
    if (spaceWidth) {
      const last = line[line.length - 1]!;
      if (sameStyle(last, space!)) {
        last.text += " ";
        last.width += spaceWidth;
      } else {
        line.push({ text: " ", width: spaceWidth, bold: space!.bold, italic: space!.italic, strike: space!.strike });
      }
      lineWidth += spaceWidth;
    }
    const last = line[line.length - 1];
    if (last && sameStyle(last, a)) {
      last.text += a.text;
      last.width += w;
    } else {
      line.push({ text: a.text, width: w, bold: a.bold, italic: a.italic, strike: a.strike });
    }
    lineWidth += w;
    space = null;
  }
  return lines;
}

/** Where the baseline sits in a line that starts at `top`. */
function baselineOf(top: number, size: number): number {
  const lineHeight = size * BINDER_TEXT.lineHeight;
  const content = size * (BINDER_TEXT.ascent + BINDER_TEXT.descent);
  return top + (lineHeight - content) / 2 + size * BINDER_TEXT.ascent;
}

/**
 * Lays out one label: every piece of text with its position in the
 * label's upright frame (see `contentFrame`), ready to draw.
 */
export function layoutLabel(
  markdown: string,
  direction: BinderDirection,
  align: BinderAlign,
  measure: MeasureText,
): LabelLayout {
  const frame = contentFrame(direction);
  const blocks = binderBlocks(markdown);
  const pieces: Piece[] = [];
  const rules: Rule[] = [];
  let y = 0;
  blocks.forEach((block, bi) => {
    const last = bi === blocks.length - 1;
    if (block.rule) {
      y += block.size * 0.4;
      rules.push({ y });
      y += block.size * 0.4 + (last ? 0 : block.size * BINDER_TEXT.blockGap);
      return;
    }
    const indent = block.marker ? BINDER_TEXT.listIndent : 0;
    const width = frame.width - indent;
    const atoms = atomsOf(block.runs);
    const size = fittedSize(atoms, block.size, width, measure);
    const lineHeight = size * BINDER_TEXT.lineHeight;
    if (block.marker) {
      pieces.push({ text: block.marker, x: 0, width: measure(block.marker, {}, size), baseline: baselineOf(y, size), size });
    }
    for (const line of breakLines(atoms, size, width, measure)) {
      const lineWidth = line.reduce((sum, item) => sum + item.width, 0);
      let x = indent + (align === "center" && !block.marker ? Math.max(0, (width - lineWidth) / 2) : 0);
      for (const item of line) {
        pieces.push({ ...item, x, baseline: baselineOf(y, size), size });
        x += item.width;
      }
      y += lineHeight;
    }
    if (!last) y += size * BINDER_TEXT.blockGap;
  });
  const height = y;
  // A lying label centres its text; a standing one starts at the top.
  const shift = direction === "along" ? Math.max(0, (frame.height - height) / 2) : 0;
  if (shift) {
    for (const p of pieces) p.baseline += shift;
    for (const r of rules) r.y += shift;
  }
  return { pieces, rules, height, overflow: height > frame.height + 0.5 };
}
