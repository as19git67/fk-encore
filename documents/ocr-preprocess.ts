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

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import sharp from "sharp";
import { meanWordConfidence } from "./ocr-layout";
import { tesseractEnv } from "./tesseract-env";

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

/**
 * Second chance for a rotation OSD suggested but wasn't confident about.
 *
 * The confidence threshold above conflates two different situations, because
 * OSD's score scales with how much text it had to judge from: a blank page
 * scoring 0.4 on noise, and a *sparse but genuinely sideways* page scoring
 * 0.75, look the same to a threshold. A one-row bank-statement export on an
 * A4 sheet is the observed case — OSD named the right angle (`Rotate: 90`) at
 * confidence 0.75, the threshold discarded it, and the page OCR'd into
 * gibberish ("KL €202 Bensg 22'852-").
 *
 * So instead of discarding a low-confidence suggestion, we test it: OCR the
 * page both as-is and rotated, and compare mean word confidence. Recognizing
 * real text upright scores far above reading the same text sideways (34.8 vs
 * 89.3 on that document), while a bad suggestion shows no such gain and is
 * rejected. Costs two extra Tesseract passes (~1.5 s for an A4 page at 200
 * dpi), only for pages where OSD was both unsure *and* concrete — a page it
 * says nothing about, such as a truly blank one, never reaches this.
 */
const ROTATE_VERIFY_ENABLED = envFlag("DOCUMENTS_OCR_ROTATE_VERIFY", true);

/**
 * How many points of mean word confidence the rotated orientation must beat
 * the original by. Well clear of run-to-run noise, far below the gap a real
 * misrotation produces.
 */
const ROTATE_VERIFY_MIN_MARGIN = envFloat("DOCUMENTS_OCR_ROTATE_VERIFY_MARGIN", 10);

/**
 * Reuse a confident "this page is upright" verdict across the remaining pages
 * of the same document instead of re-deriving it page by page.
 *
 * Detection is not cheap: `--psm 0` is a full Tesseract start-up plus a pass
 * over the page, measured at ~1.6 s against ~1.8 s for the recognition pass
 * that actually produces the text — on a page whose OSD answer was a
 * confident `Rotate: 0`. Across a ten-page document that was 10.3 s of
 * rotation detection against 7.8 s of recognition: the pipeline spent more
 * time confirming that pages were upright than reading them.
 *
 * Only `0°` is ever reused, and the asymmetry is the whole point. Wrongly
 * extending "upright" leaves a page unrotated — the behaviour from before
 * auto-rotate existed, costing the text on that one page. Wrongly extending
 * `90°` would rotate a page that was already fine and destroy text that
 * currently reads perfectly. The first risk is worth 8 s a document; the
 * second is not, so a document that genuinely needs rotating keeps paying
 * full detection on every page.
 *
 * The reuse is additionally keyed by page shape (see `readPngAspect`), so a
 * landscape page inside a portrait document is measured on its own rather
 * than inheriting the portrait verdict.
 *
 * Set `DOCUMENTS_OCR_ROTATE_REUSE=0` to detect every page as before.
 */
const ROTATE_REUSE_ENABLED = envFlag("DOCUMENTS_OCR_ROTATE_REUSE", true);

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

/**
 * A rotation verdict plus whether it is solid enough to extend to sibling
 * pages of the same document.
 *
 * The distinction matters because `rotate: 0` is heavily overloaded. It is
 * returned when OSD confidently says the page is upright, but equally when
 * OSD could not be parsed, the `osd` model is missing, tesseract errored,
 * confidence fell below the threshold, or a probed rotation was rejected.
 * Only the first of those is knowledge; the rest are shrugs. A caller that
 * wants to skip work on later pages needs to tell them apart.
 */
export interface RotationDetection {
  /** Clockwise degrees to rotate the page upright (0/90/180/270). */
  rotate: number;
  /**
   * True when this verdict came from a signal we trust — a confident OSD
   * reading, or a rotation confirmed by recognition — rather than from a
   * failure or an inconclusive probe falling back to 0.
   */
  confident: boolean;
}

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
 *
 * 180° is always verified via recognition quality, regardless of OSD
 * confidence: OSD judges orientation from glyph shape (ascenders vs.
 * descenders), but that signal is near-zero for form-heavy / numeric pages,
 * so it cannot reliably tell 0° from 180°.  90° and 270° rely on text-line
 * direction, which OSD reads correctly even on sparse pages.
 *
 * When OSD reports 0° below the confidence threshold, we additionally probe
 * 180° — the answer "upright" at low confidence is no more trustworthy than
 * "flipped" at low confidence for the same class of documents.
 */
export async function detectOcrRotation(imagePath: string): Promise<number> {
  return (await detectOcrRotationDetailed(imagePath)).rotate;
}

/**
 * As `detectOcrRotation`, but also reports whether the verdict is trustworthy
 * enough to reuse on other pages — see `RotationDetection`.
 */
export async function detectOcrRotationDetailed(
  imagePath: string,
): Promise<RotationDetection> {
  if (!PREPROCESS_ENABLED || !AUTOROTATE_ENABLED) {
    // Disabled, not measured: nothing here is knowledge about the page.
    return { rotate: 0, confident: false };
  }
  let osd: OsdResult | null = null;
  try {
    osd = parseOsdRotation(await runTesseractOsd(imagePath));
    const confident = chooseOsdRotation(osd);
    // 90° / 270°: OSD is reliable — trust a confident result directly.
    if (confident === 90 || confident === 270) {
      return { rotate: confident, confident: true };
    }
    // 180°: OSD cannot distinguish it from 0° — fall through to verification.
  } catch (err) {
    console.warn(
      `[documents.ocr-preprocess] OSD detection failed for ${imagePath}: ${(err as Error).message}`,
    );
    return { rotate: 0, confident: false };
  }

  // A confident "upright" is a real reading, and the only one of these
  // branches that lets a caller skip work on sibling pages.
  if (osd && osd.rotate === 0 && osd.confidence >= ROTATE_MIN_CONFIDENCE) {
    return { rotate: 0, confident: true };
  }

  if (!ROTATE_VERIFY_ENABLED || !osd) return { rotate: 0, confident: false };

  // Determine which angle to verify. The confident-0° case already returned
  // above, so what is left is:
  //  • OSD said 180° (any confidence): test 180°
  //  • OSD said 90°/270° low confidence: test that angle
  //  • OSD said 0° low confidence: probe 180° (the ambiguous twin)
  const angleToTest = osd.rotate === 0 ? 180 : osd.rotate;

  try {
    const verified = await verifyRotationByRecognition(imagePath, angleToTest);
    if (verified) {
      console.log(
        `[documents.ocr-preprocess] OSD (${osd.rotate}° @ ${osd.confidence}) → ${angleToTest}° confirmed by recognition — rotating`,
      );
      return { rotate: angleToTest, confident: true };
    }
  } catch (err) {
    console.warn(
      `[documents.ocr-preprocess] rotation verification failed for ${imagePath}: ${(err as Error).message}`,
    );
  }
  // The probe came back negative, or blew up. The page is probably upright,
  // but "probably" is exactly what must not spread to other pages.
  return { rotate: 0, confident: false };
}

/**
 * Decide whether a rotation is worth applying from the two orientations'
 * mean word confidences. Requires a clear win: an unreadable original (no
 * words at all) counts as beatable, but a rotation that recognizes nothing is
 * never applied. Pure; unit-tested.
 */
export function shouldApplyVerifiedRotation(
  originalConfidence: number | null,
  rotatedConfidence: number | null,
  margin: number = ROTATE_VERIFY_MIN_MARGIN,
): boolean {
  if (rotatedConfidence == null) return false;
  if (originalConfidence == null) return true;
  return rotatedConfidence - originalConfidence >= margin;
}

/**
 * OCR `imagePath` as-is and rotated by `rotate` degrees, and report whether
 * the rotated orientation reads clearly better. Runs in a temp directory that
 * is always cleaned up.
 */
async function verifyRotationByRecognition(
  imagePath: string,
  rotate: number,
): Promise<boolean> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-osdverify-"));
  try {
    const rotatedPath = path.join(tmpDir, "rotated.png");
    await sharp(imagePath, { failOn: "none" }).rotate(normalizeRightAngle(rotate)).png().toFile(rotatedPath);

    const [original, rotated] = await Promise.all([
      recognitionConfidence(imagePath, path.join(tmpDir, "as-is")),
      recognitionConfidence(rotatedPath, path.join(tmpDir, "rot")),
    ]);
    console.log(
      `[documents.ocr-preprocess] rotation probe: as-is=${original?.toFixed(1) ?? "n/a"} rotated(${rotate}°)=${rotated?.toFixed(1) ?? "n/a"}`,
    );
    return shouldApplyVerifiedRotation(original, rotated);
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Mean word confidence of a plain `--psm 3` pass, or null when it read nothing. */
async function recognitionConfidence(
  imagePath: string,
  outBase: string,
): Promise<number | null> {
  const lang = process.env.DOCUMENTS_OCR_LANG ?? "deu+eng";
  await new Promise<void>((resolve, reject) => {
    // Same recognition settings as the real pass in text-extract.ts, so the
    // probe measures what that pass would actually get.
    const proc = spawn(
      "tesseract",
      [imagePath, outBase, "-l", lang, "--oem", "1", "--psm", "3", "tsv"],
      { stdio: ["ignore", "ignore", "pipe"], env: tesseractEnv() },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tesseract probe exited ${code}: ${stderr.trim()}`));
    });
  });
  const tsv = await fs.promises.readFile(`${outBase}.tsv`, "utf8");
  return meanWordConfidence(tsv);
}

function runTesseractOsd(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--psm 0` = orientation & script detection only (no recognition).
    const proc = spawn("tesseract", [imagePath, "stdout", "--psm", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: tesseractEnv(),
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

/**
 * Whether a verdict may stand in for detection on the document's other pages.
 * Pure; see `ROTATE_REUSE_ENABLED` for why only upright qualifies.
 */
export function isReusableRotation(
  detection: RotationDetection,
  enabled: boolean = ROTATE_REUSE_ENABLED,
): boolean {
  return enabled && detection.confident && detection.rotate === 0;
}

/**
 * Read a PNG's pixel dimensions from its IHDR chunk and report the page
 * shape. A PNG always opens with the 8-byte signature, then a 25-byte IHDR
 * whose width and height sit at offsets 16 and 20 as big-endian uint32 — so
 * this is a 24-byte read, not a decode, and costs nothing next to the
 * Tesseract call it decides to skip.
 *
 * Returns null when the file is unreadable or not a PNG, which makes the
 * caller fall back to detecting the page rather than guessing its shape.
 * Exported for unit testing.
 */
export async function readPngAspect(
  imagePath: string,
): Promise<"portrait" | "landscape" | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(imagePath, "r");
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (header.readUInt32BE(0) !== 0x89504e47) return null; // \x89PNG
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width === 0 || height === 0) return null;
    // Square pages are vanishingly rare and either bucket is defensible;
    // "portrait" keeps them with the common case.
    return width > height ? "landscape" : "portrait";
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Resolves each page's rotation for one document, reusing a confident upright
 * verdict across pages of the same shape instead of re-running detection.
 *
 * One instance per document — the cache must not outlive it, since a verdict
 * is only evidence about the pages it was measured on.
 */
export class PageRotationSampler {
  private readonly uprightAspects = new Set<string>();

  /**
   * `detect` is injectable so the reuse policy can be tested without starting
   * Tesseract; production always uses the real detector.
   */
  constructor(
    private readonly detect: (
      imagePath: string,
    ) => Promise<RotationDetection> = detectOcrRotationDetailed,
  ) {}

  /**
   * The rotation to apply to `imagePath`. `detected` is false when the answer
   * came from a sibling page and no Tesseract process was started, which is
   * what makes the saving visible in the timing log.
   */
  async resolve(imagePath: string): Promise<{ rotate: number; detected: boolean }> {
    const aspect = await readPngAspect(imagePath);
    if (aspect != null && this.uprightAspects.has(aspect)) {
      return { rotate: 0, detected: false };
    }
    const detection = await this.detect(imagePath);
    if (aspect != null && isReusableRotation(detection)) {
      this.uprightAspects.add(aspect);
    }
    return { rotate: detection.rotate, detected: true };
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
