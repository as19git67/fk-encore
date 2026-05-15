// Photo transformations — Phase 2: suggestion compute.
//
// computePhotoTransformSuggestions(photoId) reads the existing face and
// landmark detection results for a photo, derives a "subject hull",
// snap-fits an aspect-aware crop rectangle for each supported aspect
// ratio (rule-of-thirds aware), and writes the result to
// photo_transform_suggestions. Auto-exposure / contrast values come from
// sharp.stats() on the original file.
//
// Pure math is exported separately for unit testing.
//
// See docs/photos-ai-transforms.md.

import path from "path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import db from "../db/database";
import { dbAll, dbFirst, dbExec } from "../db/adapter";
import {
  faces,
  photoLandmarks,
  photos,
  photoTransformSuggestions,
  type PhotoTransformAspectRatio,
  type PhotoTransformCrop,
  type PhotoTransformSuggestionsPayload,
} from "../db/schema";

// Inlined to avoid a circular import with photo.service.ts (which will
// call computePhotoTransformSuggestions from inside its existing hooks).
// Mirror of getPhotoDiskPath() — keep the two in sync.
const UPLOAD_DIR = path.resolve(process.env.PHOTO_UPLOAD_DIR || "/mnt/data/photos");

function resolvePhotoDiskPath(p: { filename: string; external_path: string | null }): string {
  return p.external_path ? p.external_path : path.join(UPLOAD_DIR, p.filename);
}

export const PHOTO_TRANSFORM_MODEL_VERSION = "v1";

export interface BboxNorm {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Target aspect ratios (width / height in pixel space). Both orientations
// of each ratio are listed so the heuristic can pick whichever fits the
// subject without clamping it.
export const PHOTO_TRANSFORM_ASPECT_RATIOS: Record<PhotoTransformAspectRatio, number> = {
  "1:1": 1.0,
  "4:5": 4 / 5,
  "5:4": 5 / 4,
  "3:4": 3 / 4,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

const SUBJECT_PADDING = 0.15; // 15 % on each side
const EPS = 1e-9;

// ----------------- Pure math (unit-tested in isolation) -----------------

/** Axis-aligned bounding box of a non-empty list of bboxes, all in [0,1]². */
export function unionBbox(boxes: BboxNorm[]): BboxNorm | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pad a bbox by `pad` × its dimensions on every side, clamped to [0,1]². */
export function padBbox(b: BboxNorm, pad: number): BboxNorm {
  const px = b.width * pad;
  const py = b.height * pad;
  const x = Math.max(0, b.x - px);
  const y = Math.max(0, b.y - py);
  return {
    x,
    y,
    width: Math.min(1 - x, b.width + 2 * px),
    height: Math.min(1 - y, b.height + 2 * py),
  };
}

/**
 * Fit a crop rectangle of the given pixel-space aspect ratio inside the
 * image so that:
 *   - the crop is as LARGE as the image allows at this aspect (uses
 *     the maximum of the available area, only constrained by [0,1]²
 *     and the requested w/h ratio in pixel space),
 *   - the subject hull's centroid sits on the closest rule-of-thirds
 *     intersection of the crop that keeps the crop inside the image,
 *   - the hull is still fully contained.
 *
 * The "largest possible" framing is what the user asked for: the AI
 * shouldn't tightly chop on just the face — it should keep enough
 * of the body / surroundings so the subject reads as part of a
 * well-composed picture. Different aspect ratios produce different
 * shapes (landscape source + 9:16 ratio yields a tall portrait crop),
 * which is the "ggf. aus einem landscape Bild ein Porträt" behaviour.
 *
 * Returns null only when the hull is wider/taller than the crop can
 * be at this ratio (e.g. requesting 9:16 from a near-panoramic hull).
 */
export function fitCropToAspect(
  hull: BboxNorm,
  cropAspectInPixels: number,
  imageAspectInPixels: number,
): PhotoTransformCrop | null {
  // Crop dimensions in normalised image coords.
  //   wn / hn = cropAR / imageAR  (so the rendered pixel ratio equals cropAR).
  // We want the LARGEST (wn, hn) that fits inside [0,1]²:
  //   - If ratio >= 1 (crop is wider than the image): wn = 1, hn = 1/ratio.
  //   - Else (taller than the image): hn = 1, wn = ratio.
  const ratio = cropAspectInPixels / imageAspectInPixels;
  let w: number;
  let h: number;
  if (ratio >= 1) {
    w = 1;
    h = 1 / ratio;
  } else {
    w = ratio;
    h = 1;
  }

  // If the hull is bigger than the largest crop in either dimension,
  // there's no way to fit it — bail.
  if (hull.width > w + EPS || hull.height > h + EPS) return null;

  const cx = hull.x + hull.width / 2;
  const cy = hull.y + hull.height / 2;

  let best: PhotoTransformCrop | null = null;
  let bestScore = Infinity;
  for (const fx of [1 / 3, 2 / 3]) {
    for (const fy of [1 / 3, 2 / 3]) {
      // Place centroid at (fx*w, fy*h) within the crop → crop origin:
      let x = cx - fx * w;
      let y = cy - fy * h;
      // Clamp so the crop stays inside the image.
      x = Math.max(0, Math.min(1 - w, x));
      y = Math.max(0, Math.min(1 - h, y));
      // Reject if the hull is no longer fully contained (only possible
      // when the hull is larger than w/h in some dimension, which we
      // already filtered, OR when the centroid is so off-centre that
      // even with clamping the hull spills out — rare but possible).
      if (
        hull.x < x - EPS ||
        hull.y < y - EPS ||
        hull.x + hull.width > x + w + EPS ||
        hull.y + hull.height > y + h + EPS
      ) {
        continue;
      }
      const dx = (cx - x) / w - fx;
      const dy = (cy - y) / h - fy;
      const dist = dx * dx + dy * dy;
      if (dist < bestScore) {
        bestScore = dist;
        best = { x, y, w, h };
      }
    }
  }

  if (best == null) {
    // Hull-centred fallback. Position so the hull is centred in the
    // crop, then clamp; if the hull is wide/tall enough that the
    // crop can't move freely, shift to keep the hull inside.
    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    if (hull.x < x) x = hull.x;
    if (hull.x + hull.width > x + w) x = hull.x + hull.width - w;
    if (hull.y < y) y = hull.y;
    if (hull.y + hull.height > y + h) y = hull.y + hull.height - h;
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    best = { x, y, w, h };
  }

  return best;
}

/**
 * Combine face bboxes and landmark bboxes into a single subject hull.
 * Faces take precedence; if none, the highest-confidence landmark wins.
 * Returns null if there is nothing to crop around.
 */
export function computeSubjectHull(
  faceBboxes: BboxNorm[],
  landmarks: { bbox: BboxNorm; confidence: number }[],
): BboxNorm | null {
  if (faceBboxes.length > 0) {
    return unionBbox(faceBboxes);
  }
  if (landmarks.length > 0) {
    const best = landmarks.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return best.bbox;
  }
  return null;
}

/**
 * Build the crops portion of the suggestion payload. Each ratio is tried
 * in both orientations as listed in PHOTO_TRANSFORM_ASPECT_RATIOS; the
 * one that survives without clamping the hull wins. If no hull, a
 * centred crop of the right aspect ratio is returned for every ratio
 * that fits the image.
 */
export function computeSuggestionCrops(
  hull: BboxNorm | null,
  imageWidth: number,
  imageHeight: number,
): Partial<Record<PhotoTransformAspectRatio, PhotoTransformCrop>> {
  const imageAR = imageWidth / imageHeight;
  const crops: Partial<Record<PhotoTransformAspectRatio, PhotoTransformCrop>> = {};

  for (const [name, cropAR] of Object.entries(PHOTO_TRANSFORM_ASPECT_RATIOS) as [
    PhotoTransformAspectRatio,
    number,
  ][]) {
    if (hull) {
      const padded = padBbox(hull, SUBJECT_PADDING);
      const fit = fitCropToAspect(padded, cropAR, imageAR);
      if (fit) crops[name] = fit;
    } else {
      // Centred crop of the requested ratio. Same math as fitCropToAspect
      // but no hull constraint.
      const ratio = cropAR / imageAR;
      const hn = Math.min(1, 1 / Math.max(ratio, 1));
      const wn = Math.min(1, ratio * hn);
      if (wn <= 1 + EPS && hn <= 1 + EPS) {
        crops[name] = {
          x: (1 - wn) / 2,
          y: (1 - hn) / 2,
          w: wn,
          h: hn,
        };
      }
    }
  }
  return crops;
}

/**
 * Derive an exposure / contrast / gamma recipe from a luminance summary.
 * `meanLuma` and `meanStdev` are both in 0..1.
 *
 * Heuristic: aim for mid-tone ≈ 0.5 (sRGB-encoded) and stdev ≈ 0.22
 * (broad but not blown out). Pure addition/subtraction here — slider
 * defaults in the editor.
 */
export function computeAutoExposureFromStats(
  meanLuma: number,
  meanStdev: number,
): { exposure: number; contrast: number; gamma: number } {
  const safeMean = Math.max(0.05, Math.min(0.95, meanLuma));
  const exposure = Math.max(-1.5, Math.min(1.5, Math.log2(0.5 / safeMean)));
  const targetStdev = 0.22;
  const contrast = Math.max(
    -0.4,
    Math.min(0.4, ((targetStdev - meanStdev) / targetStdev) * 0.5),
  );
  return { exposure, contrast, gamma: 1 };
}

// ----------------- I/O wrappers -----------------

interface RawFaceRow { bbox: string }
interface RawLandmarkRow { bbox: string; confidence: number }

async function readFaceBboxes(photoId: number): Promise<BboxNorm[]> {
  const rows = await dbAll<RawFaceRow>(
    db.select({ bbox: faces.bbox }).from(faces).where(eq(faces.photo_id, photoId)),
  );
  return rows
    .map((r) => safeParseBbox(r.bbox))
    .filter((b): b is BboxNorm => b != null);
}

async function readLandmarkBboxes(
  photoId: number,
): Promise<{ bbox: BboxNorm; confidence: number }[]> {
  const rows = await dbAll<RawLandmarkRow>(
    db
      .select({ bbox: photoLandmarks.bbox, confidence: photoLandmarks.confidence })
      .from(photoLandmarks)
      .where(eq(photoLandmarks.photo_id, photoId)),
  );
  return rows
    .map((r) => {
      const b = safeParseBbox(r.bbox);
      if (!b) return null;
      return { bbox: b, confidence: r.confidence };
    })
    .filter((x): x is { bbox: BboxNorm; confidence: number } => x != null);
}

function safeParseBbox(raw: string): BboxNorm | null {
  try {
    const v = JSON.parse(raw) as Partial<BboxNorm>;
    if (
      typeof v.x !== "number" ||
      typeof v.y !== "number" ||
      typeof v.width !== "number" ||
      typeof v.height !== "number"
    ) {
      return null;
    }
    return { x: v.x, y: v.y, width: v.width, height: v.height };
  } catch {
    return null;
  }
}

async function computeAutoExposureFromFile(
  originalPath: string,
): Promise<{ exposure: number; contrast: number; gamma: number }> {
  const stats = await sharp(originalPath).stats();
  // Average the first three channels (R, G, B) as a coarse luminance proxy.
  // We deliberately avoid a luminance-weighted formula because it would
  // bias monochrome images, and the suggestion is editable anyway.
  const rgb = stats.channels.slice(0, 3);
  if (rgb.length === 0) return { exposure: 0, contrast: 0, gamma: 1 };
  const meanLuma =
    rgb.reduce((s, c) => s + c.mean, 0) / rgb.length / 255;
  const meanStdev =
    rgb.reduce((s, c) => s + c.stdev, 0) / rgb.length / 255;
  return computeAutoExposureFromStats(meanLuma, meanStdev);
}

// ----------------- Top-level orchestration -----------------

/**
 * Compute & upsert the AI suggestion payload for a photo.
 *
 * Idempotent: every call rewrites the row with the current model version
 * and `computed_at = now()`. Returns the payload that was written, or
 * null if the photo cannot be processed (missing, missing dimensions,
 * unreadable image — all logged, never thrown).
 *
 * `originalPath` is optional; if not provided, the function resolves it
 * from the photos row. Passed-in paths exist to keep call sites that
 * already opened the file (and want to avoid an extra disk hit) cheap.
 */
export async function computePhotoTransformSuggestions(
  photoId: number,
  originalPath?: string,
): Promise<PhotoTransformSuggestionsPayload | null> {
  const photo = await dbFirst<{
    id: number;
    width: number | null;
    height: number | null;
    filename: string;
    external_path: string | null;
  }>(
    db
      .select({
        id: photos.id,
        width: photos.width,
        height: photos.height,
        filename: photos.filename,
        external_path: photos.external_path,
      })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!photo) return null;
  if (!photo.width || !photo.height) {
    // Dimensions get filled by the scan pipeline. If they're not there yet,
    // the suggestion would have to assume a square image — skip and let
    // the next pass (after dimensions are populated) handle it.
    return null;
  }

  const [faceBboxes, landmarks] = await Promise.all([
    readFaceBboxes(photoId),
    readLandmarkBboxes(photoId),
  ]);
  const hull = computeSubjectHull(faceBboxes, landmarks);
  const crops = computeSuggestionCrops(hull, photo.width, photo.height);

  const resolvedPath =
    originalPath ??
    resolvePhotoDiskPath({
      filename: photo.filename,
      external_path: photo.external_path,
    });
  let exposureRecipe: { exposure: number; contrast: number; gamma: number };
  try {
    exposureRecipe = await computeAutoExposureFromFile(resolvedPath);
  } catch (err) {
    console.warn(
      `[photo-transforms] sharp.stats() failed for photo ${photoId}: ${
        (err as Error).message
      } — falling back to neutral exposure recipe`,
    );
    exposureRecipe = { exposure: 0, contrast: 0, gamma: 1 };
  }

  const payload: PhotoTransformSuggestionsPayload = {
    crops,
    exposure: round3(exposureRecipe.exposure),
    contrast: round3(exposureRecipe.contrast),
    gamma: round3(exposureRecipe.gamma),
  };

  await dbExec(
    db
      .insert(photoTransformSuggestions)
      .values({
        photo_id: photoId,
        payload,
        model_version: PHOTO_TRANSFORM_MODEL_VERSION,
      })
      .onConflictDoUpdate({
        target: photoTransformSuggestions.photo_id,
        set: {
          payload,
          model_version: PHOTO_TRANSFORM_MODEL_VERSION,
          computed_at: sql`now()`,
        },
      }),
  );

  return payload;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
