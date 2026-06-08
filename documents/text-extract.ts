/**
 * PDF text extraction with OCR fallback.
 *
 * Happy path: `pdf-parse` pulls the text layer out of a digital PDF in
 * <100 ms. Fallback path (text layer empty or too short): rasterize
 * pages with `pdftoppm` and run `tesseract` (deu+eng) over the PNGs.
 *
 * When either `pdf-parse` or `pdftoppm` rejects the file as broken
 * (missing trailer dictionary / unreadable xref — common for PDFs
 * truncated in transit or assembled by buggy scanners), we attempt a
 * one-shot repair pass through `qpdf` which rewrites the file with a
 * fresh cross-reference table, then retry the failing step.
 *
 * The external binaries (`pdftoppm` from poppler-utils, `tesseract`
 * from tesseract-ocr, `qpdf`) are expected to be present in the
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
import tesseract from "node-tesseract-ocr";

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

async function pdfParseQuiet(buffer: Buffer): ReturnType<PdfParseFn> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === "string" &&
      SUPPRESSED_PDFJS_WARNINGS.some((p) => first.includes(p))
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
 * Minimum whitespace-to-char ratio a text layer must have before we trust
 * it. German/English prose sits around 0.14–0.18. A text layer that
 * lost its space glyphs (a very common PDF export bug, especially in
 * pre-OCR'd scans) drops well below 0.05 — those end up classified as
 * "poor spacing" and we fall through to OCR.
 */
const MIN_TEXT_LAYER_SPACE_RATIO = parseFloat(
  process.env.DOCUMENTS_MIN_SPACE_RATIO ?? "0.05",
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

export interface ExtractResult {
  text: string;
  source: "text_layer" | "ocr" | "mixed";
  pageCount: number;
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
 * Heuristic: does `text` look like a text layer that lost its spaces?
 * Returns true when either the overall whitespace ratio is implausibly
 * low or an unusual share of tokens is very long.
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
  const buffer = await fs.promises.readFile(absPath);

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

  const ocrText = await ocrPdf(absPath, { repairFirst: pdfParseBrokenXref });

  // When forceOcr is set or the text layer is broken, prefer OCR outright.
  // When the text layer looks good and OCR also succeeded, prefer the text
  // layer — it's typically cleaner than OCR for born-digital PDFs.
  if (!options.forceOcr && textLayerLooksGood) {
    return { text: textLayer, source: "text_layer", pageCount };
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
    };
  }
  return { text: ocrText, source: "ocr", pageCount };
}

/**
 * OCR every page of a PDF by rasterizing with pdftoppm and feeding the
 * PNGs to tesseract. Concatenates the page texts with blank lines in
 * between so tesseract sentence boundaries survive the join.
 *
 * When `repairFirst` is true (set by the caller after pdf-parse already
 * rejected the file as having a broken xref), we run qpdf eagerly so
 * pdftoppm doesn't have to fail first.
 */
async function ocrPdf(
  absPath: string,
  options: { repairFirst?: boolean } = {},
): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docscan-"));
  try {
    let pdfPath = absPath;
    if (options.repairFirst) {
      const repaired = await repairPdf(pdfPath, tmpDir);
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
      if (pdfPath === absPath && looksLikeBrokenXref((err as Error).message)) {
        const repaired = await repairPdf(pdfPath, tmpDir);
        if (repaired) {
          console.log(
            `[documents.text-extract] pdftoppm rejected broken xref — retrying after qpdf repair`,
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
    if (entries.length === 0) return "";

    const parts: string[] = [];
    const started = Date.now();
    for (const entry of entries) {
      if (Date.now() - started > OCR_TIMEOUT_MS) {
        console.warn("[documents.text-extract] OCR timeout reached, truncating");
        break;
      }
      const pagePath = path.join(tmpDir, entry);
      try {
        const text = await tesseract.recognize(pagePath, {
          lang: process.env.DOCUMENTS_OCR_LANG ?? "deu+eng",
          oem: 1,
          psm: 3,
        });
        if (text && text.trim().length > 0) parts.push(text.trim());
      } catch (err) {
        console.warn(
          `[documents.text-extract] tesseract failed on ${entry}: ${(err as Error).message}`,
        );
      }
    }
    return parts.join("\n\n").trim();
  } finally {
    // Best-effort cleanup — never throw from the finally block.
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
 * Returns the repaired file path, or null when qpdf is unavailable or
 * also fails on the input (in which case the caller should propagate
 * the original poppler/pdf-parse error rather than masking it).
 */
function repairPdf(srcPath: string, tmpDir: string): Promise<string | null> {
  const dst = path.join(tmpDir, "repaired.pdf");
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
      // ENOENT: qpdf missing from the image. Don't crash the worker —
      // surface the original failure to the caller instead.
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
