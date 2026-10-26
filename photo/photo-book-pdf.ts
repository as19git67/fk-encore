/**
 * The PDF of a photo book (documentation/plans/fotobuch.md), rendered with
 * pdfkit; photos through sharp, cut to their cell around the focal point
 * (`coverCrop`, the same as the recap export) at up to `RENDER_DPI`.
 *
 * Two outputs:
 *   - print shop: `cover` — one sheet, back · spine · front, with bleed — and
 *     `inside` — the pages as spreads (left and right page on one PDF page)
 *     or single, each with bleed and optional crop marks in a slug outside it.
 *   - home: one file, the front cover and then every page at trim size.
 *
 * No database: the caller hands over the book and a loader for the image
 * bytes, so the tests render a book of generated pictures.
 */

import * as fs from "fs";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { coverCrop } from "./recap-export.service";
import {
  PHOTO_BOOK_FORMATS,
  RENDER_DPI,
  slotGeometry,
  spineWidthMm,
  textRect,
  type BookLayout,
  type PhotoBookFormat,
  type RectMm,
} from "./photo-book-layout";

const PT_PER_MM = 72 / 25.4;
const pt = (mm: number) => mm * PT_PER_MM;

/** Crop marks sit in this strip outside the bleed. */
export const SLUG_MM = 6;
const MARK_MM = 4;

const INK = "#222222";
const MUTED = "#666666";
const COVER_GROUND = "#1f2933";

export interface RenderSlot {
  photoId: number;
  focal: { x: number; y: number } | null;
  caption?: string | null;
}

export interface RenderPage {
  layout: BookLayout;
  chapterTitle: string | null;
  chapterSubtitle: string | null;
  /** The page shows captions: framed photos make room for them. */
  captioned?: boolean;
  slots: RenderSlot[];
}

export interface RenderBook {
  format: PhotoBookFormat;
  title: string;
  subtitle: string | null;
  cover: RenderSlot | null;
  pages: RenderPage[];
  bleedMm: number;
  cropMarks: boolean;
  spreads: boolean;
  paperMm: number;
}

/** The picture of a photo as a file path or bytes; null when it cannot be read. */
export type ImageLoader = (photoId: number) => Promise<string | Buffer | null>;
export type ProgressFn = (done: number, total: number) => void;

/** A photo cut to `wMm × hMm` around its focal point, as JPEG; null when it cannot be read. */
export async function prepareImage(
  input: string | Buffer,
  focal: { x: number; y: number } | null,
  wMm: number,
  hMm: number,
): Promise<Buffer | null> {
  try {
    const { data, info } = await sharp(input).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const crop = coverCrop(info.width, info.height, wMm / hMm, focal);
    crop.width = Math.max(1, Math.min(crop.width, info.width - crop.left));
    crop.height = Math.max(1, Math.min(crop.height, info.height - crop.top));
    const maxW = Math.max(1, Math.round((wMm / 25.4) * RENDER_DPI));
    const maxH = Math.max(1, Math.round((hMm / 25.4) * RENDER_DPI));
    return await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .extract(crop)
      .resize(maxW, maxH, { fit: "fill", withoutEnlargement: crop.width <= maxW })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.warn("[photo-book-pdf] could not prepare image:", (err as Error).message);
    return null;
  }
}

/** Which sides of a page reach the edge of the sheet and so get the bleed. */
interface Bleed {
  l: number;
  r: number;
  t: number;
  b: number;
}

class Renderer {
  private done = 0;

  constructor(
    private readonly book: RenderBook,
    private readonly load: ImageLoader,
    private readonly total: number,
    private readonly onProgress?: ProgressFn,
  ) {}

  private tick(): void {
    this.done += 1;
    this.onProgress?.(this.done, this.total);
  }

  async image(doc: PDFKit.PDFDocument, slot: RenderSlot, rect: RectMm): Promise<void> {
    const input = await this.load(slot.photoId);
    const jpeg = input ? await prepareImage(input, slot.focal, rect.w, rect.h) : null;
    if (jpeg) {
      doc.image(jpeg, pt(rect.x), pt(rect.y), { width: pt(rect.w), height: pt(rect.h) });
    } else {
      // A gap is better than a missing page: the print shows where a photo was.
      doc.save().rect(pt(rect.x), pt(rect.y), pt(rect.w), pt(rect.h)).fill("#dddddd").restore();
    }
    this.tick();
  }

  /** One book page with its trim box at (`ox`, `oy`) mm on the current PDF page. */
  async page(doc: PDFKit.PDFDocument, page: RenderPage | null, ox: number, oy: number, bleed: Bleed): Promise<void> {
    if (!page) return;
    const { format } = this.book;
    const layout = page.layout;
    for (let i = 0; i < page.slots.length && i < layout.cells.length; i++) {
      const geo = slotGeometry(format, layout, layout.cells[i], !!page.captioned);
      let r = geo.image;
      if (layout.fullBleed) r = { x: r.x - bleed.l, y: r.y - bleed.t, w: r.w + bleed.l + bleed.r, h: r.h + bleed.t + bleed.b };
      await this.image(doc, page.slots[i], { x: ox + r.x, y: oy + r.y, w: r.w, h: r.h });
      const caption = page.slots[i].caption;
      if (geo.caption && caption) this.caption(doc, caption, { x: ox + geo.caption.x, y: oy + geo.caption.y, w: geo.caption.w, h: geo.caption.h }, geo.overlay);
    }
    const tr = textRect(format, layout);
    if (tr && page.chapterTitle) {
      const f = PHOTO_BOOK_FORMATS[format];
      const titlePt = Math.max(14, Math.min(32, pt(f.height) * 0.045));
      const align = layout.cells.length ? "left" : "center";
      doc.font("Helvetica-Bold").fontSize(titlePt).fillColor(INK);
      const titleH = doc.heightOfString(page.chapterTitle, { width: pt(tr.w) });
      const subPt = titlePt * 0.5;
      const subH = page.chapterSubtitle ? subPt * 1.6 : 0;
      // Openers with a photo hang the text from the top of its box, text-only ones centre it.
      const top = layout.cells.length ? pt(oy + tr.y) : pt(oy + tr.y) + (pt(tr.h) - titleH - subH) / 2;
      doc.text(page.chapterTitle, pt(ox + tr.x), top, { width: pt(tr.w), align, lineBreak: true });
      if (page.chapterSubtitle) {
        doc.font("Helvetica").fontSize(subPt).fillColor(MUTED)
          .text(page.chapterSubtitle, pt(ox + tr.x), top + titleH + subPt * 0.4, { width: pt(tr.w), align });
      }
    }
  }

  /** A caption under its photo, or over it in a dark band when the photo fills the page. */
  caption(doc: PDFKit.PDFDocument, text: string, rect: RectMm, overlay: boolean): void {
    const size = Math.min(8.5, Math.max(6, pt(rect.h) * 0.4));
    doc.font("Helvetica").fontSize(size);
    if (overlay) {
      const pad = 2;
      const w = Math.min(pt(rect.w), doc.widthOfString(text) + pt(2 * pad));
      const h = Math.min(pt(rect.h), doc.heightOfString(text, { width: pt(rect.w) - pt(2 * pad) }) + pt(pad));
      const top = pt(rect.y + rect.h) - h;
      doc.save().rect(pt(rect.x), top, w, h).fillOpacity(0.5).fill("#000000").restore();
      doc.fillColor("#ffffff").text(text, pt(rect.x + pad), top + pt(pad) / 2, {
        width: w - pt(2 * pad), height: h, ellipsis: true, lineBreak: true,
      });
      return;
    }
    doc.fillColor(MUTED).text(text, pt(rect.x), pt(rect.y), { width: pt(rect.w), height: pt(rect.h), ellipsis: true, lineBreak: true });
  }

  /** The front: cover photo over the whole panel and a band with the title. */
  async front(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, trimH: number, trimY: number): Promise<void> {
    if (this.book.cover) await this.image(doc, this.book.cover, { x, y, w, h });
    else doc.save().rect(pt(x), pt(y), pt(w), pt(h)).fill(COVER_GROUND).restore();
    const bandH = trimH * 0.22;
    const bandY = trimY + trimH - bandH - trimH * 0.08;
    doc.save().rect(pt(x), pt(bandY), pt(w), pt(bandH)).fillOpacity(0.55).fill("#000000").restore();
    const titlePt = Math.max(16, Math.min(40, pt(trimH) * 0.06));
    const pad = trimH * 0.05;
    doc.font("Helvetica-Bold").fontSize(titlePt).fillColor("#ffffff")
      .text(this.book.title, pt(x + pad), pt(bandY) + pt(bandH) * 0.18, { width: pt(w - 2 * pad), align: "center" });
    if (this.book.subtitle) {
      doc.font("Helvetica").fontSize(titlePt * 0.45).fillColor("#ffffff")
        .text(this.book.subtitle, pt(x + pad), pt(bandY) + pt(bandH) * 0.62, { width: pt(w - 2 * pad), align: "center" });
    }
  }
}

function countImages(book: RenderBook): number {
  return book.pages.reduce((n, p) => n + Math.min(p.slots.length, p.layout.cells.length), 0) + (book.cover ? 1 : 0);
}

function finish(doc: PDFKit.PDFDocument, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.pipe(stream);
  });
}

/** Marks at the corners of `trim` (mm, sheet coordinates), outside the bleed. */
function cropMarks(doc: PDFKit.PDFDocument, trim: RectMm, bleed: number): void {
  const off = bleed + 1;
  doc.save().lineWidth(0.25).strokeColor("#000000");
  const xs = [trim.x, trim.x + trim.w];
  const ys = [trim.y, trim.y + trim.h];
  for (const x of xs) {
    for (const y of ys) {
      const dx = x === trim.x ? -1 : 1;
      const dy = y === trim.y ? -1 : 1;
      doc.moveTo(pt(x + dx * off), pt(y)).lineTo(pt(x + dx * (off + MARK_MM)), pt(y)).stroke();
      doc.moveTo(pt(x), pt(y + dy * off)).lineTo(pt(x), pt(y + dy * (off + MARK_MM))).stroke();
    }
  }
  doc.restore();
}

/** One PDF for printing at home: the front, then every page at trim size. */
export async function renderHomePdf(book: RenderBook, load: ImageLoader, out: string, onProgress?: ProgressFn): Promise<void> {
  const f = PHOTO_BOOK_FORMATS[book.format];
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: book.title } });
  const done = finish(doc, out);
  const r = new Renderer(book, load, countImages(book), onProgress);
  const none: Bleed = { l: 0, r: 0, t: 0, b: 0 };

  doc.addPage({ size: [pt(f.width), pt(f.height)], margin: 0 });
  await r.front(doc, 0, 0, f.width, f.height, f.height, 0);
  for (const page of book.pages) {
    doc.addPage({ size: [pt(f.width), pt(f.height)], margin: 0 });
    await r.page(doc, page, 0, 0, none);
  }
  doc.end();
  await done;
}

/** The cover sheet for a print shop: back, spine and front side by side, with bleed. */
export async function renderCoverPdf(book: RenderBook, load: ImageLoader, out: string, onProgress?: ProgressFn): Promise<void> {
  const f = PHOTO_BOOK_FORMATS[book.format];
  const bleed = book.bleedMm;
  const slug = book.cropMarks ? SLUG_MM : 0;
  const pages = book.pages.length + (book.pages.length % 2);
  const spine = spineWidthMm(pages, book.paperMm);
  const trimW = 2 * f.width + spine;
  const sheetW = trimW + 2 * (bleed + slug);
  const sheetH = f.height + 2 * (bleed + slug);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: `${book.title} – Umschlag` } });
  const done = finish(doc, out);
  const r = new Renderer({ ...book, pages: [] }, load, book.cover ? 1 : 0, onProgress);
  doc.addPage({ size: [pt(sheetW), pt(sheetH)], margin: 0 });

  const x0 = slug;
  const y0 = slug;
  const trimX = x0 + bleed;
  const trimY = y0 + bleed;
  // Back and spine: one ground, the bleed included.
  doc.save().rect(pt(x0), pt(y0), pt(bleed + f.width + spine), pt(f.height + 2 * bleed)).fill(COVER_GROUND).restore();
  if (book.subtitle) {
    doc.font("Helvetica").fontSize(10).fillColor("#ffffff")
      .text(book.subtitle, pt(trimX + 15), pt(trimY + f.height - 25), { width: pt(f.width - 30), align: "center" });
  }
  if (spine >= 5) {
    const cx = trimX + f.width + spine / 2;
    const cy = trimY + f.height / 2;
    const size = Math.min(14, pt(spine) * 0.55);
    doc.save().rotate(90, { origin: [pt(cx), pt(cy)] });
    doc.font("Helvetica-Bold").fontSize(size).fillColor("#ffffff")
      .text(book.title, pt(cx - f.height / 2 + 10), pt(cy) - size * 0.6, { width: pt(f.height - 20), align: "center", lineBreak: false });
    doc.restore();
  }
  const frontX = trimX + f.width + spine;
  await r.front(doc, frontX, y0, f.width + bleed, f.height + 2 * bleed, f.height, trimY);
  if (book.cropMarks) {
    cropMarks(doc, { x: trimX, y: trimY, w: trimW, h: f.height }, bleed);
    // The spine's edges, so the binder sees where the folds go.
    doc.save().lineWidth(0.25).strokeColor("#000000");
    for (const x of [trimX + f.width, trimX + f.width + spine]) {
      doc.moveTo(pt(x), pt(trimY - bleed - 1)).lineTo(pt(x), pt(trimY - bleed - 1 - MARK_MM)).stroke();
      doc.moveTo(pt(x), pt(trimY + f.height + bleed + 1)).lineTo(pt(x), pt(trimY + f.height + bleed + 1 + MARK_MM)).stroke();
    }
    doc.restore();
  }
  doc.end();
  await done;
}

/** The inside for a print shop: spreads or single pages, with bleed; an odd count gets an empty last page. */
export async function renderInsidePdf(book: RenderBook, load: ImageLoader, out: string, onProgress?: ProgressFn): Promise<void> {
  const f = PHOTO_BOOK_FORMATS[book.format];
  const bleed = book.bleedMm;
  const slug = book.cropMarks ? SLUG_MM : 0;
  const pages: (RenderPage | null)[] = [...book.pages];
  if (pages.length % 2) pages.push(null);
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: `${book.title} – Innenseiten` } });
  const done = finish(doc, out);
  const r = new Renderer({ ...book, cover: null }, load, countImages({ ...book, cover: null }), onProgress);
  const o = slug + bleed;

  if (book.spreads) {
    const sheetW = 2 * f.width + 2 * o;
    const sheetH = f.height + 2 * o;
    for (let i = 0; i < pages.length; i += 2) {
      doc.addPage({ size: [pt(sheetW), pt(sheetH)], margin: 0 });
      await r.page(doc, pages[i], o, o, { l: bleed, r: 0, t: bleed, b: bleed });
      await r.page(doc, pages[i + 1], o + f.width, o, { l: 0, r: bleed, t: bleed, b: bleed });
      if (book.cropMarks) cropMarks(doc, { x: o, y: o, w: 2 * f.width, h: f.height }, bleed);
    }
  } else {
    const sheetW = f.width + 2 * o;
    const sheetH = f.height + 2 * o;
    for (const page of pages) {
      doc.addPage({ size: [pt(sheetW), pt(sheetH)], margin: 0 });
      await r.page(doc, page, o, o, { l: bleed, r: bleed, t: bleed, b: bleed });
      if (book.cropMarks) cropMarks(doc, { x: o, y: o, w: f.width, h: f.height }, bleed);
    }
  }
  doc.end();
  await done;
}
