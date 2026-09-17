/**
 * Geometry for laying recognised text over a photo (issue #1029, stage 5).
 *
 * The OCR service hands back each line as a quadrilateral in coordinates
 * relative to the original image (0..1 on both axes). Text on a sign
 * photographed at an angle is not axis-aligned, so the layer does not draw
 * the bounding box — it draws the quad itself: origin at the first corner,
 * running along the top edge, as tall as the left edge. That way a browser
 * selection follows the letters on the sign instead of a level box beside
 * them.
 *
 * Everything here is pure and in relative units; the component turns the
 * result into percentages of the rendered image box.
 */

import type { PhotoOcrBlock } from '../api/photos'

export interface Point {
  x: number
  y: number
}

/** A rectangle in relative image coordinates (0..1). */
export interface RelRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where a line sits, as a rotated box: `x`/`y` is the top-left corner in
 * relative image coordinates, `width`/`height` the box size in the same
 * units, `angle` the rotation (radians, clockwise on screen) applied at that
 * corner.
 */
export interface LineLayout {
  x: number
  y: number
  width: number
  height: number
  angle: number
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Rotation of a line, from its top edge (first → second corner).
 *
 * The OCR detector emits corners clockwise starting top-left, so that edge
 * is the direction the text runs in. Anything without two distinct corners
 * counts as level.
 */
export function polygonAngle(polygon: readonly Point[]): number {
  const a = polygon[0]
  const b = polygon[1]
  if (!a || !b) return 0
  if (a.x === b.x && a.y === b.y) return 0
  return Math.atan2(b.y - a.y, b.x - a.x)
}

/**
 * The box a line's text is laid into.
 *
 * With a full quad the box is anchored at the first corner, as long as the
 * top edge and as tall as the left edge, rotated by the top edge's angle —
 * an exact fit for the parallelogram-shaped quads the detector produces for
 * tilted text. Without a usable quad it falls back to the axis-aligned box,
 * which is what a level line is anyway.
 */
export function lineLayout(block: Pick<PhotoOcrBlock, 'polygon' | 'left' | 'top' | 'right' | 'bottom'>): LineLayout {
  const quad = block.polygon
  const p0 = quad[0]
  const p1 = quad[1]
  const p3 = quad[3]
  if (p0 && p1 && p3) {
    const width = distance(p0, p1)
    const height = distance(p0, p3)
    if (width > 0 && height > 0) {
      return { x: p0.x, y: p0.y, width, height, angle: polygonAngle(quad) }
    }
  }
  return {
    x: block.left,
    y: block.top,
    width: Math.max(0, block.right - block.left),
    height: Math.max(0, block.bottom - block.top),
    angle: 0,
  }
}

/**
 * Horizontal stretch that makes text measured at `measuredWidth` fill a box
 * of `targetWidth` — the trick that puts the browser's selection highlight
 * over the letters in the photo rather than over a font's idea of them.
 * Clamped so a degenerate measurement cannot produce an invisible or absurd
 * line.
 */
export function fitScaleX(measuredWidth: number, targetWidth: number): number {
  if (!(measuredWidth > 0) || !(targetWidth > 0)) return 1
  return Math.min(8, Math.max(0.125, targetWidth / measuredWidth))
}

/**
 * Map a point from original-image coordinates into the coordinates of a
 * cropped view of that image. `crop` is the visible rectangle, relative to
 * the original; the result is relative to the crop (0..1 inside it, outside
 * that range for a point the crop cut off).
 */
export function mapPointIntoCrop(p: Point, crop: RelRect): Point {
  if (!(crop.w > 0) || !(crop.h > 0)) return p
  return { x: (p.x - crop.x) / crop.w, y: (p.y - crop.y) / crop.h }
}

/**
 * A block seen through a crop: every corner and the bounding box re-based to
 * the crop, so the layout code above needs no knowledge of cropping at all.
 */
export function mapBlockIntoCrop(block: PhotoOcrBlock, crop: RelRect): PhotoOcrBlock {
  const polygon = block.polygon.map(p => mapPointIntoCrop(p, crop))
  const tl = mapPointIntoCrop({ x: block.left, y: block.top }, crop)
  const br = mapPointIntoCrop({ x: block.right, y: block.bottom }, crop)
  return { ...block, polygon, left: tl.x, top: tl.y, right: br.x, bottom: br.y }
}

/** The user's saved rotation: quarter turns, clockwise, as the server renders them. */
export type QuarterTurn = 0 | 90 | 180 | 270

/**
 * What the fullscreen image actually shows once a saved recipe is applied:
 * the server extracts the crop from the upright original and then turns the
 * result clockwise by the rotation. Both optional — an absent crop is the
 * whole image, an absent rotation is none.
 */
export interface ViewTransform {
  crop?: RelRect | null
  rotation?: number | null
}

/** Normalise any stored rotation value to one of the four the server accepts. */
export function quarterTurn(rotation: number | null | undefined): QuarterTurn {
  if (!rotation || !Number.isFinite(rotation)) return 0
  const turn = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  return turn as QuarterTurn
}

/**
 * Rotate a point inside the unit square clockwise by a quarter turn, the way
 * the server turns the cropped image: what was the top-left corner ends up
 * top-right after 90°.
 */
export function rotatePoint(p: Point, rotation: number | null | undefined): Point {
  switch (quarterTurn(rotation)) {
    case 90: return { x: 1 - p.y, y: p.x }
    case 180: return { x: 1 - p.x, y: 1 - p.y }
    case 270: return { x: p.y, y: 1 - p.x }
    default: return p
  }
}

/**
 * A block as it appears in the rendered view: re-based onto the crop, then
 * turned with it. The bounding box is recomputed from the turned corners,
 * because a turned rectangle's left is no longer its old left.
 */
export function mapBlockIntoView(block: PhotoOcrBlock, view: ViewTransform): PhotoOcrBlock {
  const cropped = view.crop ? mapBlockIntoCrop(block, view.crop) : block
  const turn = quarterTurn(view.rotation)
  if (turn === 0) return cropped

  const polygon = cropped.polygon.map(p => rotatePoint(p, turn))
  const corners = [
    { x: cropped.left, y: cropped.top },
    { x: cropped.right, y: cropped.top },
    { x: cropped.right, y: cropped.bottom },
    { x: cropped.left, y: cropped.bottom },
  ].map(p => rotatePoint(p, turn))
  const xs = corners.map(p => p.x)
  const ys = corners.map(p => p.y)
  return {
    ...cropped,
    polygon,
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  }
}

/**
 * True when a line is at least partly inside the visible area. A line the
 * crop cut off entirely has nothing to select, so it is not laid out — it
 * would only sit invisibly outside the image and catch drags.
 */
export function isVisibleLayout(layout: LineLayout): boolean {
  const right = layout.x + layout.width
  const bottom = layout.y + layout.height
  return right > 0 && bottom > 0 && layout.x < 1 && layout.y < 1
}
