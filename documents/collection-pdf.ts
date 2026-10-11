/**
 * The single PDF a Sammelmappe turns into.
 *
 * Built when somebody asks, in the background, and kept per reader
 * (collection-export.ts). The folder stays the durable thing: the kept file
 * records which inputs it was built from, so a document edited, re-OCR'd or
 * deselected since is reported as "changed since" instead of the stale file
 * being handed on silently.
 *
 * Two properties shape the implementation:
 *
 *   - **The member pages stay untouched.** Assembly is `qpdf --pages`, which
 *     copies page objects across; it does not rasterize. A born-digital
 *     statement keeps its selectable text, an OCR'd scan keeps its text layer,
 *     and the output stays roughly the size of its inputs. Only the front
 *     matter — cover, summary, table of contents — is drawn here, with pdfkit.
 *
 *   - **The table of contents has to be right.** Page numbers in it depend on
 *     how long the front matter is, and the front matter's length depends on
 *     the table of contents. `renderFrontMatter` is therefore run repeatedly
 *     against its own page count until the number it printed is the number it
 *     produced (`buildFrontMatter`), which in practice settles on the first
 *     or second pass.
 *
 *   - **A redacted page keeps nothing of what was under its boxes.** Drawing
 *     a black rectangle over a page only hides the text from the eye; it
 *     stays in the content stream and copies out of any viewer. A page with
 *     redactions is therefore rasterized (`pdftoppm`), the boxes are burnt
 *     into the pixels, and the image replaces the page (`redactPage`). That
 *     page loses its own text layer; when `tesseract` is around it gets a
 *     fresh one, read from the already blackened image.
 *
 *   - **Every page is at most A4-sized.** Some sources write a page box in
 *     pixels rather than points — a 300 dpi scan then claims a page more than
 *     a metre wide. Viewers that lay out a document by its widest page (macOS
 *     Preview) show every normal page as a thin strip next to it. Oversized
 *     pages are scaled down uniformly to fit A4 (`fitScaleToA4`); the content
 *     stream is only wrapped in a transform, so text stays selectable.
 *
 * `qpdf` and `pdftoppm` come from the runtime image (docker/Dockerfile.runtime).
 * Everything that decides *what* to assemble — page selection, the qpdf
 * argument vector, the contents entries and their page numbers — is a pure
 * function here so it can be tested without either binary present.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import PDFDocument from "pdfkit";
import { PDFDocument as PdfLibDocument } from "pdf-lib";
import sharp from "sharp";
import { normalizePdfText } from "../finance/pdf-report";
import { singleJpegPagePdf } from "./receipt-pdf";
import { tesseractEnv } from "./tesseract-env";

console.log("[boot] documents/collection-pdf.ts: all imports resolved");

/** One member document, as the builder needs it. */
export interface CollectionPdfMember {
  document_id: number;
  /** Title shown in the table of contents; falls back to the filename. */
  title: string;
  sender: string | null;
  /** ISO date-only (YYYY-MM-DD) printed on the document itself, when known. */
  doc_date: string | null;
  /** Absolute path of the PDF or image to take pages from. */
  source_path: string;
  mime_type: string;
  /** 1-based page numbers to leave out. */
  excluded_pages: number[];
  /** Rectangles to black out (see `normalizeRedactions`). */
  redactions?: PageRedaction[];
}

/**
 * One rectangle to black out, relative to the page as it is shown — after the
 * page's rotation, inside its crop box: `x`/`y` are the top-left corner and
 * `w`/`h` the size, all as fractions of the visible page (0..1). Relative
 * rather than in points so the browser can record it on whatever size it
 * rendered the page at.
 */
export interface PageRedaction {
  /** 1-based page number. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CollectionPdfOptions {
  title: string;
  notes: string | null;
  summary: string | null;
  include_cover: boolean;
  include_toc: boolean;
  include_summary: boolean;
  /** Generation date, ISO date-only. Injected so tests are deterministic. */
  today?: string;
}

/** What a member contributed, once its pages were counted and selected. */
export interface CollectionPdfEntry {
  document_id: number;
  title: string;
  sender: string | null;
  doc_date: string | null;
  /** Pages the source has in total. */
  page_count: number;
  /** 1-based page numbers taken from it, ascending. */
  selected_pages: number[];
  /** Page in the assembled PDF this member starts on (1-based). */
  start_page: number;
}

export interface CollectionPdfResult {
  bytes: Buffer;
  /** Total pages of the assembled PDF, front matter included. */
  page_count: number;
  entries: CollectionPdfEntry[];
  /** Members that contributed nothing (every page deselected, or unreadable). */
  skipped: Array<{ document_id: number; reason: string }>;
}

const A4_MARGIN = 56;
const A4_WIDTH = 595.28;
const A4_CONTENT_WIDTH = A4_WIDTH - A4_MARGIN * 2;
const PAGE_BREAK_Y = 760;

/** Images we can wrap into a one-page PDF before assembly. */
const WRAPPABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
]);

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * The pages a member contributes: every page it has, minus the ones switched
 * off. Excluded numbers outside `1..pageCount` are ignored rather than
 * rejected — a document re-uploaded with fewer pages must not make the whole
 * folder unexportable.
 */
export function selectPages(pageCount: number, excluded: number[]): number[] {
  const drop = new Set(excluded);
  const pages: number[] = [];
  for (let page = 1; page <= pageCount; page++) {
    if (!drop.has(page)) pages.push(page);
  }
  return pages;
}

/**
 * Normalize a stored page exclusion list: integers only, ascending, unique,
 * and never below 1. Applied on write so nothing downstream has to defend
 * against `[3, 3, 0, "2"]`.
 */
export function normalizeExcludedPages(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<number>();
  for (const raw of input) {
    const page = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(page)) continue;
    const rounded = Math.trunc(page);
    if (rounded < 1) continue;
    seen.add(rounded);
  }
  return [...seen].sort((a, b) => a - b);
}

/** More boxes than any page plausibly needs; keeps a runaway client in check. */
const MAX_REDACTIONS = 500;
/** Boxes thinner than this (relative) are a stray click, not a redaction. */
const MIN_REDACTION_SIZE = 0.002;

/**
 * Normalize a stored redaction list: finite numbers only, every box clipped
 * to the page, specks dropped, sorted by page. Applied on write, like
 * `normalizeExcludedPages`.
 */
export function normalizeRedactions(input: unknown): PageRedaction[] {
  if (!Array.isArray(input)) return [];
  const out: PageRedaction[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const page = Math.trunc(Number(r.page));
    const nums = [r.x, r.y, r.w, r.h].map(Number);
    if (!Number.isFinite(page) || page < 1 || nums.some((n) => !Number.isFinite(n))) continue;
    const [x, y, w, h] = nums as [number, number, number, number];
    const left = clamp01(Math.min(x, x + w));
    const top = clamp01(Math.min(y, y + h));
    const right = clamp01(Math.max(x, x + w));
    const bottom = clamp01(Math.max(y, y + h));
    if (right - left < MIN_REDACTION_SIZE || bottom - top < MIN_REDACTION_SIZE) continue;
    out.push({ page, x: round6(left), y: round6(top), w: round6(right - left), h: round6(bottom - top) });
    if (out.length >= MAX_REDACTIONS) break;
  }
  return out.sort((a, b) => a.page - b.page);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * A redaction box in pixels of a `width` × `height` raster. Rounded outward,
 * so a box never shrinks below what was drawn — half a glyph left visible at
 * the edge is exactly what redaction must not do.
 */
export function redactionPixelBox(
  r: Pick<PageRedaction, "x" | "y" | "w" | "h">,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(r.x * width));
  const top = Math.max(0, Math.floor(r.y * height));
  const right = Math.min(width, Math.ceil((r.x + r.w) * width));
  const bottom = Math.min(height, Math.ceil((r.y + r.h) * height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * Split one member's selected pages into merge parts: runs of untouched pages
 * come from the source, every redacted page from its own rendered file.
 * `[1,2,3,4]` with page 3 redacted → `src 1-2`, `r3 1`, `src 4`.
 */
export function partsWithRedactedPages(
  sourcePath: string,
  selected: number[],
  redacted: Map<number, string>,
): Array<{ path: string; pages: number[] }> {
  const parts: Array<{ path: string; pages: number[] }> = [];
  let run: number[] = [];
  for (const page of selected) {
    const replacement = redacted.get(page);
    if (!replacement) {
      run.push(page);
      continue;
    }
    if (run.length > 0) parts.push({ path: sourcePath, pages: run });
    run = [];
    parts.push({ path: replacement, pages: [1] });
  }
  if (run.length > 0) parts.push({ path: sourcePath, pages: run });
  return parts;
}

/**
 * qpdf's page range for a selection: consecutive runs collapse to `a-b`, the
 * rest are listed. `[1,3,4,5]` → `"1,3-5"`. Empty input has no valid spelling
 * in qpdf, so the caller must skip such a member instead.
 */
export function formatPageSpec(pages: number[]): string {
  if (pages.length === 0) throw new Error("formatPageSpec: empty selection");
  const parts: string[] = [];
  let runStart = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const page = pages[i];
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    parts.push(runStart === prev ? String(runStart) : `${runStart}-${prev}`);
    runStart = page;
    prev = page;
  }
  return parts.join(",");
}

/** Human spelling of a page selection for the contents line ("1, 3–5"). */
export function describePageSpec(pages: number[]): string {
  if (pages.length === 0) return "–";
  return formatPageSpec(pages).replace(/-/g, "–").replace(/,/g, ", ");
}

/**
 * The qpdf invocation that assembles the output.
 *
 * `--empty` starts from a blank file so no input's metadata leaks into the
 * result, and every part names its own page range. Warnings are tolerated
 * (`--warning-exit-0`): real-world PDFs produce them constantly and qpdf still
 * writes a correct file.
 */
export function qpdfMergeArgs(
  parts: Array<{ path: string; pages: number[] }>,
  outPath: string,
): string[] {
  if (parts.length === 0) throw new Error("qpdfMergeArgs: nothing to merge");
  const args = ["--warning-exit-0", "--empty", "--pages"];
  for (const part of parts) {
    args.push(part.path, formatPageSpec(part.pages));
  }
  args.push("--", outPath);
  return args;
}

/**
 * Where each member starts in the assembled PDF, given how many pages the
 * front matter occupies. Members that contribute no page are not passed in —
 * they have no start page and no contents entry.
 */
export function assignStartPages(
  members: Array<Omit<CollectionPdfEntry, "start_page">>,
  frontMatterPages: number,
): CollectionPdfEntry[] {
  let cursor = frontMatterPages + 1;
  return members.map((member) => {
    const entry = { ...member, start_page: cursor };
    cursor += member.selected_pages.length;
    return entry;
  });
}

/** German date for the cover and the contents lines. */
export function formatGermanDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

/** The line under a contents entry: sender, date, and the pages taken. */
export function contentsSubline(entry: CollectionPdfEntry): string {
  const parts: string[] = [];
  if (entry.sender) parts.push(entry.sender);
  const date = formatGermanDate(entry.doc_date);
  if (date) parts.push(date);
  parts.push(
    entry.selected_pages.length === entry.page_count
      ? `${entry.page_count} ${entry.page_count === 1 ? "Seite" : "Seiten"}`
      : `Seiten ${describePageSpec(entry.selected_pages)} von ${entry.page_count}`,
  );
  return parts.join(" · ");
}

// ─── Front matter ───────────────────────────────────────────────────────────

/**
 * Draw cover, summary and table of contents for a known set of entries.
 * Returns the bytes and how many pages they came to — `buildFrontMatter`
 * feeds that count back in until it stops changing.
 */
export async function renderFrontMatter(
  options: CollectionPdfOptions,
  entries: CollectionPdfEntry[],
): Promise<{ bytes: Buffer; page_count: number }> {
  const title = normalizePdfText(options.title || "Sammelmappe");
  const pdf = new PDFDocument({
    size: "A4",
    margin: A4_MARGIN,
    bufferPages: true,
    info: { Title: title },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => pdf.on("end", () => resolve()));

  const today = formatGermanDate(options.today ?? new Date().toISOString().slice(0, 10));
  const docCount = entries.length;
  const pageTotal = entries.reduce((sum, e) => sum + e.selected_pages.length, 0);

  if (options.include_cover) {
    pdf.moveDown(4);
    pdf.font("Helvetica-Bold").fontSize(26).fillColor("#000").text(title, { align: "left" });
    pdf.moveDown(0.6);
    pdf
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555")
      .text(
        [
          `${docCount} ${docCount === 1 ? "Dokument" : "Dokumente"}`,
          `${pageTotal} ${pageTotal === 1 ? "Seite" : "Seiten"}`,
          today ? `erstellt am ${today}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    if (options.notes?.trim()) {
      pdf.moveDown(1.4);
      pdf
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#000")
        .text(normalizePdfText(options.notes.trim()), { width: A4_CONTENT_WIDTH });
    }
  }

  if (options.include_summary && options.summary?.trim()) {
    if (options.include_cover) pdf.addPage();
    sectionHeading(pdf, "Zusammenfassung");
    pdf
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor("#222")
      .text(normalizePdfText(options.summary.trim()), { width: A4_CONTENT_WIDTH, align: "left" });
  }

  if (options.include_toc && entries.length > 0) {
    if (options.include_cover || (options.include_summary && options.summary?.trim())) {
      pdf.addPage();
    }
    sectionHeading(pdf, "Inhaltsverzeichnis");
    entries.forEach((entry, index) => {
      if (pdf.y > PAGE_BREAK_Y) pdf.addPage();
      const top = pdf.y;
      pdf
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .fillColor("#000")
        .text(`${index + 1}.  ${normalizePdfText(entry.title)}`, A4_MARGIN, top, {
          width: A4_CONTENT_WIDTH - 60,
        });
      pdf
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor("#555")
        .text(`S. ${entry.start_page}`, A4_WIDTH - A4_MARGIN - 56, top, {
          width: 56,
          align: "right",
        });
      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#777")
        .text(normalizePdfText(contentsSubline(entry)), A4_MARGIN + 18, pdf.y, {
          width: A4_CONTENT_WIDTH - 78,
        });
      pdf.moveDown(0.6);
    });
  }

  const pageCount = pdf.bufferedPageRange().count;
  pdf.end();
  await done;
  return { bytes: Buffer.concat(chunks), page_count: pageCount };
}

function sectionHeading(pdf: PDFKit.PDFDocument, text: string): void {
  pdf.font("Helvetica-Bold").fontSize(15).fillColor("#000").text(text);
  pdf.moveDown(0.2);
  pdf
    .strokeColor("#ccc")
    .moveTo(A4_MARGIN, pdf.y)
    .lineTo(A4_WIDTH - A4_MARGIN, pdf.y)
    .stroke();
  pdf.moveDown(0.8);
}

/**
 * Front matter whose printed page numbers match the document it produces.
 *
 * The first pass guesses one front-matter page, and each further pass reprints
 * the contents with the count the previous pass actually produced. Adding a
 * page can only push entries later, never earlier, so this converges; the
 * bound exists so a pathological input cannot spin.
 */
export async function buildFrontMatter(
  options: CollectionPdfOptions,
  members: Array<Omit<CollectionPdfEntry, "start_page">>,
  maxPasses = 4,
): Promise<{ bytes: Buffer; page_count: number; entries: CollectionPdfEntry[] }> {
  let assumed = 1;
  let last: { bytes: Buffer; page_count: number; entries: CollectionPdfEntry[] } | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const entries = assignStartPages(members, assumed);
    const rendered = await renderFrontMatter(options, entries);
    last = { ...rendered, entries };
    if (rendered.page_count === assumed) return last;
    assumed = rendered.page_count;
  }
  // Did not settle: re-render one final time with the last known count so the
  // numbers printed belong to the document that is actually returned.
  const entries = assignStartPages(members, assumed);
  const rendered = await renderFrontMatter(options, entries);
  return { ...rendered, entries };
}

// ─── External binaries ──────────────────────────────────────────────────────

/** Page count of a PDF, via `qpdf --show-npages`. */
export async function pdfPageCount(absPath: string): Promise<number> {
  const out = await run("qpdf", ["--warning-exit-0", "--show-npages", absPath], true);
  const count = parseInt(out.trim(), 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`qpdf --show-npages returned ${JSON.stringify(out.trim())}`);
  }
  return count;
}

function run(bin: string, args: string[], wantStdout = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["ignore", wantStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * A PDF path for a member, wrapping images on the way. Non-PDF, non-image
 * members have no pages to contribute and are reported as skipped instead.
 */
async function materializePdf(
  member: CollectionPdfMember,
  tmpDir: string,
): Promise<string | null> {
  const mime = (member.mime_type || "").toLowerCase();
  if (mime === "application/pdf" || member.source_path.toLowerCase().endsWith(".pdf")) {
    return member.source_path;
  }
  if (!WRAPPABLE_IMAGE_TYPES.has(mime)) return null;
  const image = sharp(await fs.promises.readFile(member.source_path), { failOn: "none" });
  const meta = await image.metadata();
  const jpeg = await image.jpeg({ quality: 88 }).toBuffer();
  const wrapped = singleJpegPagePdf(jpeg, meta.width || 1000, meta.height || 1000);
  const out = path.join(tmpDir, `img-${member.document_id}.pdf`);
  await fs.promises.writeFile(out, wrapped);
  return out;
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/** Raster resolution of a redacted page: sharp enough to read and to re-OCR. */
const REDACT_DPI = parseInt(process.env.DOCUMENTS_REDACT_DPI ?? "200", 10);

/**
 * Render one page of `pdfPath` with `boxes` burnt in and return the path of a
 * one-page PDF of the same visible size that holds only that image (plus,
 * when tesseract is available, a text layer read from it). Nothing of the
 * original page's content stream, fonts, annotations or form fields carries
 * over, so text under a box cannot be copied, searched or extracted.
 */
export async function redactPage(
  pdfPath: string,
  page: number,
  boxes: Array<Pick<PageRedaction, "x" | "y" | "w" | "h">>,
  outPrefix: string,
): Promise<string> {
  // `-cropbox` and pdftoppm's own handling of /Rotate give the page exactly
  // as pdfjs shows it in the browser, which is what the boxes are relative to.
  await run("pdftoppm", [
    "-f", String(page),
    "-l", String(page),
    "-r", String(REDACT_DPI),
    "-cropbox",
    "-png",
    "-singlefile",
    pdfPath,
    outPrefix,
  ]);
  const raster = `${outPrefix}.png`;
  const meta = await sharp(raster).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(`redaction: page ${page} rendered empty`);
  const jpeg = await sharp(raster)
    .flatten({ background: "#ffffff" })
    .composite(
      boxes.map((box) => {
        const px = redactionPixelBox(box, width, height);
        return {
          input: { create: { width: px.width, height: px.height, channels: 3 as const, background: "#000000" } },
          left: px.left,
          top: px.top,
        };
      }),
    )
    .jpeg({ quality: 85 })
    .toBuffer();
  await fs.promises.rm(raster, { force: true });
  const jpegPath = `${outPrefix}.jpg`;
  await fs.promises.writeFile(jpegPath, jpeg);

  const searchable = await ocrPagePdf(jpegPath, `${outPrefix}-ocr`);
  if (searchable) return searchable;

  // No tesseract: the image alone, at the page's own size in points.
  const doc = await PdfLibDocument.create();
  const image = await doc.embedJpg(jpeg);
  const pageWidth = (width * 72) / REDACT_DPI;
  const pageHeight = (height * 72) / REDACT_DPI;
  doc.addPage([pageWidth, pageHeight]).drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  const out = `${outPrefix}.pdf`;
  await fs.promises.writeFile(out, await doc.save());
  return out;
}

/**
 * A one-page searchable PDF of `jpegPath` via tesseract, or null when
 * tesseract is missing or fails — the caller then embeds the image alone.
 * Tesseract reads only the blackened image, so it cannot bring back what the
 * boxes cover.
 */
async function ocrPagePdf(jpegPath: string, outBase: string): Promise<string | null> {
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "tesseract",
        [
          jpegPath,
          outBase,
          "--dpi",
          String(REDACT_DPI),
          "-l",
          process.env.DOCUMENTS_OCR_LANG ?? "deu+eng",
          "-c",
          "preserve_interword_spaces=1",
          "pdf",
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: tesseractEnv() },
      );
      let stderr = "";
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tesseract exited ${code}: ${stderr.trim().slice(0, 300)}`));
      });
    });
    return `${outBase}.pdf`;
  } catch (err) {
    console.warn(
      "[documents] collection export: redacted page without text layer:",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

// ─── Assembly ───────────────────────────────────────────────────────────────

/**
 * Assemble the collection's PDF. Members are taken in the order given; the
 * caller has already dropped the ones switched off and the ones the reader
 * may not see.
 */
export async function buildCollectionPdf(
  options: CollectionPdfOptions,
  members: CollectionPdfMember[],
): Promise<CollectionPdfResult> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "doc-collection-"));
  try {
    const parts: Array<{ path: string; pages: number[] }> = [];
    const counted: Array<Omit<CollectionPdfEntry, "start_page">> = [];
    const skipped: Array<{ document_id: number; reason: string }> = [];

    for (const member of members) {
      let pdfPath: string | null;
      let pageCount: number;
      try {
        pdfPath = await materializePdf(member, tmpDir);
        if (!pdfPath) {
          skipped.push({ document_id: member.document_id, reason: "unsupported_type" });
          continue;
        }
        pageCount = await pdfPageCount(pdfPath);
      } catch (err) {
        console.warn(
          `[documents] collection export: document ${member.document_id} unreadable:`,
          (err as Error)?.message ?? err,
        );
        skipped.push({ document_id: member.document_id, reason: "unreadable" });
        continue;
      }
      const selected = selectPages(pageCount, member.excluded_pages);
      if (selected.length === 0) {
        skipped.push({ document_id: member.document_id, reason: "no_pages_selected" });
        continue;
      }
      const boxes = (member.redactions ?? []).filter((r) => r.page <= pageCount);
      if (boxes.length > 0) {
        // A page that cannot be redacted must not go out unredacted: let the
        // build fail instead of quietly shipping what was meant to be hidden.
        const redacted = new Map<number, string>();
        for (const page of selected) {
          const onPage = boxes.filter((r) => r.page === page);
          if (onPage.length === 0) continue;
          redacted.set(
            page,
            await redactPage(pdfPath, page, onPage, path.join(tmpDir, `red-${member.document_id}-${page}`)),
          );
        }
        parts.push(...partsWithRedactedPages(pdfPath, selected, redacted));
      } else {
        parts.push({ path: pdfPath, pages: selected });
      }
      counted.push({
        document_id: member.document_id,
        title: member.title,
        sender: member.sender,
        doc_date: member.doc_date,
        page_count: pageCount,
        selected_pages: selected,
      });
    }

    const front = await buildFrontMatter(options, counted);
    const hasFrontMatter = frontMatterWanted(options, counted.length);
    const frontPath = path.join(tmpDir, "front.pdf");
    if (hasFrontMatter) await fs.promises.writeFile(frontPath, front.bytes);

    // No member contributed a page: the front matter alone is the export.
    if (parts.length === 0) {
      if (!hasFrontMatter) {
        throw new Error("collection export is empty: no pages selected");
      }
      return {
        bytes: front.bytes,
        page_count: front.page_count,
        entries: [],
        skipped,
      };
    }

    const outPath = path.join(tmpDir, "collection.pdf");
    const mergeParts = hasFrontMatter
      ? [{ path: frontPath, pages: rangeOf(front.page_count) }, ...parts]
      : parts;
    await run("qpdf", qpdfMergeArgs(mergeParts, outPath));
    const bytes = await shrinkOversizedPages(await fs.promises.readFile(outPath));

    return {
      bytes,
      page_count:
        (hasFrontMatter ? front.page_count : 0) +
        parts.reduce((sum, part) => sum + part.pages.length, 0),
      entries: hasFrontMatter
        ? front.entries
        : assignStartPages(counted, 0),
      skipped,
    };
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * True when at least one front-matter section is switched on *and* has
 * something to show. Without the entry count a contents-only export of an
 * empty folder would prepend a blank page.
 */
export function frontMatterWanted(options: CollectionPdfOptions, entryCount: number): boolean {
  if (options.include_cover) return true;
  if (options.include_toc && entryCount > 0) return true;
  return options.include_summary && !!options.summary?.trim();
}

function rangeOf(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

// ─── Page size ──────────────────────────────────────────────────────────────

const A4_SHORT = 595.28;
const A4_LONG = 841.89;
/**
 * Pages up to this much larger than A4 are left alone: Letter, Legal and a
 * scanner's slightly generous A4 are fine as they are; only boxes that are
 * clearly not in points are worth touching.
 */
const OVERSIZE_TOLERANCE = 1.25;

/**
 * The uniform factor that brings a page of `width` × `height` points within
 * A4 in its own orientation, or null when the page is not oversized.
 */
export function fitScaleToA4(width: number, height: number): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  const [boxW, boxH] = width > height ? [A4_LONG, A4_SHORT] : [A4_SHORT, A4_LONG];
  if (width <= boxW * OVERSIZE_TOLERANCE && height <= boxH * OVERSIZE_TOLERANCE) return null;
  return Math.min(boxW / width, boxH / height);
}

/**
 * Scale every oversized page of `bytes` down to A4 (see the header). Returns
 * the input unchanged when nothing is oversized or the PDF cannot be parsed —
 * an export with one huge page beats no export.
 */
export async function shrinkOversizedPages(bytes: Buffer): Promise<Buffer> {
  try {
    const doc = await PdfLibDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    let changed = false;
    for (const page of doc.getPages()) {
      const crop = page.getCropBox();
      const factor = fitScaleToA4(crop.width, crop.height);
      if (factor === null) continue;
      // Content and annotations scale about the origin, so every box has to
      // scale about it too — including its offset.
      const boxes: Array<[() => { x: number; y: number; width: number; height: number } | undefined, (x: number, y: number, w: number, h: number) => void]> = [
        [() => page.getMediaBox(), (x, y, w, h) => page.setMediaBox(x, y, w, h)],
        [() => (page.node.CropBox() ? page.getCropBox() : undefined), (x, y, w, h) => page.setCropBox(x, y, w, h)],
        [() => (page.node.BleedBox() ? page.getBleedBox() : undefined), (x, y, w, h) => page.setBleedBox(x, y, w, h)],
        [() => (page.node.TrimBox() ? page.getTrimBox() : undefined), (x, y, w, h) => page.setTrimBox(x, y, w, h)],
        [() => (page.node.ArtBox() ? page.getArtBox() : undefined), (x, y, w, h) => page.setArtBox(x, y, w, h)],
      ];
      for (const [get, set] of boxes) {
        const box = get();
        if (box) set(box.x * factor, box.y * factor, box.width * factor, box.height * factor);
      }
      page.scaleContent(factor, factor);
      page.scaleAnnotations(factor, factor);
      changed = true;
    }
    if (!changed) return bytes;
    return Buffer.from(await doc.save({ updateFieldAppearances: false }));
  } catch (err) {
    console.warn(
      "[documents] collection export: page sizes left as they are:",
      (err as Error)?.message ?? err,
    );
    return bytes;
  }
}
