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

export interface ExtractResult {
  text: string;
  source: "text_layer" | "ocr" | "mixed";
  pageCount: number;
}

/**
 * Extract text from the PDF at `absPath`. Returns a result describing
 * which path was taken so callers can persist that hint alongside the
 * text (useful for debugging low-quality OCR).
 */
export async function extractPdfText(absPath: string): Promise<ExtractResult> {
  const buffer = await fs.promises.readFile(absPath);

  let textLayer = "";
  let pageCount = 0;
  try {
    const parsed = await pdfParse(buffer);
    textLayer = (parsed.text ?? "").trim();
    pageCount = parsed.numpages ?? 0;
  } catch (err) {
    // pdf-parse throws on malformed PDFs; treat as "no text layer" and
    // fall through to OCR.
    console.warn(`[documents.text-extract] pdf-parse failed: ${(err as Error).message}`);
  }

  if (textLayer.length >= MIN_TEXT_LAYER_CHARS) {
    return { text: textLayer, source: "text_layer", pageCount };
  }

  const ocrText = await ocrPdf(absPath);
  if (textLayer.length > 0 && ocrText.length > 0) {
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
