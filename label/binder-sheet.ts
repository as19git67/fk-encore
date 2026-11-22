/**
 * Binder labels ("Ordneretiketten") as PDF: the layout comes from
 * binder-layout.ts, which the browser preview shares; this file measures
 * with pdfkit and draws.
 *
 * The PDF is a pure function of the labels and the options, so a saved page
 * keeps only those (label/binder.ts) and renders again on every download.
 */

import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { normalizePdfText } from "../finance/pdf-report";
import {
  BINDER_SHEET,
  contentFrame,
  layoutBinderSheet,
  layoutLabel,
  mmToPt,
  type BinderAlign,
  type BinderDirection,
  type LabelLayout,
  type MeasureText,
  type TextStyle,
} from "./binder-layout";

export {
  BINDER_SHEET,
  BINDER_TEXT,
  MAX_LABEL_TEXT,
  binderBlocks,
  contentFrame,
  layoutBinderSheet,
  type BinderAlign,
  type BinderDirection,
} from "./binder-layout";

export interface BinderSheetSpec {
  /** Markdown per label, top to bottom; missing or blank labels stay empty. */
  labels: string[];
  direction: BinderDirection;
  align: BinderAlign;
  /** Draws the outline of every label, for a test print on plain paper. */
  outlines?: boolean;
}

/** Roboto from @fontsource/roboto in its four cuts, or null where it is missing. */
function robotoFiles(): Record<"regular" | "bold" | "italic" | "boldItalic", string> | null {
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve("@fontsource/roboto/LICENSE")), "files");
    const files = {
      regular: join(dir, "roboto-latin-400-normal.woff"),
      bold: join(dir, "roboto-latin-700-normal.woff"),
      italic: join(dir, "roboto-latin-400-italic.woff"),
      boldItalic: join(dir, "roboto-latin-700-italic.woff"),
    };
    return Object.values(files).every((f) => statSync(f).isFile()) ? files : null;
  } catch {
    return null;
  }
}

interface Fonts {
  of(style: TextStyle): string;
  /** The text as the font can show it: as is for Roboto, WinAnsi for Helvetica. */
  clean(text: string): string;
}

function registerFonts(doc: PDFKit.PDFDocument): Fonts {
  const files = robotoFiles();
  if (files) {
    doc.registerFont("Binder", files.regular);
    doc.registerFont("Binder-Bold", files.bold);
    doc.registerFont("Binder-Italic", files.italic);
    doc.registerFont("Binder-BoldItalic", files.boldItalic);
    return {
      of: (s) => (s.bold && s.italic ? "Binder-BoldItalic" : s.bold ? "Binder-Bold" : s.italic ? "Binder-Italic" : "Binder"),
      clean: (t) => t,
    };
  }
  return {
    of: (s) =>
      s.bold && s.italic ? "Helvetica-BoldOblique" : s.bold ? "Helvetica-Bold" : s.italic ? "Helvetica-Oblique" : "Helvetica",
    clean: normalizePdfText,
  };
}

function measurer(doc: PDFKit.PDFDocument, fonts: Fonts): MeasureText {
  return (text, style, size) => doc.font(fonts.of(style)).fontSize(size).widthOfString(fonts.clean(text));
}

let scratch: { doc: PDFKit.PDFDocument; measure: MeasureText } | null = null;

/** Lays out one label with pdfkit's metrics, without a sheet. */
export function layoutLabelPdf(markdown: string, direction: BinderDirection, align: BinderAlign): LabelLayout {
  if (!scratch) {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    scratch = { doc, measure: measurer(doc, registerFonts(doc)) };
  }
  return layoutLabel(markdown, direction, align, scratch.measure);
}

/** True when the label's text is taller than the label and gets cut. */
export function labelOverflows(markdown: string, direction: BinderDirection, align: BinderAlign): boolean {
  return layoutLabelPdf(markdown, direction, align).overflow;
}

/** The sheet as a PDF, not yet ended: pipe it, then call `end()`. */
export function renderBinderPdf(spec: BinderSheetSpec, title = "Ordneretiketten"): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: [BINDER_SHEET.pageWidthPt, BINDER_SHEET.pageHeightPt],
    margin: 0,
    info: { Title: normalizePdfText(title), Creator: "F4mil" },
  });
  const fonts = registerFonts(doc);
  const measure = measurer(doc, fonts);
  const pad = mmToPt(BINDER_SHEET.paddingMm);
  const frame = contentFrame(spec.direction);

  for (const box of layoutBinderSheet()) {
    if (spec.outlines) {
      doc.save().lineWidth(0.3).strokeColor("#888888").rect(box.x, box.y, box.width, box.height).stroke().restore();
    }
    const layout = layoutLabel(spec.labels[box.index] ?? "", spec.direction, spec.align, measure);
    if (layout.pieces.length === 0 && layout.rules.length === 0) continue;

    doc.save();
    doc.rect(box.x, box.y, box.width, box.height).clip();
    if (spec.direction === "across") {
      // The frame's top becomes the left end of the label: origin at the
      // label's bottom-left corner, x pointing up the sheet.
      doc.translate(box.x + pad, box.y + box.height - pad).rotate(-90);
    } else {
      doc.translate(box.x + pad, box.y + pad);
    }
    for (const rule of layout.rules) {
      doc.moveTo(0, rule.y).lineTo(frame.width, rule.y).lineWidth(0.8).strokeColor("#000000").stroke();
    }
    for (const piece of layout.pieces) {
      // Drawing beyond the bottom of the page would make pdfkit add one.
      if (piece.baseline - piece.size > frame.height + pad) continue;
      doc.font(fonts.of(piece)).fontSize(piece.size).fillColor("#000000")
        .text(fonts.clean(piece.text), piece.x, piece.baseline, { lineBreak: false, baseline: "alphabetic" });
      if (piece.strike) {
        const y = piece.baseline - piece.size * 0.28;
        doc.moveTo(piece.x, y).lineTo(piece.x + piece.width, y).lineWidth(piece.size / 16).strokeColor("#000000").stroke();
      }
    }
    doc.restore();
  }
  return doc;
}

/** Renders the PDF into one buffer (tests, small callers). */
export function renderBinderBuffer(spec: BinderSheetSpec, title?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = renderBinderPdf(spec, title);
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
