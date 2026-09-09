/**
 * The single PDF a Sammelmappe turns into.
 *
 * Built on demand, never stored: the folder is the durable thing, the PDF is
 * what falls out of it at the moment somebody asks. That keeps the export
 * honest — a document edited, re-OCR'd or deselected after the last export
 * cannot leave a stale file behind for the next person to send on.
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
import sharp from "sharp";
import { normalizePdfText } from "../finance/pdf-report";
import { singleJpegPagePdf } from "./receipt-pdf";

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
      parts.push({ path: pdfPath, pages: selected });
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
    const bytes = await fs.promises.readFile(outPath);

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
