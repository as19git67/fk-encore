/**
 * Per-face sharpness measurement — Etappe 2 of
 * docs/auto-pick-face-relevance.md.
 *
 * Today the only per-face sharpness the system has is `face_sharpness` in
 * `photos.ai_quality_details`: the *minimum* over all detections of a photo,
 * computed by the embedding service. That minimum is usually the same tiny
 * background face in every frame of a burst, so it stays constant while the
 * main subject's sharpness — the thing the user actually decides on — varies.
 * The variance exists in the pixels and is thrown away by the aggregation.
 *
 * Measuring each face separately and persisting it on `faces.sharpness` is
 * what makes a prominence-weighted aggregation possible at all. The metric is
 * deliberately the same one the frontend's focus peaking already draws
 * (`frontend/src/utils/focusPeaking.ts`): crop the face region, resample to a
 * fixed square, grayscale, variance of the discrete Laplacian, normalised
 * against a full-scale value. Same numbers on screen and in the score.
 *
 * Pure arithmetic — no CLIP, no GPU. `sharp` does the decode/crop/resample,
 * everything else is plain loops so it stays unit-testable.
 */

import type { FaceBBox } from "../db/types";

/** Normalised (0..1) face box as stored in `faces.bbox` — the same shape the
 *  API surfaces, so a caller can hand a face row straight in. */
export type { FaceBBox };

/** Edge length the face crop is resampled to before measuring. Matches the
 *  embedding service's 128×128 face crop so scores are comparable. */
export const FACE_SAMPLE_SIZE = 128;

/** Laplacian variance that counts as "fully sharp" (score 1.0). Same
 *  full-scale value the embedding service normalises against. */
export const LAPLACIAN_FULL_SCALE = 500;

/** Face crops smaller than this (in source pixels) carry too little detail
 *  for a meaningful sharpness reading and are skipped — they get NULL rather
 *  than a made-up number. */
export const MIN_FACE_PIXELS = 10;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Convert a normalised face bbox (0..1) into an integer pixel rect clamped to
 * the image bounds. Returns `null` when the bbox is unusable (out of range,
 * degenerate) or the resulting crop is too small to measure.
 *
 * Mirrors `faceCropRect` in frontend/src/utils/focusPeaking.ts.
 */
export function faceCropRect(
  bbox: FaceBBox | null | undefined,
  imageWidth: number,
  imageHeight: number,
): CropRect | null {
  if (!bbox) return null;
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
  const { x, y, width, height } = bbox;
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null;
  if (width <= 0 || height <= 0) return null;
  // Detection sometimes emits slightly out-of-range boxes; anything wildly
  // outside 0..1 is a different coordinate space and must not be measured.
  if (x > 1.1 || y > 1.1 || x < -0.1 || y < -0.1) return null;

  const x1 = Math.max(0, Math.round(x * imageWidth));
  const y1 = Math.max(0, Math.round(y * imageHeight));
  const x2 = Math.min(imageWidth, Math.round((x + width) * imageWidth));
  const y2 = Math.min(imageHeight, Math.round((y + height) * imageHeight));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < MIN_FACE_PIXELS || h < MIN_FACE_PIXELS) return null;
  return { x: x1, y: y1, width: w, height: h };
}

/**
 * Variance of the 4-neighbour discrete Laplacian over the interior pixels.
 *
 * The border row/column is skipped rather than wrapped: on a small face crop,
 * wrapping (what the embedding service's `np.roll` does) turns any brightness
 * difference between opposite edges into a bogus "edge", so a smoothly lit,
 * out-of-focus face would read as sharp. Same reasoning — and same result —
 * as the frontend implementation.
 */
export function laplacianVariance(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): number {
  const n = width * height;
  if (n <= 0 || gray.length < n) return 0;
  if (width < 3 || height < 3) return 0;

  const count = (width - 2) * (height - 2);
  const lap = new Float64Array(count);
  let sum = 0;
  let i = 0;
  for (let row = 1; row < height - 1; row++) {
    const here = row * width;
    const up = here - width;
    const down = here + width;
    for (let col = 1; col < width - 1; col++) {
      const v =
        (gray[up + col] ?? 0) +
        (gray[down + col] ?? 0) +
        (gray[here + col - 1] ?? 0) +
        (gray[here + col + 1] ?? 0) -
        4 * (gray[here + col] ?? 0);
      lap[i++] = v;
      sum += v;
    }
  }
  const mean = sum / count;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const d = (lap[k] ?? 0) - mean;
    acc += d * d;
  }
  return acc / count;
}

/** Normalise a raw Laplacian variance into the 0..1 sharpness score. */
export function normalizeSharpness(variance: number): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0;
  return Math.min(1, variance / LAPLACIAN_FULL_SCALE);
}

/**
 * A decoded, EXIF-rotated grayscale plane of one photo.
 *
 * Decoding is by far the expensive part (tens of ms for a 12 MP JPEG), and a
 * photo usually carries several faces — so the plane is decoded once and every
 * face crop is taken from it. One 12 MP photo costs ~12 MB of RAM here, which
 * is why the backfill walks photos strictly sequentially.
 */
export interface GrayImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Decode `input` (a file path or an in-memory image buffer) into a rotated
 * grayscale plane.
 *
 * `.rotate()` applies the EXIF orientation tag before anything else, so the
 * pixel coordinates match the bboxes stored by the face scan — those are
 * normalised against the dimensions the InsightFace service reported, which
 * also come from a rotated read.
 */
export async function loadGrayImage(input: string | Buffer): Promise<GrayImage> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface FaceSharpnessMeasurement {
  /** Raw Laplacian variance of the resampled crop. Unbounded. */
  variance: number;
  /** `variance` normalised into 0..1 against LAPLACIAN_FULL_SCALE. */
  score: number;
}

/**
 * Sharpness of one face inside an already-decoded photo, or `null` when the
 * face is too small to judge.
 *
 * `null` is a deliberate third state, not a zero: "not measurable" must stay
 * distinguishable from "measured, and blurry", because a tiny background
 * detection scoring 0 would drag a prominence-weighted mean down exactly the
 * way `min()` does today.
 *
 * Both the raw variance and the normalised score are returned — and both get
 * persisted. LAPLACIAN_FULL_SCALE is calibrated for the frontend, which
 * measures the *rendered* (downscaled) image; the same crop read from the
 * full-resolution original carries far more high-frequency detail and can run
 * into the 1.0 ceiling, where every face looks equally sharp and the score
 * stops discriminating. Keeping the raw value means re-calibrating the scale
 * is an `UPDATE`, not another pass over every crop in the library.
 */
export async function measureFaceSharpness(
  image: GrayImage,
  bbox: FaceBBox | null | undefined,
): Promise<FaceSharpnessMeasurement | null> {
  const rect = faceCropRect(bbox, image.width, image.height);
  if (!rect) return null;
  const sharp = (await import("sharp")).default;
  const crop = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 1 },
  })
    .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
    // `fill` (not `cover`) so a non-square face box is not centre-cropped:
    // the whole detected region has to reach the measurement.
    .resize(FACE_SAMPLE_SIZE, FACE_SAMPLE_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  const variance = laplacianVariance(crop, FACE_SAMPLE_SIZE, FACE_SAMPLE_SIZE);
  return { variance, score: normalizeSharpness(variance) };
}
