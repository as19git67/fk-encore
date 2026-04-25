/**
 * PDF text extraction with OCR fallback.
 *
 * Happy path: `pdf-parse` pulls the text layer out of a digital PDF in
 * <100 ms. Fallback path (text layer empty or too short): rasterize
 * pages with `pdftoppm` and run `tesseract` (deu+eng) over the PNGs.
 *
 * Both external binaries (`pdftoppm` from poppler-utils, `tesseract`
 * from tesseract-ocr) are expected to be present in the backend
 * container image — see `docker-compose.yml` for the `apt-get install`
 * line.
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
  try {
    const parsed = await pdfParseQuiet(buffer);
    textLayer = stripNulBytes((parsed.text ?? "").trim());
    pageCount = parsed.numpages ?? 0;
  } catch (err) {
    // pdf-parse throws on malformed PDFs; treat as "no text layer" and
    // fall through to OCR.
    console.warn(`[documents.text-extract] pdf-parse failed: ${(err as Error).message}`);
  }

  const textLayerLooksGood =
    textLayer.length >= MIN_TEXT_LAYER_CHARS && !hasPoorSpacing(textLayer);

  if (!options.forceOcr && textLayerLooksGood) {
    return { text: textLayer, source: "text_layer", pageCount };
  }

  if (options.forceOcr) {
    console.log(`[documents.text-extract] force_ocr=true — skipping text layer`);
  } else if (textLayer.length >= MIN_TEXT_LAYER_CHARS) {
    console.log(
      `[documents.text-extract] text layer looks broken (low space ratio) — running OCR`,
    );
  }

  const ocrText = await ocrPdf(absPath);

  // When we intentionally skipped a usable-length text layer (forceOcr
  // or poor spacing), prefer the OCR result outright and don't pollute
  // it with the broken text layer. Only fall back to "mixed" when the
  // text layer was sub-threshold but non-empty and OCR succeeded — the
  // original "some text is better than none" safety net.
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
 */
async function ocrPdf(absPath: string): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docscan-"));
  try {
    await runPdftoppm(absPath, path.join(tmpDir, "page"));

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
