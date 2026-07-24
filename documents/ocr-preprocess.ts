/**
 * Image preprocessing for the scanned-PDF OCR path.
 *
 * The OCR pipeline in `text-extract.ts` rasterizes a scanned PDF into one
 * PNG per page (`pdftoppm`) and feeds those to `tesseract`. Real-world
 * scans are far from ideal inputs, and two problems hurt recognition badly
 * enough that Tesseract either mis-reads or reads nothing at all:
 *
 *   1. **Grayish paper / poor lighting.** Scans on gray or off-white paper
 *      carry a mid-gray cast across the whole page. Tesseract's own
 *      binarization (Otsu) copes with a uniform background, but a low
 *      foreground/background contrast still loses thin strokes and light
 *      print. We lift the contrast toward black-on-white *before* Tesseract
 *      sees the page: grayscale → percentile normalize (clip the gray cast
 *      to white) → a gentle linear contrast stretch, optionally a hard
 *      threshold for the worst cases.
 *
 *   2. **90°/180°/270° misrotation.** A page fed sideways through the
 *      scanner (very common for landscape documents auto-fed portrait)
 *      produces text Tesseract cannot recognize at all under `--psm 3`,
 *      which does not auto-rotate. We run Tesseract's Orientation & Script
 *      Detection (`--psm 0`, the `osd` model) first, and physically rotate
 *      the page image to upright with `sharp`. Because the searchable
 *      ("sandwich") PDF is then built from these upright page images, the
 *      served/downloaded PDF keeps the corrected rotation — the reader no
 *      longer has to tilt their head.
 *
 * Everything here is best-effort: any failure (missing `osd` data, a sharp
 * decode error, a low-confidence OSD result) leaves the original page image
 * untouched so OCR never regresses below the pre-existing behavior. The
 * parsing/decision helpers are pure and unit-tested; the sharp/tesseract
 * plumbing is exercised end-to-end by the pipeline.
 *
 * Prior art consulted: the Linux `sane-scan-pdf` tool (issue #892) chains
 * `scanimage`/`unpaper`/`convert` to deskew, clean margins and normalize
 * lighting. We deliberately keep the same *ideas* (upright + high-contrast
 * B/W) but implement them with the libraries already in the runtime image
 * (`sharp` + `tesseract`) rather than adding `unpaper`/ImageMagick — see
 * `docs/ocr-improvements.md` for the full comparison.
 */

import { spawn } from "child_process";
import sharp from "sharp";

/** Master switch for the whole preprocessing step (grayscale/contrast + rotate). */
const PREPROCESS_ENABLED = envFlag("DOCUMENTS_OCR_PREPROCESS", true);

/** Auto-detect and correct 90°/180°/270° page rotation via Tesseract OSD. */
const AUTOROTATE_ENABLED = envFlag("DOCUMENTS_OCR_AUTOROTATE", true);

/**
 * Minimum Tesseract "Orientation confidence" before we trust an OSD result
 * and rotate the page. OSD confidence is an unbounded positive score; blank
 * or near-blank pages report values well below 1, while a page with real
 * text sits in the low tens. 1.0 keeps us from spinning near-empty pages on
 * noise while still catching genuine sideways scans.
 */
const ROTATE_MIN_CONFIDENCE = envFloat("DOCUMENTS_OCR_ROTATE_MIN_CONFIDENCE", 1.0);

/** Convert the page to grayscale before contrast work (scans rarely need color). */
const GRAYSCALE_ENABLED = envFlag("DOCUMENTS_OCR_GRAYSCALE", true);

/** Percentile-clip normalization: pushes the gray paper cast up to white. */
const NORMALIZE_ENABLED = envFlag("DOCUMENTS_OCR_NORMALIZE", true);
const NORMALIZE_LOWER = clampPercentile(envFloat("DOCUMENTS_OCR_NORMALIZE_LOWER", 2));
const NORMALIZE_UPPER = clampPercentile(envFloat("DOCUMENTS_OCR_NORMALIZE_UPPER", 98));

/**
 * Linear contrast multiplier applied around mid-gray (128). 1.0 disables it;
 * ~1.15 deepens text without crushing anti-aliased edges. The offset is
 * derived so the midpoint stays fixed: out = a·in + 128·(1−a).
 */
const CONTRAST = envFloat("DOCUMENTS_OCR_CONTRAST", 1.15);

/**
 * Optional hard binarization threshold (0 disables). Set >0 (e.g. 160) only
 * for collections of very washed-out scans where the soft pipeline is not
 * enough — a global threshold destroys faint print, so it is off by default.
 */
const THRESHOLD = envInt("DOCUMENTS_OCR_THRESHOLD", 0);

export interface OsdResult {
  /** Clockwise degrees the page must be rotated to become upright (0/90/180/270). */
  rotate: number;
  /** Tesseract's orientation confidence score (higher = more certain). */
  confidence: number;
}

/**
 * Parse the stdout of `tesseract <img> stdout --psm 0`. Returns the
 * `Rotate:` angle (clockwise degrees to upright) and the orientation
 * confidence, or null when the output has no usable OSD block (blank page,
 * missing `osd` data, or a Tesseract error printed instead).
 *
 * Example input:
 *   Page number: 0
 *   Orientation in degrees: 90
 *   Rotate: 270
 *   Orientation confidence: 15.30
 *   Script: Latin
 *   Script confidence: 3.44
 *
 * Exported for unit testing.
 */
export function parseOsdRotation(stdout: string): OsdResult | null {
  if (!stdout) return null;
  const rotateMatch = stdout.match(/^Rotate:\s*(\d+(?:\.\d+)?)\s*$/mu);
  if (!rotateMatch) return null;
  const confMatch = stdout.match(/^Orientation confidence:\s*(-?\d+(?:\.\d+)?)\s*$/mu);

  let rotate = Math.round(parseFloat(rotateMatch[1]));
  // Normalize to one of the four right-angle steps; anything else is noise.
  rotate = ((rotate % 360) + 360) % 360;
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
    return null;
  }

  const confidence = confMatch ? parseFloat(confMatch[1]) : 0;
  return { rotate, confidence };
}

/**
 * Decide the clockwise rotation (0/90/180/270) to actually apply, given a
 * parsed OSD result. Returns 0 when there is nothing to do, the confidence
 * is below `minConfidence`, or auto-rotate is disabled. Pure; unit-tested.
 */
export function chooseOsdRotation(
  osd: OsdResult | null,
  minConfidence: number = ROTATE_MIN_CONFIDENCE,
): number {
  if (!AUTOROTATE_ENABLED) return 0;
  if (!osd || osd.rotate === 0) return 0;
  if (osd.confidence < minConfidence) return 0;
  return osd.rotate;
}

/**
 * Run Tesseract OSD on an image and return the clockwise rotation (in
 * degrees) needed to make it upright. Best-effort: returns 0 when OSD is
 * disabled, the `osd` model is missing, confidence is too low, or anything
 * else goes wrong. Never throws.
 */
export async function detectOcrRotation(imagePath: string): Promise<number> {
  if (!PREPROCESS_ENABLED || !AUTOROTATE_ENABLED) return 0;
  try {
    const stdout = await runTesseractOsd(imagePath);
    return chooseOsdRotation(parseOsdRotation(stdout));
  } catch (err) {
    console.warn(
      `[documents.ocr-preprocess] OSD detection failed for ${imagePath}: ${(err as Error).message}`,
    );
    return 0;
  }
}

function runTesseractOsd(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--psm 0` = orientation & script detection only (no recognition).
    const proc = spawn("tesseract", [imagePath, "stdout", "--psm", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      // Tesseract exits non-zero when OSD finds too few characters to judge
      // orientation ("Too few characters..."). That's an expected outcome
      // for near-blank pages, not a hard error — resolve with whatever it
      // printed so the parser reports "no rotation" rather than throwing.
      if (code === 0 || stdout.includes("Rotate:")) resolve(stdout);
      else reject(new Error(`tesseract osd exited ${code}: ${stderr.trim()}`));
    });
  });
}

export interface PreprocessOptions {
  /** Clockwise degrees to rotate the page to upright (0/90/180/270). */
  rotate?: number;
}

/**
 * Write a cleaned, upright copy of the page image at `srcPath` to `destPath`
 * for OCR. Applies (in order) right-angle rotation, grayscale, percentile
 * normalization, a gentle linear contrast stretch, and — if configured — a
 * hard threshold. Returns true when a processed image was written.
 *
 * On any failure, or when preprocessing is disabled, returns false and
 * writes nothing, so the caller falls back to the untouched page image and
 * OCR never regresses.
 */
export async function preprocessOcrImage(
  srcPath: string,
  destPath: string,
  options: PreprocessOptions = {},
): Promise<boolean> {
  if (!PREPROCESS_ENABLED) return false;
  const rotate = normalizeRightAngle(options.rotate ?? 0);

  // Nothing to gain if every enhancement is turned off and there's no
  // rotation to apply — skip the extra encode pass entirely.
  if (rotate === 0 && !GRAYSCALE_ENABLED && !NORMALIZE_ENABLED && CONTRAST === 1 && THRESHOLD <= 0) {
    return false;
  }

  try {
    let pipeline = sharp(srcPath, { failOn: "none" });
    if (rotate !== 0) pipeline = pipeline.rotate(rotate);
    if (GRAYSCALE_ENABLED) pipeline = pipeline.grayscale();
    if (NORMALIZE_ENABLED) {
      pipeline = pipeline.normalise({ lower: NORMALIZE_LOWER, upper: NORMALIZE_UPPER });
    }
    if (CONTRAST !== 1) {
      pipeline = pipeline.linear(CONTRAST, 128 * (1 - CONTRAST));
    }
    if (THRESHOLD > 0) {
      pipeline = pipeline.threshold(THRESHOLD);
    }
    // A lossless PNG keeps the sharp edges Tesseract's binarizer prefers.
    await pipeline.png({ compressionLevel: 6 }).toFile(destPath);
    return true;
  } catch (err) {
    console.warn(
      `[documents.ocr-preprocess] preprocessing ${srcPath} failed: ${(err as Error).message}`,
    );
    return false;
  }
}

/** Snap an arbitrary angle to the nearest valid right-angle step. */
export function normalizeRightAngle(angle: number): number {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return a;
}

function clampPercentile(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function envFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false";
}

function envInt(name: string, dflt: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : dflt;
}

function envFloat(name: string, dflt: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : dflt;
}
