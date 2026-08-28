/**
 * PDF text extraction with OCR fallback.
 *
 * Happy path: `pdf-parse` pulls the text layer out of a digital PDF in
 * <100 ms. Fallback path (text layer empty or too short): rasterize
 * pages with `pdftoppm`, clean each page raster (auto-rotate to upright +
 * contrast-stretch gray scans toward black-on-white, see `ocr-preprocess.ts`)
 * and run `tesseract` (deu+eng) over the PNGs. The searchable PDF is built
 * from the cleaned pages, so the served/downloaded sandwich PDF keeps the
 * corrected rotation. When the primary pass finds no "#1234"-style
 * document-number marker, page 1 gets one extra `--psm 11` (sparse text)
 * pass to recover markers that sit isolated in a corner next to a logo/box —
 * see `NUMBER_MARKER_FALLBACK_ENABLED` below.
 *
 * The OCR'd page text is not tesseract's `txt` rendering but a reconstruction
 * from the word boxes in its TSV output (`ocr-layout.ts`), so text that sits
 * on one visual line stays on one line even when tesseract split the page into
 * several blocks — see `OCR_LAYOUT_REBUILD_ENABLED` below.
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
 * decide what to do. No JSON, no metadata — classification happens in the
 * LLM step. The one narrow exception is `DOCUMENT_NUMBER_RE`, imported from
 * `metadata-extract.ts` only to check whether the marker is *present* (so
 * the sparse-text fallback above knows whether it's needed) — the actual
 * digits are still parsed exclusively in `metadata-extract.ts`.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { spawn } from "child_process";
import { PageRotationSampler, preprocessOcrImage } from "./ocr-preprocess";
import {
  layoutTextFromRows,
  parseTesseractTsv,
  shouldUseLayoutText,
  visualRowsFromWords,
} from "./ocr-layout";
import { findUncertainSpans } from "./ocr-uncertainty";
import { buildFieldMap, findUnpairedLabels } from "./ocr-fields";
import {
  formatResolverTally,
  newResolverTally,
  newVlmBudget,
  resolveFieldAssignment,
  resolvePage,
  shouldAskForFieldAssignment,
  tallyDecisions,
  SECOND_ENGINE_ENABLED,
  VLM_ENABLED,
  type ResolvedSpan,
} from "./ocr-resolver";
import { tesseractEnv } from "./tesseract-env";
import { renderPageWithSpacing } from "./pdf-text-layout";
import { DOCUMENT_NUMBER_RE } from "./metadata-extract";

// pdf-parse is CJS and its default import pulls in a debug routine that
// tries to read `test/05-versions-space.pdf` when `module.parent` is
// null. Loading it via createRequire bypasses that.
const _require = createRequire(import.meta.url);
type PdfParseOptions = { pagerender?: (page: never) => Promise<string> };
type PdfParseFn = (
  buffer: Buffer,
  options?: PdfParseOptions,
) => Promise<{ text: string; numpages: number }>;
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

/**
 * Hand pdf-parse bytes that own their `ArrayBuffer`.
 *
 * Node pools allocations under 8 KB: `fs.readFile` on a small file returns a
 * Buffer that is a *view* into a shared 8192-byte pool, with a non-zero
 * `byteOffset`. The pdf.js build bundled inside pdf-parse reads the underlying
 * ArrayBuffer without honouring that offset, so it parses the pool — other
 * files' bytes — instead of the PDF, and throws `bad XRef entry` on a document
 * that is perfectly valid (poppler reads it without complaint).
 *
 * The effect is silent and one-directional: every PDF under ~8 KB fails the
 * text-layer read and falls through to OCR, which is both far slower and worse
 * than the text layer it already had. Larger files get their own ArrayBuffer at
 * offset 0 and were never affected, which is why this went unnoticed.
 *
 * `new Uint8Array(n)` always allocates its own exactly-sized ArrayBuffer, so
 * copying into one sidesteps the pool. The copy costs a few microseconds on
 * files this small.
 */
export function ownedBytes(buffer: Buffer): Uint8Array {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
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
    // Restore the separators pdf-parse drops between items on one baseline —
    // see pdf-text-layout.ts.
    return await pdfParse(ownedBytes(buffer) as unknown as Buffer, {
      pagerender: renderPageWithSpacing as PdfParseOptions["pagerender"],
    });
  } finally {
    console.log = originalLog;
  }
}

/** Minimum number of characters before we accept a text-layer result. */
const MIN_TEXT_LAYER_CHARS = parseInt(
  process.env.DOCUMENTS_MIN_TEXT_CHARS ?? "80",
  10,
);

/**
 * Whether to re-scan page 1 with a sparse-text Tesseract pass (`--psm 11`)
 * when the primary `--psm 3` OCR text has no "#1234"-style document-number
 * marker. Verified against real scans (#892 follow-up): such markers sit
 * isolated in a page corner, often right next to a logo or decorative box,
 * and Tesseract's default layout analysis regularly fuses that corner into
 * the neighboring graphic and drops it — even though the same marker OCRs
 * correctly in sparse-text mode on the very same, unmodified page. Only
 * runs when the primary pass found nothing (the common case), so the extra
 * Tesseract call is rare in practice.
 */
const NUMBER_MARKER_FALLBACK_ENABLED =
  (process.env.DOCUMENTS_OCR_NUMBER_FALLBACK ?? "1") !== "0";

/**
 * Whether to rebuild each OCR'd page's text from the word boxes in Tesseract's
 * TSV output instead of taking its `txt` rendering verbatim — see
 * `ocr-layout.ts` for why the two differ and when it matters. On by default;
 * set `DOCUMENTS_OCR_LAYOUT=0` to fall back to the plain text of a single
 * Tesseract pass (the reconstruction costs no extra pass, only the TSV
 * output file).
 */
const OCR_LAYOUT_REBUILD_ENABLED =
  (process.env.DOCUMENTS_OCR_LAYOUT ?? "1") !== "0";

/** Hard cap on OCR runtime per document — OCR on a large scan can be slow. */
const OCR_TIMEOUT_MS = parseInt(
  process.env.DOCUMENTS_OCR_TIMEOUT_MS ?? "600000", // 10 minutes
  10,
);

/**
 * Whether to log one timing line per OCR'd page. On by default: OCR is the
 * pipeline's slowest step by a wide margin, and a per-document total says that
 * a document was slow without saying which stage was — rasterizing, rotation
 * detection, contrast cleanup, recognition, or the layout rebuild are wildly
 * different costs with wildly different fixes. One line per page is
 * proportional to the work actually done. Set DOCUMENTS_OCR_TIMING_PAGES=0 to
 * keep only the per-document summary.
 */
const OCR_TIMING_PER_PAGE =
  (process.env.DOCUMENTS_OCR_TIMING_PAGES ?? "1") !== "0";

/** Milliseconds since `from`, rounded — the unit every timing log below uses. */
function since(from: number): number {
  return Math.round(Date.now() - from);
}

/**
 * Run `fn`, returning its value alongside how long it took. Keeps the timing
 * out of the call sites, which otherwise need a `const t = Date.now()` line
 * per step and drift out of sync with what they claim to measure.
 */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: since(started) };
}

/** Poppler DPI for OCR rasterization. 200 is a good speed/quality trade-off. */
const OCR_DPI = parseInt(process.env.DOCUMENTS_OCR_DPI ?? "200", 10);

/**
 * Word confidence below which a span is handed to the resolver. Only read when
 * a resolver stage is actually enabled — with both off, the uncertainty scan
 * does not run at all and this costs nothing.
 */
const OCR_CONF_THRESHOLD = parseInt(process.env.DOCUMENTS_OCR_CONF_THRESHOLD ?? "70", 10);

/**
 * Emit one JSON line per resolved span under the document id.
 *
 * Deliberately a log line rather than a file next to the `_ocr` sidecar: the
 * pipeline already exposes its internals this way (see the timing lines), so
 * a whole resolution can be grepped out with the same document id as the rest
 * of the extraction — and there is no derived artifact to invalidate, clean up
 * or hard-delete alongside the document.
 */
const OCR_RESOLVER_DEBUG =
  (process.env.DOCUMENTS_OCR_DEBUG ?? "0") === "1";

/** True when any stage that needs the uncertainty scan is switched on. */
function resolverActive(): boolean {
  return SECOND_ENGINE_ENABLED() || VLM_ENABLED();
}

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
   * Mean per-word tesseract confidence (0..100) when OCR ran, null otherwise.
   * Persisted so "how badly did this document read?" survives the container,
   * and so a re-extraction can be aimed at the worst documents first.
   */
  ocrMeanConfidence: number | null;
  /**
   * Pages recognized vs. pages present. Equal on every complete extraction;
   * `ocrPagesOcred < ocrPagesTotal` marks a document the OCR time budget cut
   * short. Null on the text-layer path, which reads the whole document.
   */
  ocrPagesTotal: number | null;
  ocrPagesOcred: number | null;
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
  /**
   * Document id, used only to tag this extraction's log lines. Without it a
   * concurrent worker's lines interleave indistinguishably; with it the whole
   * extraction can be grepped out of the container log by one id.
   */
  docId?: number;
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
  const wholeStarted = Date.now();
  const tag = options.docId != null ? `(${options.docId})` : "";
  const log = (msg: string) => console.log(`[documents.text-extract] extract${tag} ${msg}`);

  // Encryption gate. A document needing an open password can't be read at
  // all — surface that distinctly so the pipeline can prompt the user.
  // Owner/permission-only encryption opens without a password; transparently
  // strip it into a temp copy so pdf-parse/poppler/tesseract see plain bytes.
  const encryptionStep = await timed(() => inspectPdfEncryption(absPath));
  const encryption = encryptionStep.value;
  if (encryption === "password") {
    throw new PdfPasswordRequiredError();
  }

  let tmpDir: string | null = null;
  let workPath = absPath;
  try {
    let decryptMs = 0;
    if (encryption === "restrictions") {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docdec-"));
      const step = await timed(() => runQpdfDecrypt(absPath, tmpDir!));
      decryptMs = step.ms;
      if (step.value) {
        workPath = step.value;
        log(`stripped owner/permission encryption in ${step.ms}ms`);
      }
    }

    const readStep = await timed(() => fs.promises.readFile(workPath));
    const buffer = readStep.value;

    let textLayer = "";
    let pageCount = 0;
    let pdfParseBrokenXref = false;
    const parseStarted = Date.now();
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

    const parseMs = since(parseStarted);
    const textLayerLooksGood =
      textLayer.length >= MIN_TEXT_LAYER_CHARS && !hasPoorSpacing(textLayer);
    log(
      `read ${(buffer.length / 1024).toFixed(0)}KB in ${readStep.ms}ms, ` +
        `encryption check ${encryptionStep.ms}ms` +
        (decryptMs > 0 ? `, decrypt ${decryptMs}ms` : "") +
        `, text layer ${parseMs}ms → ${pageCount} pages, ${textLayer.length} chars, ` +
        `${textLayerLooksGood ? "usable" : "unusable"}`,
    );

    // A born-digital PDF's own text layer is cleaner than anything OCR can
    // recover from a rasterization of it, so it wins outright — and the
    // decision rests on the text layer alone. Returning here rather than after
    // the OCR call is the whole point: `ocrPdf` renders every page with
    // pdftoppm and runs tesseract over each one, which is by far the most
    // expensive step in the pipeline. It used to run for these documents too,
    // and its result was then discarded unread on the very next line. Nothing
    // consumed it — `source` is not persisted, and the `ocr_confidence` column
    // belongs to the receipt extractor, not to this path.
    if (!options.forceOcr && textLayerLooksGood) {
      log(`done in ${since(wholeStarted)}ms — source=text_layer, OCR skipped`);
      return {
        text: textLayer,
        source: "text_layer",
        pageCount,
        searchablePdf: null,
        ocrMeanConfidence: null,
        ocrPagesTotal: null,
        ocrPagesOcred: null,
      };
    }

    log(
      options.forceOcr
        ? "force_ocr=true — skipping text layer, running OCR"
        : textLayer.length >= MIN_TEXT_LAYER_CHARS
          ? "text layer looks broken (low space ratio) — running OCR"
          : "no usable text layer — running OCR",
    );

    // Every path that reaches here either forced OCR or has no usable text
    // layer, so the sandwich PDF is always wanted: without it a scanned page
    // would have no selectable text in the viewer at all.
    const ocr = await ocrPdf(workPath, {
      repairFirst: pdfParseBrokenXref,
      wantSearchablePdf: true,
      log,
    });
    const ocrText = ocr.text;

    const source =
      !options.forceOcr &&
      textLayer.length > 0 &&
      textLayer.length < MIN_TEXT_LAYER_CHARS &&
      ocrText.length > 0
        ? "mixed"
        : "ocr";
    log(`done in ${since(wholeStarted)}ms — source=${source}, ${ocrText.length} chars`);

    if (source === "mixed") {
      return {
        text: `${textLayer}\n\n${ocrText}`.trim(),
        source,
        pageCount,
        searchablePdf: ocr.searchablePdf,
        ocrMeanConfidence: ocr.meanConfidence,
        ocrPagesTotal: ocr.pagesTotal,
        ocrPagesOcred: ocr.pagesOcred,
      };
    }
    return {
      text: ocrText,
      source,
      pageCount,
      searchablePdf: ocr.searchablePdf,
      ocrMeanConfidence: ocr.meanConfidence,
      ocrPagesTotal: ocr.pagesTotal,
      ocrPagesOcred: ocr.pagesOcred,
    };
  } finally {
    if (tmpDir) {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface OcrResult {
  text: string;
  /**
   * Mean per-word tesseract confidence (0..100) over every page, or null when
   * nothing was recognized. Persisted as `documents.ocr_mean_confidence`.
   */
  meanConfidence: number | null;
  /** Pages the rasterizer produced. */
  pagesTotal: number;
  /**
   * Pages recognition actually reached. Below `pagesTotal` means the time
   * budget truncated the document — the one failure this pipeline has that
   * leaves a plausible-looking result behind.
   */
  pagesOcred: number;
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
  options: {
    repairFirst?: boolean;
    wantSearchablePdf?: boolean;
    /** Tagged logger from the caller, so OCR lines carry the document id. */
    log?: (msg: string) => void;
  } = {},
): Promise<OcrResult> {
  const log = options.log ?? ((msg: string) => console.log(`[documents.text-extract] ${msg}`));
  const ocrStarted = Date.now();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-docscan-"));
  try {
    let pdfPath = absPath;
    let repairMs = 0;
    if (options.repairFirst) {
      const step = await timed(() => repairPdfWithQpdf(pdfPath, tmpDir));
      repairMs = step.ms;
      if (step.value) pdfPath = step.value;
    }

    const rasterStarted = Date.now();
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

    const rasterMs = since(rasterStarted);

    const entries = (await fs.promises.readdir(tmpDir))
      .filter((n) => n.toLowerCase().endsWith(".png"))
      .sort();
    if (entries.length === 0) {
      log(`ocr aborted after ${since(ocrStarted)}ms — rasterizing produced no pages`);
      return { text: "", searchablePdf: null, meanConfidence: null, pagesTotal: 0, pagesOcred: 0 };
    }
    log(
      `rasterize ${rasterMs}ms → ${entries.length} page(s) @${OCR_DPI}dpi` +
        (repairMs > 0 ? ` (after ${repairMs}ms PDF repair)` : ""),
    );

    // Totals across pages, so the summary can name the dominant stage rather
    // than only the total — which is the question "why is OCR slow" actually
    // asks. Recognition normally dwarfs the rest, but a pathological scan can
    // spend more in rotation detection than in tesseract.
    let rotateTotal = 0;
    let rotateReused = 0;
    let prepTotal = 0;
    let tessTotal = 0;
    let layoutTotal = 0;
    let paddleTotal = 0;
    let vlmTotal = 0;
    // Word-weighted so a page with three words does not count as much as a
    // dense one — the same weighting meanWordConfidence uses within a page.
    let confidenceSum = 0;
    let confidenceWords = 0;
    const resolverCounts = newResolverTally();
    const fieldCounts = { assigned: 0, refused: 0, ms: 0 };

    // One budget for the whole document, not per page: a scan whose first page
    // is a mess must not spend the entire allowance before page two is seen.
    const vlmBudget = newVlmBudget();
    // The whole-page assignment call has its own allowance: a page image costs
    // a multiple of a crop, so it must not be able to eat the crop budget.
    const fieldBudget = { pages: 0 };
    const resolveEnabled = resolverActive() && OCR_LAYOUT_REBUILD_ENABLED;
    if (OCR_RESOLVER_DEBUG && !resolveEnabled) {
      // The field map is emitted from inside the layout step, so say plainly
      // that it is running on its own rather than as part of a resolver pass —
      // otherwise the absent `resolver:` summary reads like a failure.
      log("resolver stages off — emitting the field map only");
    }

    // Rotation is a property of the scan, not of each individual page, so the
    // sampler measures it once per page shape and lets the rest of the
    // document inherit an upright verdict. Scoped to this call: a cache that
    // outlived the document would be claiming knowledge it does not have.
    const rotationSampler = new PageRotationSampler();

    const parts: string[] = [];
    const pagePdfs: string[] = [];
    // The document-number marker (see below) lives on page 1 in practice —
    // remember its final (post-preprocessing) image for the fallback pass.
    let firstPagePath: string | null = null;
    const started = Date.now();
    let pagesOcred = 0;
    for (let i = 0; i < entries.length; i++) {
      if (Date.now() - started > OCR_TIMEOUT_MS) {
        // Tagged with the document id like every other line of the extraction:
        // without it the log says a document was truncated but not which one,
        // and the result — partial text, status "ready" — looks completely
        // ordinary from the outside.
        log(
          `OCR time budget of ${OCR_TIMEOUT_MS}ms exhausted after ${i}/${entries.length} ` +
            `page(s) — TRUNCATING. Raise DOCUMENTS_OCR_TIMEOUT_MS to extract this document in full.`,
        );
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
      const rotateStep = await timed(() => rotationSampler.resolve(rawPagePath));
      const rotate = rotateStep.value.rotate;
      rotateTotal += rotateStep.ms;
      if (!rotateStep.value.detected) rotateReused++;
      const prepPath = path.join(tmpDir, `prep-${String(i).padStart(4, "0")}.png`);
      const prepStep = await timed(() =>
        preprocessOcrImage(rawPagePath, prepPath, { rotate }),
      );
      prepTotal += prepStep.ms;
      if (prepStep.value) {
        pagePath = prepPath;
      }
      if (i === 0) firstPagePath = pagePath;
      // tesseract appends the extension per output config (`txt`, `tsv`, `pdf`).
      // All requested formats come out of one recognition pass, so asking for
      // the TSV alongside the text costs a file, not a second OCR run.
      const configs = ["txt"];
      if (OCR_LAYOUT_REBUILD_ENABLED) configs.push("tsv");
      if (options.wantSearchablePdf) configs.push("pdf");
      try {
        const tessStep = await timed(() => runTesseract(pagePath, outBase, configs));
        tessTotal += tessStep.ms;
        const txt = await fs.promises
          .readFile(`${outBase}.txt`, "utf8")
          .catch(() => "");
        let pagePaddleMs = 0;
        let pageVlmMs = 0;
        const layoutStep = await timed(async () =>
          OCR_LAYOUT_REBUILD_ENABLED
            ? await layoutTextForPage(
                `${outBase}.tsv`,
                txt,
                resolveEnabled
                  ? {
                      pageImagePath: pagePath,
                      vlmBudget,
                      fieldBudget,
                      log,
                      onAssigned: (accepted, rejected, ms) => {
                        fieldCounts.assigned += accepted;
                        fieldCounts.refused += rejected;
                        fieldCounts.ms += ms;
                        vlmTotal += ms;
                        pageVlmMs += ms;
                      },
                      onResolved: (spans, paddleMs, vlmMs) => {
                        pagePaddleMs = paddleMs;
                        pageVlmMs = vlmMs;
                        paddleTotal += paddleMs;
                        vlmTotal += vlmMs;
                        tallyDecisions(spans, resolverCounts);
                        if (OCR_RESOLVER_DEBUG) {
                          for (const span of spans) log(`resolver-span ${JSON.stringify(span)}`);
                        }
                      },
                    }
                  : undefined,
                OCR_RESOLVER_DEBUG ? log : undefined,
              )
            : { text: txt.trim(), confidenceSum: 0, wordCount: 0 },
        );
        // The resolver's service calls happen inside the layout step, so its
        // milliseconds would otherwise be silently attributed to layout
        // reconstruction — which measures at ~3ms and would look absurd.
        layoutTotal += layoutStep.ms - pagePaddleMs - pageVlmMs;
        pagesOcred = i + 1;
        const pageText = layoutStep.value.text;
        confidenceSum += layoutStep.value.confidenceSum;
        confidenceWords += layoutStep.value.wordCount;
        if (pageText.length > 0) parts.push(pageText);
        if (options.wantSearchablePdf) {
          const pdf = `${outBase}.pdf`;
          if (await fileReadable(pdf)) pagePdfs.push(pdf);
        }
        if (OCR_TIMING_PER_PAGE) {
          log(
            `page ${i + 1}/${entries.length}: ` +
              `rotate ${rotateStep.ms}ms${rotateStep.value.detected ? "" : " (reused)"}, ` +
              `clean ${prepStep.ms}ms, tesseract ${tessStep.ms}ms, ` +
              `layout ${layoutStep.ms - pagePaddleMs - pageVlmMs}ms` +
              (pagePaddleMs > 0 ? `, paddle ${pagePaddleMs}ms` : "") +
              (pageVlmMs > 0 ? `, vlm ${pageVlmMs}ms` : "") +
              ` → ${pageText.length} chars`,
          );
        }
      } catch (err) {
        console.warn(
          `[documents.text-extract] tesseract failed on ${entries[i]}: ${(err as Error).message}`,
        );
      }
    }

    let searchablePdf: Buffer | null = null;
    let mergeMs = 0;
    if (options.wantSearchablePdf && pagePdfs.length > 0) {
      const step = await timed(() =>
        mergePdfs(pagePdfs, tmpDir).catch((err) => {
          console.warn(
            `[documents.text-extract] merging OCR page PDFs failed: ${(err as Error).message}`,
          );
          return null;
        }),
      );
      searchablePdf = step.value;
      mergeMs = step.ms;
    }

    let text = parts.join("\n\n").trim();
    let markerMs = 0;
    if (
      shouldRunNumberMarkerFallback(text, firstPagePath != null) &&
      Date.now() - started <= OCR_TIMEOUT_MS
    ) {
      const step = await timed(() => recoverDocumentNumberMarker(firstPagePath!));
      markerMs = step.ms;
      if (step.value) {
        log(`recovered document-number marker via sparse-text fallback in ${step.ms}ms`);
        text = `${step.value}\n\n${text}`.trim();
      }
    }

    // The summary line. Names every stage's share so "OCR was slow" can be
    // answered without re-reading the per-page lines, and so the answer
    // survives DOCUMENTS_OCR_TIMING_PAGES=0.
    const totalMs = since(ocrStarted);
    const pages = entries.length;
    if (pagesOcred < pages) {
      log(`INCOMPLETE — ${pagesOcred}/${pages} page(s) recognized before the time budget ran out`);
    }
    log(
      `ocr done in ${totalMs}ms — ${pages} page(s), ${Math.round(totalMs / pages)}ms/page: ` +
        `rasterize ${rasterMs}ms, ` +
        `rotate ${rotateTotal}ms${rotateReused > 0 ? ` (${rotateReused} reused)` : ""}, ` +
        `clean ${prepTotal}ms, ` +
        `tesseract ${tessTotal}ms, layout ${layoutTotal}ms` +
        (paddleTotal > 0 ? `, paddle ${paddleTotal}ms` : "") +
        (vlmTotal > 0 ? `, vlm ${vlmTotal}ms` : "") +
        (mergeMs > 0 ? `, sandwich pdf ${mergeMs}ms` : "") +
        (markerMs > 0 ? `, number fallback ${markerMs}ms` : ""),
    );

    if (fieldCounts.assigned + fieldCounts.refused > 0) {
      log(
        `field assignment: ${fieldCounts.assigned} accepted, ` +
          `${fieldCounts.refused} refused (not printed on the page), ` +
          `${fieldCounts.ms}ms`,
      );
    }

    if (resolverCounts.spans > 0) {
      // Read this line first when asking whether the resolver is earning its
      // keep. `vlm rejected` climbing is a model or prompt regression. Inside
      // `ocr kept`, the two figures mean opposite things: `engine
      // disagreement` is work the vision stage could do, while `no second
      // reading` means PaddleOCR contributed nothing to that span and it is
      // the alignment, not the model, that needs attention.
      log(formatResolverTally(resolverCounts));
    }

    return {
      text,
      searchablePdf,
      meanConfidence: confidenceWords > 0 ? confidenceSum / confidenceWords : null,
      pagesTotal: entries.length,
      pagesOcred,
    };
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
 * Rebuild one page's text from the word boxes in `tsvPath`, falling back to
 * Tesseract's own `txt` rendering when the TSV is missing, unparseable or
 * visibly incomplete. Best-effort: never throws, so a layout problem can only
 * cost the reconstruction, never the page.
 */
async function layoutTextForPage(
  tsvPath: string,
  plainText: string,
  resolve?: {
    pageImagePath: string;
    vlmBudget: { calls: number; deadline: number };
    /** Whole-page assignment calls already spent on this document. */
    fieldBudget: { pages: number };
    log: (msg: string) => void;
    onResolved: (spans: ResolvedSpan[], paddleMs: number, vlmMs: number) => void;
    onAssigned: (accepted: number, rejected: number, ms: number) => void;
  },
  debugLog?: (msg: string) => void,
): Promise<{ text: string; confidenceSum: number; wordCount: number }> {
  let confidenceSum = 0;
  let wordCount = 0;
  try {
    const tsv = await fs.promises.readFile(tsvPath, "utf8");
    const words = parseTesseractTsv(tsv);
    for (const word of words) {
      if (word.confidence === undefined) continue;
      confidenceSum += word.confidence;
      wordCount++;
    }
    let rows = visualRowsFromWords(words);

    // The label → value map the page's own geometry supports. Pure and cheap,
    // so it is built whenever anyone might look at it.
    const fieldPairs = debugLog || resolve ? buildFieldMap(rows) : [];
    if (debugLog) {
      for (const pair of fieldPairs) {
        debugLog(`resolver-field ${JSON.stringify(pair)}`);
      }
    }

    // The second opinion runs on the rows, before they are rendered: a span
    // must never straddle a column boundary, and `splitColumnBands` is what
    // establishes where those are.
    if (resolve) {
      const spans = findUncertainSpans(rows, { confidenceThreshold: OCR_CONF_THRESHOLD });
      if (spans.length > 0) {
        const result = await resolvePage({
          pageImagePath: resolve.pageImagePath,
          rows,
          spans,
          vlmBudget: resolve.vlmBudget,
          log: resolve.log,
        });
        rows = result.rows;
        resolve.onResolved(result.resolved, result.paddleMs, result.vlmMs);

        // Only now, with the spans decided, is it clear whether anything is
        // still in doubt — and a better pairing is worth a whole page only if
        // something is. A span that ended on the OCR reading is exactly a
        // question neither engine nor crop could answer.
        const unpaired = findUnpairedLabels(rows, fieldPairs);
        const stillInDoubt = result.resolved.some(
          (span) => span.decision === "ocr_kept" || span.decision === "vlm_rejected",
        );
        const decision = shouldAskForFieldAssignment({
          pairs: fieldPairs,
          unpaired,
          hasUnresolvedSpan: stillInDoubt,
          pagesUsed: resolve.fieldBudget.pages,
        });
        if (decision.ask) {
          resolve.fieldBudget.pages++;
          const started = Date.now();
          const assignment = await resolveFieldAssignment({
            pageImagePath: resolve.pageImagePath,
            rows,
            unpaired,
            log: resolve.log,
          });
          resolve.onAssigned(
            assignment.accepted.length,
            assignment.rejected.length,
            Date.now() - started,
          );
          if (debugLog) {
            for (const field of assignment.accepted) {
              debugLog(`resolver-field-assigned ${JSON.stringify(field)}`);
            }
          }
        } else if (debugLog && unpaired.length > 0) {
          debugLog(
            `field assignment skipped — ${unpaired.length} unpaired label(s): ${decision.reason}`,
          );
        }
      }
    }

    const layout = layoutTextFromRows(rows);
    if (shouldUseLayoutText(layout, plainText)) return { text: layout, confidenceSum, wordCount };
    if (layout.trim().length > 0) {
      console.warn(
        `[documents.text-extract] layout reconstruction looked incomplete for ${path.basename(tsvPath)} — using tesseract's plain text`,
      );
    }
  } catch (err) {
    console.warn(
      `[documents.text-extract] reading ${path.basename(tsvPath)} failed: ${(err as Error).message}`,
    );
  }
  return { text: plainText.trim(), confidenceSum, wordCount };
}

/**
 * Run tesseract on a single image, writing the requested output formats
 * (`txt`, `tsv`, `pdf`, …) to `<outBase>.<ext>`.
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
      { stdio: ["ignore", "ignore", "pipe"], env: tesseractEnv() },
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
 * Whether the sparse-text document-number fallback is worth running: only
 * when the feature is enabled, page 1's image is available, and the
 * primary OCR pass found no "#1234"-style marker at all. Pure; exported
 * for unit testing.
 */
export function shouldRunNumberMarkerFallback(
  primaryText: string,
  hasFirstPage: boolean,
): boolean {
  return (
    NUMBER_MARKER_FALLBACK_ENABLED && hasFirstPage && !DOCUMENT_NUMBER_RE.test(primaryText)
  );
}

/**
 * Re-scan `imagePath` with `--psm 11` ("sparse text": find as much text as
 * possible, in no particular order, without assuming a normal paragraph
 * layout) and return a "#1234"-style marker if one turns up. Used only as a
 * fallback when the primary `--psm 3` pass found no marker at all — see
 * `NUMBER_MARKER_FALLBACK_ENABLED` above for why this is necessary. Returns
 * null on any failure (missing binary, no match, …); never throws.
 */
async function recoverDocumentNumberMarker(imagePath: string): Promise<string | null> {
  try {
    const stdout = await runTesseractSparseText(imagePath);
    return stdout.match(DOCUMENT_NUMBER_RE)?.[0] ?? null;
  } catch (err) {
    console.warn(
      `[documents.text-extract] sparse-text fallback failed for ${imagePath}: ${(err as Error).message}`,
    );
    return null;
  }
}

function runTesseractSparseText(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lang = process.env.DOCUMENTS_OCR_LANG ?? "deu+eng";
    const proc = spawn(
      "tesseract",
      [imagePath, "stdout", "-l", lang, "--oem", "1", "--psm", "11"],
      { stdio: ["ignore", "pipe", "pipe"], env: tesseractEnv() },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tesseract --psm 11 exited ${code}: ${stderr.trim()}`));
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
