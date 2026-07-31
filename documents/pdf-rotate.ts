/**
 * Upright rendering for born-digital PDFs whose pages are drawn sideways.
 *
 * A scanned PDF that comes in rotated is straightened by the OCR path: the
 * page rasters are turned upright (`ocr-preprocess.ts`) and the searchable
 * "sandwich" PDF is built from those, so viewer and download show it the
 * right way up. A *born-digital* PDF never takes that path — it already has a
 * text layer, so no sandwich is built and the original is served untouched.
 *
 * Some of those originals are sideways all the same. A wide table exported to
 * A4 portrait is the common case: the producer rotates the content 90° to make
 * it fit, leaving a page whose `/Rotate` is 0 but whose text runs bottom-to-top
 * (observed: a Banking4 account statement). Every reader shows it sideways,
 * ours included.
 *
 * This module produces an upright copy for those. Two properties matter:
 *
 *   - **Lossless.** The fix is the page's `/Rotate` attribute, applied with
 *     `qpdf` — not a rasterize-and-rebuild. The text stays vector text, stays
 *     selectable and searchable, and the file stays small.
 *   - **Cheap when there is nothing to do.** The overwhelming majority of
 *     born-digital PDFs are upright, and they must not pay for a rasterization
 *     pass to prove it. `pdftotext -bbox` gives word boxes in milliseconds, and
 *     sideways text is unmistakable there: a 17-character word measured 6pt
 *     wide and 57pt tall on the document above. Only a page that fails this
 *     cheap screen is rasterized to have Tesseract name the exact angle —
 *     the box shape reveals that text runs vertically, not which way is up.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { detectOcrRotation } from "./ocr-preprocess";

console.log("[boot] documents/pdf-rotate.ts: all imports resolved");

/** Master switch for the whole upright-copy feature. */
const UPRIGHT_ENABLED = envFlag("DOCUMENTS_PDF_UPRIGHT", true);

/**
 * Render DPI for the page images the exact-angle detection works on. Matches
 * the OCR path's default: Tesseract's orientation detection needs enough
 * pixels per glyph, and reported "Too few characters" at 100 dpi on a page it
 * read fine at 200.
 */
const DETECT_DPI = parseInt(process.env.DOCUMENTS_OCR_DPI ?? "200", 10);

/**
 * Cap on how many pages are rasterized to determine the exact angle. Producers
 * rotate whole documents, not individual pages, so the first few settle it;
 * the cap keeps a 200-page export from turning first view into a long wait.
 * Pages past the cap inherit the angle found for the pages before them.
 */
const MAX_DETECT_PAGES = parseInt(process.env.DOCUMENTS_PDF_UPRIGHT_MAX_PAGES ?? "3", 10);

/** Words shorter than this are too close to square to judge orientation from. */
const MIN_WORD_LEN = 3;

/** How many measurable words a page needs before its shape means anything. */
const MIN_WORDS = 5;

/** Share of words that must be taller than wide for a page to look sideways. */
const ROTATED_WORD_SHARE = 0.7;

export interface WordBox {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PageWords {
  /** 1-based page number, matching qpdf's and pdftoppm's numbering. */
  page: number;
  words: WordBox[];
}

const PAGE_RE = /<page\b[^>]*>([\s\S]*?)<\/page>/g;
const WORD_RE =
  /<word\s+xMin="([\d.eE+-]+)"\s+yMin="([\d.eE+-]+)"\s+xMax="([\d.eE+-]+)"\s+yMax="([\d.eE+-]+)"\s*>([\s\S]*?)<\/word>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse the XHTML `pdftotext -bbox` writes into per-page word boxes. Returns
 * an empty array for output this doesn't understand, which callers read as
 * "no evidence" — never as "not rotated proven".
 */
export function parseWordBoxes(xml: string): PageWords[] {
  const pages: PageWords[] = [];
  PAGE_RE.lastIndex = 0;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = PAGE_RE.exec(xml)) !== null) {
    const words: WordBox[] = [];
    WORD_RE.lastIndex = 0;
    let wordMatch: RegExpExecArray | null;
    while ((wordMatch = WORD_RE.exec(pageMatch[1])) !== null) {
      const [, xMin, yMin, xMax, yMax, text] = wordMatch;
      const box = {
        text: decodeEntities(text).trim(),
        xMin: Number(xMin),
        yMin: Number(yMin),
        xMax: Number(xMax),
        yMax: Number(yMax),
      };
      if (!box.text) continue;
      if (![box.xMin, box.yMin, box.xMax, box.yMax].every(Number.isFinite)) continue;
      words.push(box);
    }
    pages.push({ page: pages.length + 1, words });
  }
  return pages;
}

/**
 * Whether a page's text is drawn on the vertical axis. Upright text lays a
 * multi-character word out wider than it is tall, whatever the font size;
 * rotating the page swaps that. Judged on a share of the words rather than
 * all of them, so a rotated stamp or a vertical margin label on an otherwise
 * upright page doesn't flip the verdict. Pure; unit-tested.
 */
export function pageLooksRotated(words: readonly WordBox[]): boolean {
  const measurable = words.filter((w) => w.text.length >= MIN_WORD_LEN);
  if (measurable.length < MIN_WORDS) return false;
  const tall = measurable.filter((w) => w.yMax - w.yMin > w.xMax - w.xMin).length;
  return tall / measurable.length >= ROTATED_WORD_SHARE;
}

/**
 * Page numbers (1-based) whose text looks sideways, from the cheap screen
 * alone. Returns an empty array when `pdftotext` is unavailable or produced
 * nothing usable — the caller then leaves the document alone.
 */
export async function findSidewaysPages(absPath: string): Promise<number[]> {
  let xml: string;
  try {
    xml = await runPdfToTextBbox(absPath);
  } catch (err) {
    console.warn(
      `[documents.pdf-rotate] pdftotext -bbox failed for ${path.basename(absPath)}: ${(err as Error).message}`,
    );
    return [];
  }
  return parseWordBoxes(xml)
    .filter((p) => pageLooksRotated(p.words))
    .map((p) => p.page);
}

/**
 * Build the qpdf arguments that rotate each page by its angle, grouping pages
 * that share one. Returns an empty array when there is nothing to rotate.
 * Pure; unit-tested.
 */
export function rotateArgs(rotations: ReadonlyMap<number, number>): string[] {
  const byAngle = new Map<number, number[]>();
  for (const [page, angle] of rotations) {
    if (angle === 0) continue;
    const list = byAngle.get(angle);
    if (list) list.push(page);
    else byAngle.set(angle, [page]);
  }
  return Array.from(byAngle.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([angle, pages]) => `--rotate=+${angle}:${pages.sort((a, b) => a - b).join(",")}`);
}

/**
 * Determine the clockwise angle each sideways page needs, by rasterizing it
 * and asking the OCR path's orientation detection (which also verifies a
 * low-confidence answer against recognition quality — see `ocr-preprocess.ts`).
 *
 * Only the first `MAX_DETECT_PAGES` candidates are measured; the rest inherit
 * the angle those agreed on, and are left alone if they disagreed.
 */
async function detectAngles(
  absPath: string,
  candidates: readonly number[],
  tmpDir: string,
): Promise<Map<number, number>> {
  const rotations = new Map<number, number>();
  const probed = candidates.slice(0, Math.max(1, MAX_DETECT_PAGES));
  for (const page of probed) {
    const prefix = path.join(tmpDir, `p${page}`);
    try {
      await renderPage(absPath, page, prefix);
      const angle = await detectOcrRotation(`${prefix}.png`);
      if (angle !== 0) rotations.set(page, angle);
    } catch (err) {
      console.warn(
        `[documents.pdf-rotate] could not measure page ${page}: ${(err as Error).message}`,
      );
    }
  }

  // Extend a unanimous verdict to the candidates we didn't measure.
  const angles = new Set(rotations.values());
  if (angles.size === 1 && rotations.size === probed.length) {
    const [angle] = angles;
    for (const page of candidates.slice(probed.length)) rotations.set(page, angle);
  }
  return rotations;
}

/**
 * Write an upright copy of `absPath` to `destPath` when its pages are drawn
 * sideways. Returns true when a copy was written, false when the document is
 * already upright (or nothing could be determined) and the original should be
 * served as-is. Best-effort: never throws.
 */
export async function buildUprightPdf(absPath: string, destPath: string): Promise<boolean> {
  if (!UPRIGHT_ENABLED) return false;
  let tmpDir: string | null = null;
  try {
    const candidates = await findSidewaysPages(absPath);
    if (candidates.length === 0) return false;

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-pdfrotate-"));
    const rotations = await detectAngles(absPath, candidates, tmpDir);
    const args = rotateArgs(rotations);
    if (args.length === 0) return false;

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await runQpdf([...args, absPath, destPath]);
    console.log(
      `[documents.pdf-rotate] wrote upright copy of ${path.basename(absPath)} (${args.join(" ")})`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[documents.pdf-rotate] upright copy of ${path.basename(absPath)} failed: ${(err as Error).message}`,
    );
    // A half-written output must not be served as if it were valid.
    await fs.promises.rm(destPath, { force: true }).catch(() => {});
    return false;
  } finally {
    if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runPdfToTextBbox(absPath: string): Promise<string> {
  return run("pdftotext", ["-bbox", absPath, "-"], true);
}

function renderPage(absPath: string, page: number, outPrefix: string): Promise<string> {
  return run("pdftoppm", [
    "-f", String(page),
    "-l", String(page),
    "-r", String(DETECT_DPI),
    "-png", "-singlefile",
    absPath, outPrefix,
  ]);
}

function runQpdf(args: string[]): Promise<string> {
  // Benign warnings are very common on real-world PDFs; qpdf still writes a
  // valid output for them, so don't treat exit code 3 as a failure.
  return run("qpdf", ["--warning-exit-0", ...args]);
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
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

function envFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false";
}
