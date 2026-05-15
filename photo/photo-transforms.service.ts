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
 * Fit a crop rectangle of the given pixel-space aspect ratio around the
 * (padded) subject hull. The crop:
 *   - has the smallest size that fully contains the hull,
 *   - is positioned so the hull centroid sits on the closest rule-of-thirds
 *     intersection of the crop that still keeps the crop inside the image,
 *   - is in normalised (0..1) coordinates.
 *
 * Returns null if the hull cannot fit at this aspect ratio in this image
 * (i.e. one dimension would need to exceed 1).
 */
export function fitCropToAspect(
  hull: BboxNorm,
  cropAspectInPixels: number,
  imageAspectInPixels: number,
): PhotoTransformCrop | null {
  // In normalised coords, crop pixel ratio = (wn * imageW) / (hn * imageH)
  //                                        = (wn / hn) * imageAR.
  // So wn / hn = cropAR / imageAR.
  const ratio = cropAspectInPixels / imageAspectInPixels;

  // Smallest (wn, hn) that fully contains the hull at the desired ratio:
  //   wn = ratio * hn, wn >= hull.width, hn >= hull.height.
  const hn = Math.max(hull.height, hull.width / ratio);
  const wn = ratio * hn;
  if (wn > 1 + EPS || hn > 1 + EPS) return null;
  const w = Math.min(1, wn);
  const h = Math.min(1, hn);

  const cx = hull.x + hull.width / 2;
  const cy = hull.y + hull.height / 2;

  let best: PhotoTransformCrop | null = null;
  let bestScore = Infinity;
  for (const fx of [1 / 3, 2 / 3]) {
    for (const fy of [1 / 3, 2 / 3]) {
      // Place centroid at (fx*w, fy*h) within the crop → crop origin:
      let x = cx - fx * w;
      let y = cy - fy * h;
      // Clamp so crop stays inside the image.
      x = Math.max(0, Math.min(1 - w, x));
      y = Math.max(0, Math.min(1 - h, y));
      // Reject if the hull is no longer fully contained.
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
    // Hull-centred fallback (no ROT bias). Always succeeds because the
    // hull fits the crop dims by construction.
    let x = cx - w / 2;
    let y = cy - h / 2;
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
