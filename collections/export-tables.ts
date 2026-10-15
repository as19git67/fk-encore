/**
 * Tables written as CSV, Excel or PDF (#1548, stage 6).
 *
 * Transactions, securities and meter readings are all rows under a header,
 * sometimes in sections (one per account, one per meter) with a sum at the
 * end. Each exporter builds that shape once; this file writes it in the
 * format the user picked.
 *
 * - CSV: one header and every row, machine-readable (ISO dates, a dot as the
 *   decimal sign, UTF-8 with BOM so Excel reads umlauts). Sections are not
 *   repeated; the columns already say which account a row belongs to.
 * - Excel: one sheet per section, numbers as numbers, the sum as a formula-free
 *   last row.
 * - PDF: German formatting, a heading per section, the sum under it, and a
 *   note on top (e.g. that a selection is not a bank statement).
 */

import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { normalizePdfText } from "../finance/pdf-report";
import type { TableFormat } from "./export-options";

export type CellKind = "text" | "date" | "number" | "money";

export interface TableColumn {
  label: string;
  kind: CellKind;
  /** Relative width in the PDF; defaults to 1 (2 for text). */
  weight?: number;
}

export type Cell = string | number | null;

export interface TableSection {
  /** Heading of the section; the sheet name in Excel. */
  title: string;
  rows: Cell[][];
  /** A closing line, e.g. ["Summe", null, …, 123.45]. */
  footer?: Cell[];
}

export interface TableDocument {
  title: string;
  /** One or two sentences under the title (PDF only). */
  note?: string;
  columns: TableColumn[];
  sections: TableSection[];
  /** A last line over all sections (PDF and Excel). */
  total?: Cell[];
}

export interface RenderedFile {
  bytes: Buffer;
  mime: string;
  ext: string;
}

const MIME: Record<TableFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export async function renderTable(doc: TableDocument, format: TableFormat): Promise<RenderedFile> {
  const bytes =
    format === "csv" ? renderCsv(doc) : format === "xlsx" ? await renderXlsx(doc) : await renderPdf(doc);
  return { bytes, mime: MIME[format], ext: format };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** RFC 4180: quotes when needed, inner quotes doubled. */
export function csvEscapeField(value: string): string {
  return /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvCell(value: Cell): string {
  if (value === null) return "";
  return csvEscapeField(typeof value === "number" ? String(value) : value);
}

export function renderCsv(doc: TableDocument): Buffer {
  const lines = [doc.columns.map((c) => csvEscapeField(c.label)).join(",")];
  for (const section of doc.sections) {
    for (const row of section.rows) lines.push(row.map(csvCell).join(","));
  }
  return Buffer.from("﻿" + lines.join("\n") + "\n", "utf8");
}

// ─── Excel ──────────────────────────────────────────────────────────────────

/** Excel allows 31 characters and none of []:*?/\ in a sheet name. */
export function sheetName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[[\]:*?/\\]/g, "-").trim().slice(0, 28) || "Tabelle";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 26)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

function excelValue(value: Cell, kind: CellKind): ExcelJS.CellValue {
  if (value === null) return null;
  if (kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
  }
  return value;
}

async function renderXlsx(doc: TableDocument): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "F4mil";
  const taken = new Set<string>();
  const sections = doc.sections.length > 0 ? doc.sections : [{ title: doc.title, rows: [] }];
  for (const section of sections) {
    const sheet = book.addWorksheet(sheetName(section.title, taken));
    sheet.columns = doc.columns.map((c) => ({
      header: c.label,
      width: c.kind === "text" ? 32 : 14,
      style:
        c.kind === "money"
          ? { numFmt: "#,##0.00" }
          : c.kind === "date"
            ? { numFmt: "dd.mm.yyyy" }
            : {},
    }));
    sheet.getRow(1).font = { bold: true };
    for (const row of section.rows) sheet.addRow(row.map((v, i) => excelValue(v, doc.columns[i]!.kind)));
    if (section.footer) sheet.addRow(section.footer.map((v, i) => excelValue(v, doc.columns[i]!.kind))).font = { bold: true };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ─── PDF ────────────────────────────────────────────────────────────────────

const de = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deNum = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });

export function formatPdfCell(value: Cell, kind: CellKind): string {
  if (value === null || value === "") return "";
  if (kind === "money" && typeof value === "number") return de.format(value);
  if (kind === "number" && typeof value === "number") return deNum.format(value);
  if (kind === "date" && typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  return String(value);
}

async function renderPdf(doc: TableDocument): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  const left = pdf.page.margins.left;
  const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const weights = doc.columns.map((c) => c.weight ?? (c.kind === "text" ? 2 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * width);
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const text = (v: string) => normalizePdfText(v);

  pdf.font("Helvetica-Bold").fontSize(16).text(text(doc.title), left, pdf.y);
  pdf.font("Helvetica").fontSize(9).fillColor("#555555"); // audit-ok: print colours
  pdf.text(text(`Erstellt am ${formatPdfCell(new Date().toISOString().slice(0, 10), "date")}`));
  if (doc.note) pdf.moveDown(0.3).text(text(doc.note), { width });
  pdf.fillColor("#000000").moveDown(0.8);

  const drawRow = (cells: Cell[], bold: boolean) => {
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    const strings = cells.map((v, i) => text(formatPdfCell(v, doc.columns[i]!.kind)));
    const height = Math.max(
      12,
      ...strings.map((s, i) => pdf.heightOfString(s, { width: widths[i]! - 6 }) + 3),
    );
    if (pdf.y + height > bottom()) {
      pdf.addPage();
      drawHeader();
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    }
    const y = pdf.y;
    let x = left;
    strings.forEach((s, i) => {
      const kind = doc.columns[i]!.kind;
      pdf.text(s, x + 3, y, {
        width: widths[i]! - 6,
        align: kind === "money" || kind === "number" ? "right" : "left",
      });
      x += widths[i]!;
    });
    pdf.y = y + height;
    pdf.x = left;
  };

  const drawHeader = () => {
    const y = pdf.y;
    pdf.rect(left, y - 2, width, 14).fill("#eeeeee").fillColor("#000000"); // audit-ok: print colours
    pdf.y = y;
    drawRow(
      doc.columns.map((c) => c.label),
      true,
    );
  };

  const rule = () => {
    pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor("#999999").lineWidth(0.5).stroke(); // audit-ok: print colours
    pdf.moveDown(0.2);
  };

  for (const section of doc.sections) {
    if (pdf.y + 60 > bottom()) pdf.addPage();
    if (doc.sections.length > 1 || section.title !== doc.title) {
      pdf.font("Helvetica-Bold").fontSize(11).text(text(section.title), left, pdf.y);
      pdf.moveDown(0.3);
    }
    drawHeader();
    for (const row of section.rows) drawRow(row, false);
    if (section.footer) {
      rule();
      drawRow(section.footer, true);
    }
    pdf.moveDown(1);
  }
  if (doc.sections.length === 0) pdf.font("Helvetica").fontSize(10).text("Keine Einträge.");
  if (doc.total) {
    rule();
    drawRow(doc.total, true);
  }

  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // The page number sits in the bottom margin; without this pdfkit would
    // start a new page for it.
    pdf.page.margins.bottom = 0;
    pdf.font("Helvetica").fontSize(8).fillColor("#777777"); // audit-ok: print colours
    pdf.text(`Seite ${i + 1} von ${range.count}`, left, pdf.page.height - 26, { width, align: "right", lineBreak: false });
  }
  pdf.end();
  return done;
}
