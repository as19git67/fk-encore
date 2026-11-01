/**
 * Turns a planned demo document into a PDF (documentation/plans/demodaten.md,
 * stage 2). The layout is built once as a list of drawing operations per
 * page, in PDF points; the same list is drawn by pdfkit (a PDF with a text
 * layer) or, for the one in ten that is a "scan", as an SVG that sharp
 * rasterises, turns slightly and roughens — a PDF of a picture with no text
 * layer, so text extraction has to go through OCR.
 */

import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { Random } from "./random";
import {
  euro,
  germanDate,
  recipientBlock,
  salutation,
  type PlannedDocument,
} from "./documents";

const A4 = { width: 595.28, height: 841.89 };
const RECEIPT_WIDTH = 226.77; // 80 mm
const MARGIN = 56.69; // 20 mm
const LEFT = 70.87; // 25 mm (DIN 5008)

type Op =
  | { t: "text"; x: number; y: number; s: string; size: number; bold?: boolean; color?: string }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; width?: number; color?: string }
  | { t: "rect"; x: number; y: number; w: number; h: number; fill: string };

export interface Page {
  width: number;
  height: number;
  ops: Op[];
}

/** The texts a document is drawn with: the template's or the model's. */
export interface DocTexts {
  subject: string;
  paragraphs: string[];
  lineTexts: string[];
}

export function templateTexts(doc: PlannedDocument): DocTexts {
  return { subject: doc.subject, paragraphs: doc.paragraphs, lineTexts: doc.lines.map((l) => l.text) };
}

/** Measures Helvetica the way pdfkit draws it, so lines wrap and right-align alike in both outputs. */
class Measure {
  private doc = new PDFDocument({ autoFirstPage: false });
  width(s: string, size: number, bold = false): number {
    this.doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    return this.doc.widthOfString(s);
  }
  wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
    const out: string[] = [];
    let line = "";
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.width(next, size, bold) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
    return out;
  }
}

const ACCENTS = ["#1f4e79", "#7a2e2e", "#2e5e3a"];

class Layout {
  pages: Page[] = [];
  page!: Page;
  y = 0;
  constructor(private m: Measure, private width: number, private height: number) {
    this.newPage();
  }
  newPage(): void {
    this.page = { width: this.width, height: this.height, ops: [] };
    this.pages.push(this.page);
    this.y = MARGIN;
  }
  ensure(space: number): void {
    if (this.y + space > this.height - MARGIN) this.newPage();
  }
  text(x: number, y: number, s: string, size: number, bold = false, color?: string): void {
    this.page.ops.push({ t: "text", x, y, s, size, bold, color });
  }
  right(xRight: number, y: number, s: string, size: number, bold = false): void {
    this.text(xRight - this.m.width(s, size, bold), y, s, size, bold);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color = "#555555"): void {
    this.page.ops.push({ t: "line", x1, y1, x2, y2, width, color });
  }
  rect(x: number, y: number, w: number, h: number, fill: string): void {
    this.page.ops.push({ t: "rect", x, y, w, h, fill });
  }
  paragraph(s: string, size: number, x: number, maxWidth: number): void {
    for (const l of this.m.wrap(s, size, maxWidth)) {
      this.ensure(size * 1.4);
      this.text(x, this.y, l, size);
      this.y += size * 1.4;
    }
  }
}

function letterHead(L: Layout, doc: PlannedDocument): void {
  const accent = ACCENTS[doc.layout];
  const right = A4.width - MARGIN;
  if (doc.layout === 0) {
    L.text(LEFT, 40, doc.sender, 16, true, accent);
    L.text(LEFT, 60, doc.senderAddress, 8);
  } else if (doc.layout === 1) {
    L.rect(0, 0, A4.width, 70, accent);
    L.text(LEFT, 26, doc.sender, 18, true, "#ffffff");
  } else {
    L.right(right, 40, doc.sender, 15, true);
    L.right(right, 58, doc.senderAddress, 8);
    L.line(LEFT, 72, right, 72, 1, accent);
  }
  // DIN 5008 address window: sender line, then the recipient.
  L.text(LEFT, 128, `${doc.sender} · ${doc.senderAddress}`, 6.5);
  L.line(LEFT, 137, LEFT + 240, 137, 0.3);
  recipientBlock(doc.recipient).forEach((l, i) => L.text(LEFT, 146 + i * 13, l, 10));

  // Info block on the right.
  const infoX = 330;
  const info = [...doc.references.map((r) => [r.label, r.value]), ["Datum", germanDate(doc.date)]];
  info.forEach(([k, v], i) => {
    L.text(infoX, 128 + i * 12, `${k}:`, 8);
    L.text(infoX + 70, 128 + i * 12, v, 8);
  });
  L.y = Math.max(250, 140 + info.length * 12 + 20);
}

function footer(L: Layout, doc: PlannedDocument): void {
  for (const p of L.pages) {
    p.ops.push({ t: "line", x1: LEFT, y1: A4.height - 50, x2: A4.width - MARGIN, y2: A4.height - 50, width: 0.3, color: "#888888" });
    p.ops.push({ t: "text", x: LEFT, y: A4.height - 44, s: `${doc.sender} · ${doc.senderAddress} · Demodaten`, size: 6.5, color: "#666666" });
  }
}

function lineTable(L: Layout, doc: PlannedDocument, texts: DocTexts): void {
  if (!doc.lines.length) return;
  const right = A4.width - MARGIN;
  L.ensure(30);
  L.y += 6;
  L.text(LEFT, L.y, "Position", 9, true);
  L.right(right, L.y, "Betrag", 9, true);
  L.y += 13;
  L.line(LEFT, L.y, right, L.y);
  L.y += 5;
  doc.lines.forEach((l, i) => {
    L.ensure(14);
    L.text(LEFT, L.y, texts.lineTexts[i] ?? l.text, 9.5);
    if (l.cents !== null) L.right(right, L.y, euro(l.cents), 9.5);
    L.y += 14;
  });
  if (doc.totalCents !== null) {
    L.line(LEFT + 260, L.y, right, L.y);
    L.y += 5;
    const label = doc.kind === "payslip" ? "Auszahlungsbetrag" : doc.kind === "utility_bill" ? (doc.totalCents < 0 ? "Guthaben" : "Nachzahlung") : "Gesamtbetrag";
    L.text(LEFT + 260, L.y, label, 10, true);
    L.right(right, L.y, euro(Math.abs(doc.totalCents)), 10, true);
    L.y += 18;
  }
}

/** Label and value per line, the way a settlement prints them. */
function facts(L: Layout, doc: PlannedDocument): void {
  if (!doc.facts.length) return;
  L.y += 4;
  for (const f of doc.facts) {
    L.ensure(14);
    L.text(LEFT, L.y, f.label, 9.5);
    L.text(LEFT + 170, L.y, f.value, 9.5, f.label === "Ausmachender Betrag" || f.label === "Betrag zu Ihren Gunsten");
    L.y += 14;
  }
  L.y += 6;
}

/**
 * The holdings of a depot statement, one block per security: name,
 * identifier, then quantity, price and value each with its label, the
 * way many banks print a statement in list form.
 */
function positions(L: Layout, doc: PlannedDocument): void {
  if (!doc.positions?.length) return;
  const right = A4.width - MARGIN;
  L.y += 4;
  L.text(LEFT, L.y, "Depotbestand", 10, true);
  L.y += 14;
  L.line(LEFT, L.y, right, L.y);
  L.y += 6;
  for (const p of doc.positions) {
    L.ensure(46);
    L.text(LEFT, L.y, p.name, 9.5, true);
    L.y += 13;
    L.text(LEFT, L.y, `ISIN ${p.isin}`, 9);
    L.y += 12;
    L.text(LEFT, L.y, `Stück ${p.quantity.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`, 9);
    L.text(LEFT + 130, L.y, `Kurs ${p.price.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} EUR`, 9);
    L.text(LEFT + 280, L.y, `Kurswert ${euro(p.valueCents).replace(" €", " EUR")}`, 9);
    L.y += 18;
  }
}

function letter(m: Measure, doc: PlannedDocument, texts: DocTexts): Page[] {
  const L = new Layout(m, A4.width, A4.height);
  const width = A4.width - MARGIN - LEFT;
  letterHead(L, doc);
  for (const l of m.wrap(texts.subject, 11, width, true)) {
    L.text(LEFT, L.y, l, 11, true);
    L.y += 15;
  }
  L.y += 10;
  const formal = doc.kind !== "wage_tax_certificate" && doc.kind !== "donation_receipt";
  if (formal) {
    L.paragraph(salutation(doc.recipient), 10, LEFT, width);
    L.y += 4;
  }
  for (const p of texts.paragraphs) {
    L.paragraph(p, 10, LEFT, width);
    L.y += 6;
  }
  lineTable(L, doc, texts);
  facts(L, doc);
  positions(L, doc);
  if (formal) {
    L.y += 10;
    L.paragraph("Mit freundlichen Grüßen", 10, LEFT, width);
    L.paragraph(doc.sender, 10, LEFT, width);
  }
  footer(L, doc);
  return L.pages;
}

function statement(m: Measure, doc: PlannedDocument): Page[] {
  const st = doc.statement!;
  const L = new Layout(m, A4.width, A4.height);
  const right = A4.width - MARGIN;
  letterHead(L, doc);
  L.text(LEFT, L.y, doc.subject, 11, true);
  L.y += 20;
  const head = () => {
    L.text(LEFT, L.y, "Buchung", 8.5, true);
    L.text(LEFT + 60, L.y, "Vorgang", 8.5, true);
    L.right(right, L.y, "Betrag", 8.5, true);
    L.y += 12;
    L.line(LEFT, L.y, right, L.y);
    L.y += 4;
  };
  head();
  L.text(LEFT + 60, L.y, "Alter Kontostand", 9);
  L.right(right, L.y, euro(st.opening), 9);
  L.y += 13;
  for (const r of st.rows) {
    const wrapped = m.wrap(r.text, 8.5, right - LEFT - 150);
    if (L.y + wrapped.length * 11 > A4.height - MARGIN - 20) {
      L.newPage();
      L.y = 70;
      head();
    }
    L.text(LEFT, L.y, germanDate(r.date).slice(0, 6), 8.5);
    wrapped.forEach((w, i) => L.text(LEFT + 60, L.y + i * 11, w, 8.5));
    L.right(right, L.y, euro(r.cents), 8.5);
    L.y += wrapped.length * 11 + 3;
  }
  L.ensure(30);
  L.line(LEFT, L.y, right, L.y);
  L.y += 5;
  L.text(LEFT + 60, L.y, "Neuer Kontostand", 9.5, true);
  L.right(right, L.y, euro(st.closing), 9.5, true);
  footer(L, doc);
  return L.pages;
}

function receipt(m: Measure, doc: PlannedDocument, texts: DocTexts): Page[] {
  const height = 200 + doc.lines.length * 13;
  const L = new Layout(m, RECEIPT_WIDTH, height);
  const center = (y: number, s: string, size: number, bold = false) => L.text((RECEIPT_WIDTH - m.width(s, size, bold)) / 2, y, s, size, bold);
  const right = RECEIPT_WIDTH - 14;
  center(20, doc.sender, 11, true);
  center(36, doc.senderAddress, 6.5);
  L.y = 60;
  doc.lines.forEach((l, i) => {
    L.text(14, L.y, texts.lineTexts[i] ?? l.text, 8.5);
    L.right(right, L.y, euro(l.cents ?? 0), 8.5);
    L.y += 13;
  });
  L.line(14, L.y, right, L.y, 0.5);
  L.y += 6;
  L.text(14, L.y, "SUMME", 10, true);
  L.right(right, L.y, euro(doc.totalCents ?? 0), 10, true);
  L.y += 18;
  L.text(14, L.y, "Kartenzahlung girocard", 8);
  L.y += 12;
  L.text(14, L.y, `${germanDate(doc.date)}  ${doc.references[0]?.label ?? ""} ${doc.references[0]?.value ?? ""}`, 8);
  L.y += 18;
  center(L.y, texts.paragraphs[0] ?? "Vielen Dank!", 8);
  return L.pages;
}

/** The pages of a document, laid out. */
export function layoutDocument(doc: PlannedDocument, texts: DocTexts = templateTexts(doc)): Page[] {
  const m = new Measure();
  if (doc.kind === "bank_statement") return statement(m, doc);
  if (doc.kind === "receipt") return receipt(m, doc, texts);
  return letter(m, doc, texts);
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/** A PDF with a text layer. `title` goes into the PDF's metadata only. */
export async function renderPdf(pages: Page[], title: string): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: title, Producer: "FK-Encore Demodaten" } });
  const done = collect(doc);
  for (const p of pages) {
    doc.addPage({ size: [p.width, p.height], margin: 0 });
    for (const op of p.ops) {
      if (op.t === "rect") doc.rect(op.x, op.y, op.w, op.h).fill(op.fill);
      else if (op.t === "line") doc.moveTo(op.x1, op.y1).lineTo(op.x2, op.y2).lineWidth(op.width ?? 0.5).stroke(op.color ?? "#555555");
      else doc.font(op.bold ? "Helvetica-Bold" : "Helvetica").fontSize(op.size).fillColor(op.color ?? "#111111").text(op.s, op.x, op.y, { lineBreak: false });
    }
  }
  doc.end();
  return done;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The page as SVG, at `scale` pixels per point. */
export function pageSvg(p: Page, scale: number): string {
  const parts: string[] = [];
  for (const op of p.ops) {
    if (op.t === "rect") parts.push(`<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" fill="${op.fill}"/>`);
    else if (op.t === "line") parts.push(`<line x1="${op.x1}" y1="${op.y1}" x2="${op.x2}" y2="${op.y2}" stroke="${op.color ?? "#555555"}" stroke-width="${op.width ?? 0.5}"/>`);
    // pdfkit places text by its top, SVG by its baseline.
    else parts.push(`<text x="${op.x}" y="${(op.y + op.size * 0.78).toFixed(2)}" font-family="Helvetica, Arial, Liberation Sans, DejaVu Sans, sans-serif" font-size="${op.size}"${op.bold ? ' font-weight="bold"' : ""} fill="${op.color ?? "#111111"}">${escapeXml(op.s)}</text>`);
  }
  const w = Math.round(p.width * scale);
  const h = Math.round(p.height * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${p.width} ${p.height}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
}

/**
 * The first page as a scan: rasterised at 150 dpi, turned by up to 1.5°,
 * greyed and roughened with noise, placed as the only content of a PDF.
 */
export async function renderScanPdf(pages: Page[], rnd: Random, title: string): Promise<Buffer> {
  const p = pages[0];
  const scale = 150 / 72;
  const angle = (rnd.next() * 3 - 1.5);
  const base = await sharp(Buffer.from(pageSvg(p, scale)))
    .rotate(angle, { background: "#f4f2ec" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  const px = base.data;
  for (let i = 0; i < px.length; i++) {
    const noise = (rnd.next() - 0.5) * 28;
    px[i] = Math.max(0, Math.min(255, px[i] * 0.94 + 6 + noise));
  }
  const jpeg = await sharp(px, { raw: { width, height, channels: base.info.channels } }).jpeg({ quality: 70 }).toBuffer();

  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: title, Producer: "Scanner" } });
  const done = collect(doc);
  doc.addPage({ size: [p.width, p.height], margin: 0 });
  doc.image(jpeg, 0, 0, { width: p.width, height: p.height });
  doc.end();
  return done;
}
