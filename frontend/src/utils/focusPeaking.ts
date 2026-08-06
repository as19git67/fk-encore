/**
 * Focus peaking for the photo review (issue #873).
 *
 * When reviewing a burst of similar photos the decisive question is usually
 * "which shot has the faces in focus?". Focus peaking answers it visually:
 * every detected face gets a frame whose colour encodes how sharp that face
 * region is — green = sharp, yellow = middling, red = out of focus.
 *
 * The sharpness metric mirrors the one the embedding service already uses for
 * `face_sharpness` (see `embedding_service/app/api/endpoints.py`): crop the
 * face region, resample it to a fixed square, convert to grayscale, take the
 * variance of the discrete Laplacian and normalise it against a full-scale
 * value. Mirroring the backend keeps the on-screen colours consistent with the
 * KI quality scores shown next to them — and computing it in the browser means
 * peaking works on every photo immediately, without a re-scan of the library.
 *
 * This module stays DOM-free so it can be unit-tested; the canvas plumbing
 * lives in `composables/useFocusPeaking.ts`.
 */

import type { FaceBBox } from '../api/photos'

export type PeakLevel = 'sharp' | 'medium' | 'unsharp'

/** Edge length the face crop is resampled to before measuring. Matches the
 *  embedding service's 128×128 face crop so scores are comparable. */
export const FACE_SAMPLE_SIZE = 128

/** Laplacian variance that counts as "fully sharp" (score 1.0). Same
 *  full-scale value the embedding service normalises against. */
export const LAPLACIAN_FULL_SCALE = 500

/** Face crops smaller than this (in source pixels) carry too little detail
 *  for a meaningful sharpness reading and are skipped. */
export const MIN_FACE_PIXELS = 10

/**
 * Minimum on-screen face size (smaller side, CSS px) below which a peaking
 * frame is skipped. This is a *display* threshold, independent of
 * `MIN_FACE_PIXELS` (which gates the source-pixel crop the measurement
 * reads): a face can be measurable yet still render at a couple of CSS
 * pixels on a wide crowd shot, where a coloured box conveys nothing and a
 * dozen of them overlapping into unreadable percentage labels are worse
 * than showing none at all.
 */
export const MIN_RENDERED_FACE_PX = 40

/** Whether a face rendered at `widthPx`×`heightPx` on screen is large enough
 *  for its peaking frame to be worth showing. */
export function isRenderedFaceLegible(widthPx: number, heightPx: number): boolean {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return false
  return Math.min(widthPx, heightPx) >= MIN_RENDERED_FACE_PX
}

/** Floor for `peakChromeScale` — keeps the border from thinning into an
 *  invisible hairline at the maximum zoom-to-face level. */
export const MIN_PEAK_CHROME_SCALE = 0.4

/**
 * Counter-scale for a peaking frame's border/label, given the CSS zoom
 * factor currently applied to its ancestor (the zoom-to-face transform).
 *
 * The frame's box (bbox percentages) is meant to grow with the zoom — it
 * has to keep tracing the face's actual edges. Its border and label are UI
 * chrome, though: without compensation the ancestor's `scale()` enlarges
 * them right along with the box, so a thin 2px outline reads as a thick
 * smudge once zoomed in. Dividing by `zoom` keeps their on-screen size
 * constant; the result is clamped so it never shrinks below
 * `MIN_PEAK_CHROME_SCALE`, i.e. the border stays visible even at the
 * highest zoom level.
 */
export function peakChromeScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.max(MIN_PEAK_CHROME_SCALE, Math.min(1, 1 / zoom))
}

/** Score at or above which a face counts as in focus (green). */
export const SHARP_MIN = 0.45

/** Score at or above which a face counts as acceptably sharp (yellow);
 *  anything below is out of focus (red). */
export const MEDIUM_MIN = 0.18

/** Map a normalised sharpness score (0..1) onto the traffic-light level. */
export function classifySharpness(score: number): PeakLevel {
  if (!Number.isFinite(score)) return 'unsharp'
  if (score >= SHARP_MIN) return 'sharp'
  if (score >= MEDIUM_MIN) return 'medium'
  return 'unsharp'
}

/** Normalise a raw Laplacian variance into the 0..1 sharpness score. */
export function normalizeSharpness(variance: number): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0
  return Math.min(1, variance / LAPLACIAN_FULL_SCALE)
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Convert a normalised face bbox (0..1) into an integer pixel rect clamped to
 * the image bounds. Returns `null` when the bbox is unusable (out of range,
 * degenerate) or the resulting crop is too small to measure.
 */
export function faceCropRect(
  bbox: FaceBBox | null | undefined,
  imageWidth: number,
  imageHeight: number,
): CropRect | null {
  if (!bbox) return null
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  const { x, y, width, height } = bbox
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null
  if (width <= 0 || height <= 0) return null
  // Detection sometimes emits slightly out-of-range boxes; anything wildly
  // outside 0..1 is a different coordinate space and must not be measured.
  if (x > 1.1 || y > 1.1 || x < -0.1 || y < -0.1) return null

  const x1 = Math.max(0, Math.round(x * imageWidth))
  const y1 = Math.max(0, Math.round(y * imageHeight))
  const x2 = Math.min(imageWidth, Math.round((x + width) * imageWidth))
  const y2 = Math.min(imageHeight, Math.round((y + height) * imageHeight))
  const w = x2 - x1
  const h = y2 - y1
  if (w < MIN_FACE_PIXELS || h < MIN_FACE_PIXELS) return null
  return { x: x1, y: y1, width: w, height: h }
}

/** Rec. 601 luma from packed RGBA canvas pixels. */
export function grayscaleFromRgba(data: ArrayLike<number>): Float64Array {
  const out = new Float64Array(Math.floor(data.length / 4))
  for (let i = 0; i < out.length; i++) {
    const o = i * 4
    out[i] =
      0.299 * (data[o] ?? 0) + 0.587 * (data[o + 1] ?? 0) + 0.114 * (data[o + 2] ?? 0)
  }
  return out
}

/**
 * Variance of the 4-neighbour discrete Laplacian over the interior pixels.
 *
 * The embedding service approximates the Laplacian with `np.roll`, which wraps
 * neighbours around the crop edges. That is harmless on a whole photo, but on
 * a small face crop the wrap turns any brightness difference between opposite
 * edges into a bogus "edge" — a smoothly lit, out-of-focus face would read as
 * sharp. We therefore skip the border row/column instead of wrapping.
 */
export function laplacianVariance(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): number {
  const n = width * height
  if (n <= 0 || gray.length < n) return 0
  if (width < 3 || height < 3) return 0

  const count = (width - 2) * (height - 2)
  const lap = new Float64Array(count)
  let sum = 0
  let i = 0
  for (let row = 1; row < height - 1; row++) {
    const here = row * width
    const up = here - width
    const down = here + width
    for (let col = 1; col < width - 1; col++) {
      const v =
        (gray[up + col] ?? 0) +
        (gray[down + col] ?? 0) +
        (gray[here + col - 1] ?? 0) +
        (gray[here + col + 1] ?? 0) -
        4 * (gray[here + col] ?? 0)
      lap[i++] = v
      sum += v
    }
  }
  const mean = sum / count
  let acc = 0
  for (let k = 0; k < count; k++) {
    const d = (lap[k] ?? 0) - mean
    acc += d * d
  }
  return acc / count
}

/** Normalised sharpness score (0..1) for a packed RGBA face crop. */
export function sharpnessFromRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
): number {
  return normalizeSharpness(laplacianVariance(grayscaleFromRgba(data), width, height))
}

/** Percentage label shown inside the peaking frame, e.g. `"72 %"`. */
export function sharpnessLabel(score: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100)
  return `${pct} %`
}

const LEVEL_TEXT: Record<PeakLevel, string> = {
  sharp: 'scharf',
  medium: 'mittelscharf',
  unsharp: 'unscharf',
}

/** Accessible description of a peaking frame, e.g. `"Gesicht scharf – 72 %"`. */
export function peakDescription(score: number): string {
  return `Gesicht ${LEVEL_TEXT[classifySharpness(score)]} – ${sharpnessLabel(score)}`
}
