// Pure cropper-drag math, extracted from PhotoCropper.vue so it can
// be unit-tested without a DOM. Every function returns a new crop;
// nothing is mutated in place.
//
// Coordinate system: normalised image space, [0..1] on both axes.
// The crop's pixel rendering is the cropper component's concern.

import type { PhotoTransformCrop } from './photoTransformRecipe'

export type CropHandle =
  | 'body'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw'

const MIN_SIZE = 0.05
const EPS = 1e-6

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Compute the next crop given a drag from `start` with deltas (dx, dy)
 * in normalised image coordinates. Returns null when an aspect-ratio
 * constraint cannot be satisfied within [0,1] — the cropper component
 * keeps the previous crop in that case.
 */
export function computeNextCrop(
  handle: CropHandle,
  start: PhotoTransformCrop,
  dx: number,
  dy: number,
  aspectRatio: number | null,
): PhotoTransformCrop | null {
  if (handle === 'body') {
    const x = clamp01(Math.min(1 - start.w, Math.max(0, start.x + dx)))
    const y = clamp01(Math.min(1 - start.h, Math.max(0, start.y + dy)))
    return { ...start, x, y }
  }

  let left = start.x
  let right = start.x + start.w
  let top = start.y
  let bottom = start.y + start.h

  const movesLeft = handle === 'w' || handle === 'nw' || handle === 'sw'
  const movesRight = handle === 'e' || handle === 'ne' || handle === 'se'
  const movesTop = handle === 'n' || handle === 'nw' || handle === 'ne'
  const movesBottom = handle === 's' || handle === 'sw' || handle === 'se'

  if (movesLeft) left = clamp01(Math.min(right - MIN_SIZE, start.x + dx))
  if (movesRight)
    right = clamp01(Math.max(left + MIN_SIZE, start.x + start.w + dx))
  if (movesTop) top = clamp01(Math.min(bottom - MIN_SIZE, start.y + dy))
  if (movesBottom)
    bottom = clamp01(Math.max(top + MIN_SIZE, start.y + start.h + dy))

  let w = right - left
  let h = bottom - top

  if (aspectRatio != null && aspectRatio > 0) {
    if (handle === 'n' || handle === 's') {
      const newW = h * aspectRatio
      const cx = start.x + start.w / 2
      left = clamp01(cx - newW / 2)
      right = clamp01(cx + newW / 2)
      w = right - left
      h = w / aspectRatio
      if (handle === 'n') top = bottom - h
      else bottom = top + h
    } else if (handle === 'e' || handle === 'w') {
      const newH = w / aspectRatio
      const cy = start.y + start.h / 2
      top = clamp01(cy - newH / 2)
      bottom = clamp01(cy + newH / 2)
      h = bottom - top
      w = h * aspectRatio
      if (handle === 'w') left = right - w
      else right = left + w
    } else {
      // Corner — pick the axis that "won" the drag and slave the other.
      const dW = Math.abs(w - start.w)
      const dH = Math.abs(h - start.h)
      if (dW * aspectRatio > dH) {
        h = w / aspectRatio
        if (movesTop) top = bottom - h
        else bottom = top + h
      } else {
        w = h * aspectRatio
        if (movesLeft) left = right - w
        else right = left + w
      }
    }
    if (
      left < -EPS ||
      top < -EPS ||
      right > 1 + EPS ||
      bottom > 1 + EPS ||
      w < MIN_SIZE - EPS ||
      h < MIN_SIZE - EPS
    ) {
      return null
    }
  }

  return {
    x: clamp01(left),
    y: clamp01(top),
    w: Math.max(MIN_SIZE, right - left),
    h: Math.max(MIN_SIZE, bottom - top),
  }
}
