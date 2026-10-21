/**
 * A text document written in the app, rendered from its Markdown to a PDF
 * with pdfkit (documents/text-documents.ts).
 *
 * The PDF is what the rest of the documents module sees: the preview, the
 * thumbnail, the text layer that text_extract reads, collection PDFs and
 * exports. The Markdown stays the source the editor opens. Both sides parse
 * with `marked` (GitHub flavour), so the PDF shows the same structure as the
 * preview in the browser: headings, paragraphs with bold, italic, code,
 * strikethrough and links, lists (nested, numbered, task lists), quotes, code
 * blocks, tables and rules. Raw HTML is printed as text and images as their
 * alt text — the server fetches nothing a document names.
 */

import PDFDocument from "pdfkit";
import { Lexer, type Token, type Tokens } from "marked";
import { normalizePdfText } from "../finance/pdf-report";

const MARGIN = 56;
const BODY_SIZE = 11;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 11] as const;
const LIST_INDENT = 16;
const QUOTE_INDENT = 14;
const MUTED = "#555555";
const LINK = "#1d4ed8";

interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

interface Box {
  x: number;
  width: number;
  color: string;
}

export interface MarkdownPdfInput {
  title: string;
  markdown: string;
}

/** Parses the Markdown the same way the editor preview does. */
export function markdownTokens(markdown: string): Token[] {
  return new Lexer({ gfm: true, breaks: false }).lex(markdown);
}

/** The plain text of a heading or paragraph token, for comparisons. */
function plainText(tokens: readonly Token[] | undefined): string {
  return inlineSegments(tokens).map((s) => s.text).join("").trim();
}

function safeLink(href: string): string | undefined {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

/** Flattens inline tokens into runs of equally formatted text. */
function inlineSegments(tokens: readonly Token[] | undefined, style: Omit<Segment, "text"> = {}): Segment[] {
  const out: Segment[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineSegments((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineSegments((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inlineSegments((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push({ ...style, code: true, text: decodeEntities((t as Tokens.Codespan).text) });
        break;
      case "link": {
        const link = t as Tokens.Link;
        out.push(...inlineSegments(link.tokens, { ...style, link: safeLink(link.href) }));
        break;
      }
      case "image":
        out.push({ ...style, italic: true, text: `[Bild: ${(t as Tokens.Image).text || "ohne Beschreibung"}]` });
        break;
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "text": {
        const text = t as Tokens.Text;
        if (text.tokens?.length) out.push(...inlineSegments(text.tokens, style));
        else out.push({ ...style, text: decodeEntities(text.text) });
        break;
      }
      default:
        // escape, html and anything newer: print what was written.
        out.push({ ...style, text: decodeEntities((t as { text?: string }).text ?? t.raw) });
    }
  }
  return out;
}

/** `marked` hands text through with HTML entities escaped; the PDF wants the characters. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function fontFor(seg: Pick<Segment, "bold" | "italic" | "code">): string {
  if (seg.code) return "Courier";
  if (seg.bold && seg.italic) return "Helvetica-BoldOblique";
  if (seg.bold) return "Helvetica-Bold";
  if (seg.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

class Renderer {
  private readonly pdf: PDFKit.PDFDocument;
  private page = 0;

  constructor(pdf: PDFKit.PDFDocument) {
    this.pdf = pdf;
    pdf.on("pageAdded", () => { this.page++; });
  }

  private get bottom(): number {
    return this.pdf.page.height - this.pdf.page.margins.bottom;
  }

  private ensureSpace(height: number): void {
    if (this.pdf.y + height > this.bottom) this.pdf.addPage();
  }

  /** Writes formatted runs as one flowing paragraph inside `box`. */
  private segments(segs: Segment[], box: Box, size: number, base: Omit<Segment, "text"> = {}): void {
    const runs = segs
      .map((s) => ({ ...base, ...s, text: normalizePdfText(s.text) }))
      .filter((s) => s.text.length > 0);
    if (runs.length === 0) return;
    this.ensureSpace(size * 1.4);
    const pdf = this.pdf;
    runs.forEach((run, i) => {
      pdf.font(fontFor(run)).fontSize(size).fillColor(run.link ? LINK : box.color);
      const opts: PDFKit.Mixins.TextOptions = {
        width: box.width,
        continued: i < runs.length - 1,
        strike: !!run.strike,
        underline: !!run.link,
        link: run.link ?? null,
        lineGap: 2,
      };
      if (i === 0) pdf.text(run.text, box.x, pdf.y, opts);
      else pdf.text(run.text, opts);
    });
    pdf.fillColor("#000000");
  }

  /** The document title, as plain text: Markdown in a title is not formatting. */
  title(text: string, box: Box): void {
    this.segments([{ text }], box, HEADING_SIZES[0], { bold: true });
    this.gap(0.35);
  }

  blocks(tokens: readonly Token[], box: Box): void {
    for (const token of tokens) this.block(token, box);
  }

  private gap(lines = 0.5): void {
    this.pdf.moveDown(lines);
  }

  private block(token: Token, box: Box): void {
    const pdf = this.pdf;
    switch (token.type) {
      case "space":
      case "def":
        return;
      case "heading": {
        const h = token as Tokens.Heading;
        const size = HEADING_SIZES[Math.min(h.depth, 6) - 1];
        this.ensureSpace(size * 3);
        if (pdf.y > pdf.page.margins.top + 1) this.gap(0.6);
        this.segments(inlineSegments(h.tokens), box, size, { bold: true });
        this.gap(0.35);
        return;
      }
      case "paragraph":
        this.segments(inlineSegments((token as Tokens.Paragraph).tokens), box, BODY_SIZE);
        this.gap();
        return;
      case "text": {
        // Block-level text: the content of a tight list item.
        const t = token as Tokens.Text;
        this.segments(t.tokens?.length ? inlineSegments(t.tokens) : [{ text: decodeEntities(t.text) }], box, BODY_SIZE);
        return;
      }
      case "list":
        this.list(token as Tokens.List, box);
        return;
      case "blockquote":
        this.quote(token as Tokens.Blockquote, box);
        return;
      case "code":
        this.code(token as Tokens.Code, box);
        return;
      case "table":
        this.table(token as Tokens.Table, box);
        return;
      case "hr": {
        this.ensureSpace(16);
        const y = pdf.y + 6;
        pdf.moveTo(box.x, y).lineTo(box.x + box.width, y).lineWidth(0.6).strokeColor("#999999").stroke();
        pdf.y = y + 10;
        return;
      }
      case "html":
        this.segments([{ text: (token as Tokens.HTML).text.trim() }], box, BODY_SIZE, { code: true });
        this.gap();
        return;
      default:
        this.segments([{ text: token.raw.trim() }], box, BODY_SIZE);
        this.gap();
    }
  }

  private list(list: Tokens.List, box: Box): void {
    const pdf = this.pdf;
    const start = typeof list.start === "number" ? list.start : 1;
    list.items.forEach((item, i) => {
      const marker = item.task
        ? item.checked ? "[x]" : "[ ]"
        : list.ordered ? `${start + i}.` : "•";
      const indent = item.task || list.ordered ? LIST_INDENT + 6 : LIST_INDENT;
      this.ensureSpace(BODY_SIZE * 1.4);
      const y = pdf.y;
      const page = this.page;
      pdf.font(item.task ? "Courier" : "Helvetica").fontSize(BODY_SIZE).fillColor(box.color)
        .text(marker, box.x, y, { width: indent, lineBreak: false });
      pdf.y = y;
      // A task item's text starts with the checkbox `marked` already read.
      const children = item.tokens.filter((t) => t.type !== "checkbox");
      this.blocks(children, { ...box, x: box.x + indent, width: box.width - indent });
      if (this.page === page && pdf.y < y + BODY_SIZE) pdf.y = y + BODY_SIZE * 1.3;
      if (list.loose) this.gap(0.3);
    });
    pdf.x = box.x;
    this.gap(list.loose ? 0.2 : 0.5);
  }

  private quote(quote: Tokens.Blockquote, box: Box): void {
    const pdf = this.pdf;
    this.ensureSpace(BODY_SIZE * 1.6);
    const top = pdf.y;
    const page = this.page;
    this.blocks(quote.tokens, { x: box.x + QUOTE_INDENT, width: box.width - QUOTE_INDENT, color: MUTED });
    // Across a page break the bar marks only the part on the last page.
    const barTop = this.page === page ? top : pdf.page.margins.top;
    const end = pdf.y - BODY_SIZE * 0.4;
    pdf.moveTo(box.x + 3, barTop).lineTo(box.x + 3, end).lineWidth(2).strokeColor("#bbbbbb").stroke();
    pdf.x = box.x;
  }

  private code(code: Tokens.Code, box: Box): void {
    const pdf = this.pdf;
    const text = normalizePdfText(code.text);
    const pad = 6;
    const width = box.width - 2 * pad;
    pdf.font("Courier").fontSize(BODY_SIZE - 1.5);
    const height = pdf.heightOfString(text || " ", { width, lineGap: 1 });
    const pageHeight = this.bottom - pdf.page.margins.top;
    if (height + 2 * pad <= pageHeight) this.ensureSpace(height + 2 * pad);
    const top = pdf.y;
    if (top + height + 2 * pad <= this.bottom) {
      pdf.rect(box.x, top, box.width, height + 2 * pad).fillColor("#f2f2f2").fill();
    }
    pdf.fillColor("#222222").font("Courier").fontSize(BODY_SIZE - 1.5)
      .text(text || " ", box.x + pad, top + pad, { width, lineGap: 1 });
    pdf.y += pad;
    pdf.x = box.x;
    pdf.fillColor("#000000");
    this.gap();
  }

  private table(table: Tokens.Table, box: Box): void {
    const pdf = this.pdf;
    const cols = table.header.length;
    if (cols === 0) return;
    const colWidth = box.width / cols;
    const pad = 4;
    const size = BODY_SIZE - 1;
    const cellText = (cell: Tokens.TableCell) => normalizePdfText(plainText(cell.tokens) || " ");
    const align = (i: number): "left" | "center" | "right" => table.align[i] ?? "left";

    const drawRow = (cells: Tokens.TableCell[], bold: boolean) => {
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      const height = Math.max(
        ...cells.map((c) => pdf.heightOfString(cellText(c), { width: colWidth - 2 * pad })),
      ) + 2 * pad;
      this.ensureSpace(height);
      const top = pdf.y;
      if (bold) pdf.rect(box.x, top, box.width, height).fillColor("#eeeeee").fill();
      cells.forEach((cell, i) => {
        pdf.fillColor("#000000").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
          .text(cellText(cell), box.x + i * colWidth + pad, top + pad, {
            width: colWidth - 2 * pad,
            align: align(i),
          });
      });
      pdf.rect(box.x, top, box.width, height).lineWidth(0.5).strokeColor("#bbbbbb").stroke();
      for (let i = 1; i < cols; i++) {
        pdf.moveTo(box.x + i * colWidth, top).lineTo(box.x + i * colWidth, top + height).stroke();
      }
      pdf.y = top + height;
    };

    drawRow(table.header, true);
    for (const row of table.rows) drawRow(row, false);
    pdf.x = box.x;
    this.gap();
  }
}

/**
 * Renders the document. The title opens the first page, unless the Markdown
 * starts with a top-level heading saying the same thing.
 */
export function renderMarkdownPdf({ title, markdown }: MarkdownPdfInput): Promise<Buffer> {
  const cleanTitle = title.trim();
  const pdf = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: { Title: normalizePdfText(cleanTitle), Creator: "F4mil" },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const tokens = markdownTokens(markdown);
  const first = tokens.find((t) => t.type !== "space");
  const repeatsTitle = first?.type === "heading"
    && (first as Tokens.Heading).depth === 1
    && plainText((first as Tokens.Heading).tokens) === cleanTitle;
  const box: Box = { x: MARGIN, width: pdf.page.width - 2 * MARGIN, color: "#000000" };
  const renderer = new Renderer(pdf);
  if (cleanTitle && !repeatsTitle) {
    renderer.title(cleanTitle.replace(/\s+/g, " "), box);
  }
  renderer.blocks(tokens, box);
  if (tokens.every((t) => t.type === "space") && !cleanTitle) pdf.text(" ");
  pdf.end();
  return done;
}
