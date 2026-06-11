// Layout geometry + cover-crop math for the photo collage feature.
//
// A collage is a fixed-aspect canvas split into N rectangular cells, one per
// selected photo. For each supported photo count (2..9) we offer three
// hand-tuned layout *variants*. Cell rectangles are normalized (0..1) inside
// the collage canvas; the canvas pixel size is derived from the layout's
// `aspect` (width / height) at render time.
//
// The cover-crop helpers replicate CSS `object-fit: cover` + `object-position`
// so the on-canvas JPEG matches the DOM preview pixel-for-pixel, and reuse the
// gallery's `auto_crop` focal point to nudge faces / landmarks toward the
// visible centre of each cell (the "same algorithm as the thumbnail grid").

export interface CollageCell {
  /** Left edge, fraction of canvas width (0..1). */
  x: number
  /** Top edge, fraction of canvas height (0..1). */
  y: number
  /** Width, fraction of canvas width (0..1). */
  w: number
  /** Height, fraction of canvas height (0..1). */
  h: number
}

export interface CollageLayout {
  /** Stable id, unique within a photo count (used as the picker key). */
  id: string
  /** Human label shown under the picker thumbnail. */
  name: string
  /** Canvas aspect ratio, width / height. */
  aspect: number
  /** Exactly `count` cells, in fill order. */
  cells: CollageCell[]
}

const FULL: CollageCell = { x: 0, y: 0, w: 1, h: 1 }

function cell(x: number, y: number, w: number, h: number): CollageCell {
  return { x, y, w, h }
}

/** `cols × rows` even grid, row-major, filling `region`. */
function gridCells(cols: number, rows: number, region: CollageCell = FULL): CollageCell[] {
  const cw = region.w / cols
  const ch = region.h / rows
  const out: CollageCell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch))
    }
  }
  return out
}

/**
 * Horizontal bands: `counts.length` equal-height rows, row `i` split into
 * `counts[i]` equal-width cells. Rows of differing widths produce the
 * asymmetric "mosaic" variants.
 */
function rowBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const rows = counts.length
  const ch = region.h / rows
  const out: CollageCell[] = []
  counts.forEach((n, r) => {
    const cw = region.w / n
    for (let c = 0; c < n; c++) {
      out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch))
    }
  })
  return out
}

/**
 * Vertical bands: `counts.length` equal-width columns, column `i` split into
 * `counts[i]` equal-height cells (the transpose of `rowBands`).
 */
function colBands(counts: number[], region: CollageCell = FULL): CollageCell[] {
  const cols = counts.length
  const cw = region.w / cols
  const out: CollageCell[] = []
  counts.forEach((n, c) => {
    const ch = region.h / n
    for (let r = 0; r < n; r++) {
      out.push(cell(region.x + c * cw, region.y + r * ch, cw, ch))
    }
  })
  return out
}

/** Big hero cell on the left + the remaining photos in horizontal bands on the right. */
function heroLeft(heroW: number, restRows: number[]): CollageCell[] {
  return [cell(0, 0, heroW, 1), ...rowBands(restRows, { x: heroW, y: 0, w: 1 - heroW, h: 1 })]
}

// Curated layout table. Each count maps to exactly three distinct variants.
const LAYOUTS: Record<number, CollageLayout[]> = {
  2: [
    { id: 'side', name: 'Nebeneinander', aspect: 3 / 2, cells: rowBands([2]) },
    { id: 'stack', name: 'Übereinander', aspect: 3 / 4, cells: colBands([2]) },
    { id: 'big-left', name: 'Groß + Klein', aspect: 3 / 2, cells: [cell(0, 0, 0.62, 1), cell(0.62, 0, 0.38, 1)] },
  ],
  3: [
    { id: 'cols', name: 'Spalten', aspect: 3 / 2, cells: rowBands([3]) },
    { id: 'hero-left', name: 'Held links', aspect: 3 / 2, cells: heroLeft(0.6, [1, 1]) },
    {
      id: 'hero-top',
      name: 'Held oben',
      aspect: 1,
      cells: [cell(0, 0, 1, 0.6), cell(0, 0.6, 0.5, 0.4), cell(0.5, 0.6, 0.5, 0.4)],
    },
  ],
  4: [
    { id: 'grid', name: 'Raster 2×2', aspect: 1, cells: gridCells(2, 2) },
    { id: 'cols', name: 'Spalten', aspect: 16 / 9, cells: rowBands([4]) },
    { id: 'hero-left', name: 'Held links', aspect: 3 / 2, cells: heroLeft(0.6, [1, 1, 1]) },
  ],
  5: [
    {
      id: 'hero-left',
      name: 'Held links',
      aspect: 3 / 2,
      cells: [cell(0, 0, 0.6, 1), ...gridCells(2, 2, { x: 0.6, y: 0, w: 0.4, h: 1 })],
    },
    { id: 'two-three', name: '2 / 3', aspect: 3 / 2, cells: rowBands([2, 3]) },
    { id: 'three-two', name: '3 / 2', aspect: 3 / 2, cells: rowBands([3, 2]) },
  ],
  6: [
    { id: 'grid-3x2', name: 'Raster 3×2', aspect: 3 / 2, cells: gridCells(3, 2) },
    { id: 'grid-2x3', name: 'Raster 2×3', aspect: 2 / 3, cells: gridCells(2, 3) },
    { id: 'two-four', name: '2 groß / 4', aspect: 3 / 2, cells: rowBands([2, 4]) },
  ],
  7: [
    { id: 'three-four', name: '3 / 4', aspect: 3 / 2, cells: rowBands([3, 4]) },
    { id: 'hero-left', name: 'Held links', aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 3, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: 'four-three', name: '4 / 3', aspect: 3 / 2, cells: rowBands([4, 3]) },
  ],
  8: [
    { id: 'grid-4x2', name: 'Raster 4×2', aspect: 16 / 9, cells: gridCells(4, 2) },
    { id: 'grid-2x4', name: 'Raster 2×4', aspect: 9 / 16, cells: gridCells(2, 4) },
    { id: 'three-two-three', name: '3 / 2 / 3', aspect: 1, cells: rowBands([3, 2, 3]) },
  ],
  9: [
    { id: 'grid-3x3', name: 'Raster 3×3', aspect: 1, cells: gridCells(3, 3) },
    { id: 'hero-left', name: 'Held links', aspect: 3 / 2, cells: [cell(0, 0, 0.5, 1), ...gridCells(2, 4, { x: 0.5, y: 0, w: 0.5, h: 1 })] },
    { id: 'two-three-four', name: '2 / 3 / 4', aspect: 3 / 2, cells: rowBands([2, 3, 4]) },
  ],
}

export const MIN_COLLAGE_PHOTOS = 2
export const MAX_COLLAGE_PHOTOS = 9

/** Whether `count` photos can form a collage (2..9 inclusive). */
export function canCollage(count: number): boolean {
  return count >= MIN_COLLAGE_PHOTOS && count <= MAX_COLLAGE_PHOTOS
}

/**
 * The three layout variants for `count` photos. Returns `[]` for counts
 * outside the supported 2..9 range (callers gate on `canCollage`). Every
 * returned layout has exactly `count` cells.
 */
export function collageLayouts(count: number): CollageLayout[] {
  return LAYOUTS[count] ?? []
}

export interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Source rectangle to pass to `ctx.drawImage` so an image of natural size
 * `natW × natH` fills a destination cell of aspect `destAspect` exactly like
 * CSS `object-fit: cover` with `object-position: focal.x focal.y`.
 *
 * `focal` is the normalized (0..1) point that should stay visible — the
 * gallery's `auto_crop`. Defaults to the centre when absent. `zoom > 1`
 * shrinks the visible window (magnifies the focal region); `zoom = 1` matches
 * plain `cover` and keeps the preview identical to the export.
 */
export function coverCropRect(
  natW: number,
  natH: number,
  destAspect: number,
  focal?: { x: number; y: number } | null,
  zoom = 1,
): SourceRect {
  if (!(natW > 0) || !(natH > 0) || !(destAspect > 0)) {
    return { sx: 0, sy: 0, sw: Math.max(0, natW), sh: Math.max(0, natH) }
  }
  const imgAspect = natW / natH
  let sw: number
  let sh: number
  if (imgAspect > destAspect) {
    // Image is wider than the cell → full height, crop the sides.
    sh = natH
    sw = natH * destAspect
  } else {
    // Image is taller than (or equal to) the cell → full width, crop top/bottom.
    sw = natW
    sh = natW / destAspect
  }
  const z = zoom > 0 ? zoom : 1
  sw /= z
  sh /= z
  const px = clamp01(focal?.x)
  const py = clamp01(focal?.y)
  const sx = (natW - sw) * px
  const sy = (natH - sh) * py
  return { sx, sy, sw, sh }
}

function clamp01(v: number | undefined | null): number {
  if (v == null || !Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * CSS `object-position` value for a preview `<img>` (object-fit: cover) that
 * keeps the `auto_crop` focal point visible — mirrors `coverCropRect` so the
 * DOM preview and the rendered JPEG agree.
 */
export function collageObjectPosition(focal?: { x: number; y: number } | null): string {
  const x = clamp01(focal?.x)
  const y = clamp01(focal?.y)
  return `${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%`
}

/** Swap entries `i` and `j` in `order`, returning a new array. */
export function swapOrder(order: number[], i: number, j: number): number[] {
  if (i === j || i < 0 || j < 0 || i >= order.length || j >= order.length) {
    return order.slice()
  }
  const next = order.slice()
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}
