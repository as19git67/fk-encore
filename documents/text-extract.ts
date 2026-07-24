/**
 * PDF text extraction with OCR fallback.
 *
 * Happy path: `pdf-parse` pulls the text layer out of a digital PDF in
 * <100 ms. Fallback path (text layer empty or too short): rasterize
 * pages with `pdftoppm`, clean each page raster (auto-rotate to upright +
 * contrast-stretch gray scans toward black-on-white, see `ocr-preprocess.ts`)
 * and run `tesseract` (deu+eng) over the PNGs. The searchable PDF is built
 * from the cleaned pages, so the served/downloaded sandwich PDF keeps the
 * corrected rotation.
 *
 * When either `pdf-parse` or `pdftoppm` rejects the file as broken
 * (missing trailer dictionary / unreadable xref — common for PDFs
 * truncated in transit or assembled by buggy scanners), we attempt a
 * one-shot repair pass through `qpdf` which rewrites the file with a
 * fresh cross-reference table, then retry the failing step. If poppler
 * still rejects the original/repaired file, a slower Ghostscript repair
 * is used as a last resort only.
 *
 * The external binaries (`pdftoppm` from poppler-utils, `tesseract`
 * from tesseract-ocr, `qpdf`, `gs`) are expected to be present in the
 * backend container image — see `docker/Dockerfile.runtime` for the
 * `apt-get install` line.
 *
 * Kept deliberately small: it returns the raw text and lets the caller
 * decide what to do. No JSON, no metadata — classification happens in
 * the LLM step.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { spawn } from "child_process";
import { detectOcrRotation, preprocessOcrImage } from "./ocr-preprocess";

// pdf-parse is CJS and its default import pulls in a debug routine that
// tries to read `test/05-versions-space.pdf` when `module.parent` is
// null. Loading it via createRequire bypasses that.
const _require = createRequire(import.meta.url);
type PdfParseFn = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
const pdfParse: PdfParseFn = _require("pdf-parse");

// PDF.js (bundled inside pdf-parse) emits noisy "Warning: ..." lines
// through console.log when it hits benign edge cases while building a
// font's glyph map — most commonly "Ran out of space in font private
// use area" on PDFs that pack many custom glyphs. These warnings don't
// affect the extracted text, so we swallow a small, known-benign set
// to keep the container log readable. Anything that doesn't match the
// allow-list is passed through unchanged.
const SUPPRESSED_PDFJS_WARNINGS = [
  "Ran out of space in font private use area",
];

export function isSuppressedPdfJsWarning(message: string): boolean {
  return SUPPRESSED_PDFJS_WARNINGS.some((p) => message.includes(p)) ||
    /^Warning:\s+TT:\s+undefined function:\s+\d+\s*$/u.test(message);
}

async function pdfParseQuiet(buffer: Buffer): ReturnType<PdfParseFn> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === "string" &&
      isSuppressedPdfJsWarning(first)
    ) {
      return;
    }
    originalLog(...args);
  };
  try {
    return await pdfParse(buffer);
  } finally {
    console.log = originalLog;
  }
}

/** Minimum number of characters before we accept a text-layer result. */
const MIN_TEXT_LAYER_CHARS = parseInt(
  process.env.DOCUMENTS_MIN_TEXT_CHARS ?? "80",
  10,
);

/** Hard cap on OCR runtime per document — OCR on a large scan can be slow. */
const OCR_TIMEOUT_MS = parseInt(
  process.env.DOCUMENTS_OCR_TIMEOUT_MS ?? "600000", // 10 minutes
  10,
);

/** Poppler DPI for OCR rasterization. 200 is a good speed/quality trade-off. */
const OCR_DPI = parseInt(process.env.DOCUMENTS_OCR_DPI ?? "200", 10);

/**
 * Ghostscript is much slower than qpdf and can get stuck on deeply
 * corrupted PDFs. It is only used after poppler has also rejected the
 * original input, and this timeout keeps one bad file from occupying the
 * single text-extract worker for minutes.
 */
const GS_REPAIR_TIMEOUT_MS = parseInt(
  process.env.DOCUMENTS_GS_REPAIR_TIMEOUT_MS ?? "90000",
  10,
);

/**
 * `prepress` preserves too much detail for our use case and can produce
 * very large intermediary PDFs. We only need a structurally clean PDF for
 * poppler/Tesseract, so `printer` is the default compromise.
 */
const GS_PDFSETTINGS = process.env.DOCUMENTS_GS_PDFSETTINGS ?? "/printer";

/**
 * Minimum whitespace-to-char ratio a text layer must have before we trust
 * it. German/English prose sits around 0.14–0.18. A text layer that lost
 * *some* of its space glyphs (a very common PDF export bug, especially in
 * externally pre-OCR'd scans) drops toward 0.06–0.10; total loss goes near
 * 0. The threshold sits at 0.09 so partial loss is caught, not only the
 * catastrophic case (a real HDI insurance scan measured 0.0666 and used to
 * pass at the old 0.05 cutoff).
 */
const MIN_TEXT_LAYER_SPACE_RATIO = parseFloat(
  process.env.DOCUMENTS_MIN_SPACE_RATIO ?? "0.09",
);

/**
 * Any whitespace-separated token longer than this is considered "glued"
 * — if the fraction of glued tokens is too high, we suspect the text
 * layer dropped its spaces.
 */
const GLUED_TOKEN_LEN = 30;
const MAX_GLUED_TOKEN_RATIO = parseFloat(
  process.env.DOCUMENTS_MAX_GLUED_TOKEN_RATIO ?? "0.15",
);

/**
 * Mean token length above which we suspect merged words. Normal German /
 * English running text averages ~5–7 characters per whitespace-separated
 * token; a layer that dropped a third of its spaces roughly doubles that
 * (the reference HDI scan measured 14.3). Numeric-heavy documents (IBANs,
 * long reference numbers) can push this up legitimately, so it is only one
 * of several independent signals — never the sole trigger in practice.
 */
const MAX_MEAN_TOKEN_LEN = parseFloat(
  process.env.DOCUMENTS_MAX_MEAN_TOKEN_LEN ?? "10",
);

/**
 * Maximum share of tokens carrying an internal lowercase→uppercase boundary
 * (e.g. "LebensversicherungAG", "GutenTag"). German never writes compounds
 * with internal capitals, so such a boundary almost always marks a dropped
 * space between two words. Legitimate text — including number/IBAN-heavy
 * documents — stays near 0 %, while the reference scan hit 23.8 %, making
 * this the most precise of the space-loss signals. A handful of common
 * abbreviations ("MwSt", "kWh", "GmbH") are tolerated by the fractional
 * threshold.
 */
const MAX_INTERNAL_CAPS_RATIO = parseFloat(
  process.env.DOCUMENTS_MAX_INTERNAL_CAPS_RATIO ?? "0.08",
);

/** Internal lowercase→uppercase boundary (German merged-word signal). */
const INTERNAL_CAPS_RE = /[a-zäöüß][A-ZÄÖÜ]/;

export interface ExtractResult {
  text: string;
  source: "text_layer" | "ocr" | "mixed";
  pageCount: number;
  /**
   * A searchable ("sandwich") PDF — the rasterized pages with an
   * invisible, positioned OCR text layer baked in — produced whenever the
   * original lacked a usable text layer (source "ocr"/"mixed" or
   * `forceOcr`). Lets the in-app viewer select/copy text directly on
   * scanned pages. Null for born-digital PDFs (the original already carries
   * a selectable text layer) or when the OCR-PDF build failed.
   */
  searchablePdf: Buffer | null;
}

export interface ExtractOptions {
  /**
   * Skip the text layer entirely and always run OCR. Used to recover
   * documents whose pre-baked text layer is broken (missing spaces,
   * garbled Unicode, …).
   */
  forceOcr?: boolean;
}

/**
 * Thrown by `extractPdfText` when the PDF needs an open ("user") password
 * that we don't have. The pipeline catches this to move the document into
 * the `encrypted` state and prompt the user, rather than failing it with a
 * cryptic poppler error.
 */
export class PdfPasswordRequiredError extends Error {
  constructor(message = "PDF requires a password to open") {
    super(message);
    this.name = "PdfPasswordRequiredError";
  }
}

export type PdfEncryption = "none" | "restrictions" | "password";

/**
 * Classify a PDF's encryption with `qpdf --requires-password`:
 *   - exit 0 → an open password is required (we can't read it)
 *   - exit 3 → encrypted but opens without a password (owner/permission
 *              restrictions only — removable with `qpdf --decrypt`)
 *   - exit 2 (or anything else) → not encrypted / unknown → treat as none
 * A missing qpdf binary resolves to "none" so detection never blocks the
 * pipeline on environments without it.
 */
export function inspectPdfEncryption(absPath: string): Promise<PdfEncryption> {
  return new Promise((resolve) => {
    const proc = spawn("qpdf", ["--requires-password", absPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("error", () => resolve("none"));
    proc.on("close", (code) => {
      if (code === 0) resolve("password");
      else if (code === 3) resolve("restrictions");
      else resolve("none");
    });
  });
}

/**
 * Run `qpdf --decrypt` into `tmpDir`, optionally supplying a password.
 * Returns the decrypted file path, or null when qpdf is missing, the
 * password is wrong, or the file can't be decrypted. `--warning-exit-0`
 * keeps benign warnings (very common on real-world PDFs) from being read
 * as failures.
 */
function runQpdfDecrypt(
  srcPath: string,
  tmpDir: string,
  password?: string,
): Promise<string | null> {
  const dst = path.join(tmpDir, "decrypted.pdf");
  const args = ["--warning-exit-0", "--decrypt"];
  if (password != null) args.push(`--password=${password}`);
  args.push(srcPath, dst);
  return new Promise((resolve) => {
    const proc = spawn("qpdf", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0) resolve(dst);
      else {
        console.warn(
          `[documents.text-extract] qpdf --decrypt exited ${code}: ${stderr.trim()}`,
        );
        resolve(null);
      }
    });
  });
}

/**
 * Decrypt the PDF at `absPath` with `password` and return the plaintext
 * bytes, or null when the password is wrong / decryption fails. Used by the
 * unlock endpoint to persist a decrypted copy so no password is needed
 * thereafter.
 */
export async function decryptPdfWithPassword(
  absPath: string,
  password: string,
): Promise<Buffer | null> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docdec-"));
  try {
    const dst = await runQpdfDecrypt(absPath, tmpDir, password);
    if (!dst) return null;
    return await fs.promises.readFile(dst);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Heuristic: does `text` look like a text layer that lost its spaces?
 *
 * Combines four independent signals so both the catastrophic case (nearly
 * all spaces gone) and the more common *partial* loss (externally OCR'd
 * scans that drop maybe a third of their spaces) are caught:
 *   1. overall whitespace ratio too low,
 *   2. too many very long "glued" tokens,
 *   3. mean token length implausibly high,
 *   4. too many tokens with an internal lowercase→uppercase boundary
 *      (a dropped space between two German words).
 *
 * Any one signal is enough. The thresholds are calibrated so clean prose
 * (ratio ~0.14, mean ~5.8, 0 % internal caps) stays well clear while a real
 * partial-loss scan (ratio 0.067, mean 14.3, 23.8 % internal caps) trips
 * three of the four.
 *
 * Exported for unit testing.
 */
export function hasPoorSpacing(text: string): boolean {
  if (text.length < 200) {
    // Too short to judge reliably; let the length threshold handle it.
    return false;
  }

  const whitespace = (text.match(/\s/g) ?? []).length;
  const ratio = whitespace / text.length;
  if (ratio < MIN_TEXT_LAYER_SPACE_RATIO) return true;

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;

  const glued = tokens.filter((t) => t.length > GLUED_TOKEN_LEN).length;
  if (glued / tokens.length > MAX_GLUED_TOKEN_RATIO) return true;

  const meanTokenLen =
    tokens.reduce((sum, t) => sum + t.length, 0) / tokens.length;
  if (meanTokenLen > MAX_MEAN_TOKEN_LEN) return true;

  const internalCaps = tokens.filter((t) => INTERNAL_CAPS_RE.test(t)).length;
  if (internalCaps / tokens.length > MAX_INTERNAL_CAPS_RATIO) return true;

  return false;
}

/**
 * Extract text from the PDF at `absPath`. Returns a result describing
 * which path was taken so callers can persist that hint alongside the
 * text (useful for debugging low-quality OCR).
 *
 * When `options.forceOcr` is true, skips the text-layer fast path even
 * when it would have passed the length threshold. When the text layer
 * looks broken (see `hasPoorSpacing`), we also fall through to OCR.
 */
// Postgres `text` columns reject NUL bytes, which pdf-parse occasionally
// emits on PDFs with broken character maps (Tesla order confirmations
// being a known offender).
function stripNulBytes(text: string): string {
  return text.replace(/\u0000/g, "");
}

export async function extractPdfText(
  absPath: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  // Encryption gate. A document needing an open password can't be read at
  // all — surface that distinctly so the pipeline can prompt the user.
  // Owner/permission-only encryption opens without a password; transparently
  // strip it into a temp copy so pdf-parse/poppler/tesseract see plain bytes.
  const encryption = await inspectPdfEncryption(absPath);
  if (encryption === "password") {
    throw new PdfPasswordRequiredError();
  }

  let tmpDir: string | null = null;
  let workPath = absPath;
  try {
    if (encryption === "restrictions") {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docdec-"));
      const decrypted = await runQpdfDecrypt(absPath, tmpDir);
      if (decrypted) {
        workPath = decrypted;
        console.log(
          `[documents.text-extract] stripped owner/permission encryption before extraction`,
        );
      }
    }

    const buffer = await fs.promises.readFile(workPath);

    let textLayer = "";
    let pageCount = 0;
    let pdfParseBrokenXref = false;
    try {
      const parsed = await pdfParseQuiet(buffer);
      textLayer = stripNulBytes((parsed.text ?? "").trim());
      pageCount = parsed.numpages ?? 0;
    } catch (err) {
      // pdf-parse throws on malformed PDFs; treat as "no text layer" and
      // fall through to OCR. Remember whether the failure smells like a
      // broken xref so the OCR path can repair the file up front instead
      // of paying for a pdftoppm round-trip that's certain to fail.
      const msg = (err as Error).message;
      pdfParseBrokenXref = looksLikeBrokenXref(msg);
      console.warn(`[documents.text-extract] pdf-parse failed: ${msg}`);
    }

    const textLayerLooksGood =
      textLayer.length >= MIN_TEXT_LAYER_CHARS && !hasPoorSpacing(textLayer);

    if (options.forceOcr) {
      console.log(`[documents.text-extract] force_ocr=true — skipping text layer`);
    } else if (textLayerLooksGood) {
      console.log(
        `[documents.text-extract] text layer looks good — running OCR anyway for consistency`,
      );
    } else if (textLayer.length >= MIN_TEXT_LAYER_CHARS) {
      console.log(
        `[documents.text-extract] text layer looks broken (low space ratio) — running OCR`,
      );
    }

    // Only spend the extra tesseract PDF-rendering pass when the original
    // lacks a usable text layer — born-digital PDFs are already selectable in
    // the viewer, so a sandwich PDF would just duplicate them.
    const wantSearchablePdf = options.forceOcr || !textLayerLooksGood;
    const ocr = await ocrPdf(workPath, {
      repairFirst: pdfParseBrokenXref,
      wantSearchablePdf,
    });
    const ocrText = ocr.text;

    // When forceOcr is set or the text layer is broken, prefer OCR outright.
    // When the text layer looks good and OCR also succeeded, prefer the text
    // layer — it's typically cleaner than OCR for born-digital PDFs.
    if (!options.forceOcr && textLayerLooksGood) {
      return { text: textLayer, source: "text_layer", pageCount, searchablePdf: null };
    }

    if (
      !options.forceOcr &&
      textLayer.length > 0 &&
      textLayer.length < MIN_TEXT_LAYER_CHARS &&
      ocrText.length > 0
    ) {
      return {
        text: `${textLayer}\n\n${ocrText}`.trim(),
        source: "mixed",
        pageCount,
        searchablePdf: ocr.searchablePdf,
      };
    }
    return { text: ocrText, source: "ocr", pageCount, searchablePdf: ocr.searchablePdf };
  } finally {
    if (tmpDir) {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface OcrResult {
  text: string;
  /**
   * Merged searchable PDF (rasterized pages + invisible OCR text layer),
   * present only when `wantSearchablePdf` was requested and the build
   * succeeded. Null otherwise.
   */
  searchablePdf: Buffer | null;
}

/**
 * OCR every page of a PDF by rasterizing with pdftoppm and feeding the
 * PNGs to tesseract. Concatenates the page texts with blank lines in
 * between so tesseract sentence boundaries survive the join.
 *
 * When `wantSearchablePdf` is set, tesseract additionally emits a
 * single-page searchable PDF per page (the image with an invisible,
 * positioned text layer); these are merged with `pdfunite` into one
 * sandwich PDF and returned. This is best-effort: a failure to build the
 * PDF never affects the extracted text.
 *
 * When `repairFirst` is true (set by the caller after pdf-parse already
 * rejected the file as having a broken xref), we run qpdf eagerly so
 * pdftoppm doesn't have to fail first. Ghostscript is intentionally not
 * part of that eager path: pdf-parse can reject files that poppler still
 * rasterizes, and gs is expensive. We only escalate to gs after pdftoppm
 * has actually failed with a repairable PDF-structure error.
 */
async function ocrPdf(
  absPath: string,
  options: { repairFirst?: boolean; wantSearchablePdf?: boolean } = {},
): Promise<OcrResult> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docscan-"));
  try {
    let pdfPath = absPath;
    if (options.repairFirst) {
      const repaired = await repairPdfWithQpdf(pdfPath, tmpDir);
      if (repaired) pdfPath = repaired;
    }

    try {
      await runPdftoppm(pdfPath, path.join(tmpDir, "page"));
    } catch (err) {
      // Many scanners and online tools emit PDFs whose cross-reference
      // table is missing or truncated. poppler refuses to recover, but
      // qpdf rebuilds a valid xref. Only retry once, and only when the
      // failure signature matches — anything else (e.g. a missing
      // pdftoppm binary, encrypted PDFs) falls straight through.
      if (looksLikeBrokenXref((err as Error).message)) {
        const repaired = await repairPdf(pdfPath, tmpDir);
        if (repaired) {
          console.log(
            `[documents.text-extract] pdftoppm rejected broken xref — retrying after PDF repair`,
          );
          pdfPath = repaired;
          await runPdftoppm(pdfPath, path.join(tmpDir, "page"));
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const entries = (await fs.promises.readdir(tmpDir))
      .filter((n) => n.toLowerCase().endsWith(".png"))
      .sort();
    if (entries.length === 0) return { text: "", searchablePdf: null };

    const parts: string[] = [];
    const pagePdfs: string[] = [];
    const started = Date.now();
    for (let i = 0; i < entries.length; i++) {
      if (Date.now() - started > OCR_TIMEOUT_MS) {
        console.warn("[documents.text-extract] OCR timeout reached, truncating");
        break;
      }
      const rawPagePath = path.join(tmpDir, entries[i]);
      const outBase = path.join(tmpDir, `ocr-${String(i).padStart(4, "0")}`);
      // Clean up the raster before recognition: detect and correct a
      // 90°/180°/270° misrotation, then lift the contrast toward black-on-
      // white so gray-paper scans read well. Best-effort — a failure leaves
      // `pagePath` pointing at the untouched raster, so OCR never regresses.
      // The searchable PDF is built from `pagePath`, so any rotation applied
      // here is baked into the downloaded/served sandwich PDF as well.
      let pagePath = rawPagePath;
      const rotate = await detectOcrRotation(rawPagePath);
      const prepPath = path.join(tmpDir, `prep-${String(i).padStart(4, "0")}.png`);
      if (await preprocessOcrImage(rawPagePath, prepPath, { rotate })) {
        pagePath = prepPath;
      }
      // tesseract appends the extension per output config (`txt`, `pdf`).
      const configs = options.wantSearchablePdf ? ["txt", "pdf"] : ["txt"];
      try {
        await runTesseract(pagePath, outBase, configs);
        const txt = await fs.promises
          .readFile(`${outBase}.txt`, "utf8")
          .catch(() => "");
        if (txt.trim().length > 0) parts.push(txt.trim());
        if (options.wantSearchablePdf) {
          const pdf = `${outBase}.pdf`;
          if (await fileReadable(pdf)) pagePdfs.push(pdf);
        }
      } catch (err) {
        console.warn(
          `[documents.text-extract] tesseract failed on ${entries[i]}: ${(err as Error).message}`,
        );
      }
    }

    let searchablePdf: Buffer | null = null;
    if (options.wantSearchablePdf && pagePdfs.length > 0) {
      searchablePdf = await mergePdfs(pagePdfs, tmpDir).catch((err) => {
        console.warn(
          `[documents.text-extract] merging OCR page PDFs failed: ${(err as Error).message}`,
        );
        return null;
      });
    }

    return { text: parts.join("\n\n").trim(), searchablePdf };
  } finally {
    // Best-effort cleanup — never throw from the finally block.
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build a searchable ("sandwich") PDF for `absPath` on demand — used to
 * give documents imported before the OCR-layer feature (or that simply
 * never went through OCR) a selectable text layer at download time.
 * Returns the merged PDF bytes, or null when the document has no
 * rasterizable pages or the OCR build failed. Never throws.
 */
export async function buildSearchablePdf(absPath: string): Promise<Buffer | null> {
  let brokenXref = false;
  try {
    const buffer = await fs.promises.readFile(absPath);
    try {
      await pdfParseQuiet(buffer);
    } catch (err) {
      brokenXref = looksLikeBrokenXref((err as Error).message);
    }
  } catch {
    return null;
  }
  try {
    const result = await ocrPdf(absPath, {
      repairFirst: brokenXref,
      wantSearchablePdf: true,
    });
    return result.searchablePdf;
  } catch (err) {
    console.warn(
      `[documents.text-extract] buildSearchablePdf failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Does the PDF at `absPath` already carry a usable text layer? Mirrors the
 * fast-path decision in `extractPdfText` so the download endpoint can skip
 * the expensive OCR pass for born-digital PDFs (which are already
 * selectable in the viewer). Returns false on any read/parse failure.
 */
export async function hasUsableTextLayer(absPath: string): Promise<boolean> {
  try {
    const buffer = await fs.promises.readFile(absPath);
    const parsed = await pdfParseQuiet(buffer);
    const text = stripNulBytes((parsed.text ?? "").trim());
    return text.length >= MIN_TEXT_LAYER_CHARS && !hasPoorSpacing(text);
  } catch {
    return false;
  }
}

async function fileReadable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run tesseract on a single image, writing the requested output formats
 * (`txt`, `pdf`, …) to `<outBase>.<ext>`.
 */
function runTesseract(imagePath: string, outBase: string, configs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const lang = process.env.DOCUMENTS_OCR_LANG ?? "deu+eng";
    // `preserve_interword_spaces=1` keeps tesseract from collapsing the gaps
    // between words when the source layout is dense — the same missing-space
    // symptom we detect in externally OCR'd layers, so our own re-OCR must
    // not reproduce it.
    const proc = spawn(
      "tesseract",
      [
        imagePath,
        outBase,
        "-l",
        lang,
        "--oem",
        "1",
        "--psm",
        "3",
        "-c",
        "preserve_interword_spaces=1",
        ...configs,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tesseract exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Merge per-page PDFs into one with `pdfunite` and return the bytes.
 * A single page is read back directly — pdfunite needs at least two
 * input files.
 */
async function mergePdfs(pagePdfs: string[], tmpDir: string): Promise<Buffer> {
  if (pagePdfs.length === 1) {
    return fs.promises.readFile(pagePdfs[0]);
  }
  const merged = path.join(tmpDir, "searchable.pdf");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pdfunite", [...pagePdfs, merged], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pdfunite exited ${code}: ${stderr.trim()}`));
    });
  });
  return fs.promises.readFile(merged);
}

function runPdftoppm(pdfPath: string, outPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pdftoppm",
      ["-r", String(OCR_DPI), "-png", pdfPath, outPrefix],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Stderr signatures that mean poppler (or pdf.js inside pdf-parse)
 * gave up because the cross-reference table or trailer is unreadable.
 * These are recoverable by `qpdf` in the vast majority of cases.
 *
 * Exported for unit testing.
 */
export function looksLikeBrokenXref(stderr: string): boolean {
  if (!stderr) return false;
  return /Couldn't find trailer dictionary|Couldn't read xref table|Catalog object is wrong type|May not be a PDF file|Invalid XRef|FormatError: Bad \(uncompressed\) XRef/i.test(
    stderr,
  );
}

/**
 * Rewrite `srcPath` through qpdf so a broken xref/trailer is rebuilt.
 * When qpdf fails after poppler has also rejected the file, fall back to
 * Ghostscript which re-renders the entire file from scratch and handles
 * deeper structural corruption. This function must not be called on the
 * eager pdf-parse failure path — use `repairPdfWithQpdf` there so gs does
 * not run before poppler had a chance to accept the original PDF.
 * Returns the repaired file path, or null when both tools fail.
 */
async function repairPdf(srcPath: string, tmpDir: string): Promise<string | null> {
  const qpdfResult = await repairPdfWithQpdf(srcPath, tmpDir);
  if (qpdfResult) return qpdfResult;
  return repairPdfWithGs(srcPath, tmpDir);
}

function repairPdfWithQpdf(srcPath: string, tmpDir: string): Promise<string | null> {
  const dst = path.join(tmpDir, "repaired-qpdf.pdf");
  return new Promise((resolve) => {
    const proc = spawn(
      "qpdf",
      ["--warning-exit-0", srcPath, dst],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      console.warn(
        `[documents.text-extract] qpdf unavailable for repair: ${err.message}`,
      );
      resolve(null);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(dst);
      } else {
        console.warn(
          `[documents.text-extract] qpdf repair exited ${code}: ${stderr.trim()}`,
        );
        resolve(null);
      }
    });
  });
}

/**
 * Ghostscript fallback: `gs -sDEVICE=pdfwrite` re-interprets the PDF
 * instructions from scratch and writes a clean file. Slower than qpdf
 * but handles cases where the internal structure is too broken for a
 * simple xref rewrite (missing trailer dictionary, corrupted object
 * streams, truncated files).
 */
function repairPdfWithGs(srcPath: string, tmpDir: string): Promise<string | null> {
  const dst = path.join(tmpDir, "repaired-gs.pdf");
  return new Promise((resolve) => {
    const proc = spawn(
      "gs",
      [
        "-dQUIET",
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-sDEVICE=pdfwrite",
        `-dPDFSETTINGS=${GS_PDFSETTINGS}`,
        `-sOutputFile=${dst}`,
        srcPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.warn(
        `[documents.text-extract] gs repair timed out after ${GS_REPAIR_TIMEOUT_MS}ms`,
      );
      proc.kill("SIGKILL");
      finish(null);
    }, GS_REPAIR_TIMEOUT_MS);
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      console.warn(
        `[documents.text-extract] gs unavailable for repair: ${err.message}`,
      );
      finish(null);
    });
    proc.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        console.log(
          `[documents.text-extract] gs repair succeeded (qpdf had failed)`,
        );
        finish(dst);
      } else {
        console.warn(
          `[documents.text-extract] gs repair exited ${code}: ${stderr.trim()}`,
        );
        finish(null);
      }
    });
  });
}
