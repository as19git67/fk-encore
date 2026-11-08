/**
 * Scanner labels: A4 sheets of small numbered stickers ("#0001", "#0002", …)
 * that go on paper documents before they are scanned.
 *
 * The sheet is Avery Zweckform L4731REV: 7 columns × 27 rows = 189 labels of
 * 25.4 × 10 mm. The labels sit edge to edge vertically (27 × 10 mm = 270 mm,
 * leaving 13.5 mm top and bottom) and with a 2.5 mm gap horizontally
 * (7 × 25.4 + 6 × 2.5 = 192.8 mm, leaving 8.6 mm left and right).
 *
 * Text and font follow the script these sheets were printed with before:
 * Roboto Regular at 13 pt, 2 mm from the left edge of each label. The text
 * is centred vertically in its label so a small feed offset of the printer
 * does not push it onto the neighbour. A printer that still prints shifted
 * is corrected with the per-user offset (`offsetXMm`, `offsetYMm`), which
 * moves the whole grid.
 *
 * The PDF is a pure function of the first number, the page count and the
 * offset, so a sheet is never stored as a file: the list keeps those values
 * and a download renders the same PDF again.
 */

import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";

export const SHEET = {
  name: "Avery Zweckform L4731REV",
  columns: 7,
  rows: 27,
  labelWidthMm: 25.4,
  labelHeightMm: 10,
  columnGapMm: 2.5,
  rowGapMm: 0,
  marginLeftMm: 8.6,
  marginTopMm: 13.5,
  fontSizePt: 13,
  textInsetMm: 2,
} as const;

export const LABELS_PER_PAGE = SHEET.columns * SHEET.rows;
export const MAX_PAGES = 10;
/** Largest number a sheet may carry; "#999999" still fits a 25.4 mm label. */
export const MAX_NUMBER = 999_999;
/** How far the calibration may move the grid, in mm each way. */
export const MAX_OFFSET_MM = 10;

const PT_PER_MM = 72 / 25.4;
const A4: [number, number] = [595.28, 841.89];

export interface SheetSpec {
  firstNumber: number;
  pages: number;
  offsetXMm?: number;
  offsetYMm?: number;
  /**
   * Draws the outline of every label: the test page, printed on plain paper
   * and held against a sheet, shows whether the printer needs an offset.
   */
  outlines?: boolean;
}

/** "#0001" — four digits at least, more once the numbers outgrow them. */
export function labelText(n: number): string {
  return `#${String(n).padStart(4, "0")}`;
}

export function lastNumber(spec: Pick<SheetSpec, "firstNumber" | "pages">): number {
  return spec.firstNumber + spec.pages * LABELS_PER_PAGE - 1;
}

export interface LabelBox {
  text: string;
  page: number;
  /** Top-left corner of the label in PDF points, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every label of the sheet with its position, row by row, page by page. */
export function layoutSheet(spec: SheetSpec): LabelBox[] {
  const dx = (spec.offsetXMm ?? 0) * PT_PER_MM;
  const dy = (spec.offsetYMm ?? 0) * PT_PER_MM;
  const width = SHEET.labelWidthMm * PT_PER_MM;
  const height = SHEET.labelHeightMm * PT_PER_MM;
  const pitchX = (SHEET.labelWidthMm + SHEET.columnGapMm) * PT_PER_MM;
  const pitchY = (SHEET.labelHeightMm + SHEET.rowGapMm) * PT_PER_MM;
  const left = SHEET.marginLeftMm * PT_PER_MM + dx;
  const top = SHEET.marginTopMm * PT_PER_MM + dy;

  const boxes: LabelBox[] = [];
  let n = spec.firstNumber;
  for (let page = 0; page < spec.pages; page++) {
    for (let row = 0; row < SHEET.rows; row++) {
      for (let column = 0; column < SHEET.columns; column++) {
        boxes.push({
          text: labelText(n++),
          page,
          x: left + column * pitchX,
          y: top + row * pitchY,
          width,
          height,
        });
      }
    }
  }
  return boxes;
}

/** Roboto from @fontsource/roboto; its exports only name CSS, so go by its directory. */
function robotoPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve("@fontsource/roboto/LICENSE"));
    const path = join(dir, "files", "roboto-latin-400-normal.woff");
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The sheet as a PDF, not yet ended: pipe it, then call `end()`. */
export function renderSheetPdf(spec: SheetSpec, title = "Etiketten für Scanner"): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: A4,
    margin: 0,
    autoFirstPage: false,
    info: { Title: title, Creator: "F4mil" },
  });
  const font = robotoPath();
  if (font) doc.registerFont("Roboto", font);
  const fontName = font ? "Roboto" : "Helvetica";

  const boxes = layoutSheet(spec);
  let page = -1;
  for (const box of boxes) {
    if (box.page !== page) {
      doc.addPage({ size: A4, margin: 0 });
      doc.font(fontName).fontSize(SHEET.fontSizePt).fillColor("black");
      page = box.page;
    }
    if (spec.outlines) {
      doc.save().lineWidth(0.3).strokeColor("#888888").rect(box.x, box.y, box.width, box.height).stroke().restore();
    }
    doc.text(box.text, box.x + SHEET.textInsetMm * PT_PER_MM, box.y + box.height / 2, {
      lineBreak: false,
      baseline: "middle",
    });
  }
  return doc;
}

/** Renders the PDF into one buffer (tests, small callers). */
export function renderSheetBuffer(spec: SheetSpec, title?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = renderSheetPdf(spec, title);
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
