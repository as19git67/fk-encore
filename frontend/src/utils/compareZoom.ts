/**
 * Pure zoom math for the compare-view's "zoom to face" feature
 * (Track N / #79). Given a normalized face bbox and a viewport that hosts
 * a photo rendered with `object-fit: contain`, returns the CSS `transform`
 * + `transform-origin` that brings the bbox centre to the viewport centre
 * at a chosen zoom level.
 *
 * Designed to be consumed by `PhotoCompareView.vue`. Kept side-effect-free
 * so the math is unit-testable without a DOM.
 */

export interface BBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ZoomViewport {
  /** Container element CSS dimensions (in CSS px). */
  width: number
  height: number
  /** Photo intrinsic pixel dimensions (naturalWidth / naturalHeight). */
  photoWidth: number
  photoHeight: number
}

export interface ZoomComputation {
  zoom: number
  transform: string
  transformOrigin: string
  /** Effective on-screen size of the bbox after the zoom (CSS px). */
  faceScreen: { width: number; height: number }
}

const DEFAULTS = { targetFraction: 0.4, minZoom: 1, maxZoom: 6 }

function isValidBbox(b: BBox): boolean {
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false
  if (b.width <= 0 || b.height <= 0) return false
  if (b.x < -0.1 || b.x > 1.1) return false
  if (b.y < -0.1 || b.y > 1.1) return false
  return true
}

function isValidViewport(vp: ZoomViewport): boolean {
  return (
    Number.isFinite(vp.width) &&
    Number.isFinite(vp.height) &&
    Number.isFinite(vp.photoWidth) &&
    Number.isFinite(vp.photoHeight) &&
    vp.width > 0 &&
    vp.height > 0 &&
    vp.photoWidth > 0 &&
    vp.photoHeight > 0
  )
}

/**
 * The rect occupied by the photo content within the viewport under
 * `object-fit: contain`. Letterboxed in one axis when the aspect ratios
 * don't match.
 */
export function containedRect(vp: ZoomViewport): {
  w: number
  h: number
  offsetX: number
  offsetY: number
} {
  const imgAspect = vp.photoWidth / vp.photoHeight
  const containerAspect = vp.width / vp.height
  let w: number
  let h: number
  if (imgAspect > containerAspect) {
    w = vp.width
    h = vp.width / imgAspect
  } else {
    h = vp.height
    w = vp.height * imgAspect
  }
  return {
    w,
    h,
    offsetX: (vp.width - w) / 2,
    offsetY: (vp.height - h) / 2,
  }
}

/**
 * Build the CSS transform that zooms a `object-fit: contain` photo inside
 * `vp` so `bbox` is centred. If `opts.zoom` is given, that exact zoom is
 * used (clamped to `[minZoom, maxZoom]`); otherwise the zoom is derived
 * from `targetFraction` so the bbox fills that fraction of the smaller
 * viewport axis. The transform-origin / translate values are derived so
 * the bbox centre lands at the viewport centre regardless of the photo's
 * aspect ratio.
 */
export function computeBboxZoom(
  bbox: BBox,
  vp: ZoomViewport,
  opts: {
    zoom?: number
    targetFraction?: number
    maxZoom?: number
    minZoom?: number
  } = {},
): ZoomComputation | null {
  if (!isValidBbox(bbox) || !isValidViewport(vp)) return null
  const targetFraction = opts.targetFraction ?? DEFAULTS.targetFraction
  const minZoom = opts.minZoom ?? DEFAULTS.minZoom
  const maxZoom = opts.maxZoom ?? DEFAULTS.maxZoom

  const rect = containedRect(vp)
  const faceCxImg = bbox.x + bbox.width / 2
  const faceCyImg = bbox.y + bbox.height / 2
  const faceCxPx = rect.offsetX + faceCxImg * rect.w
  const faceCyPx = rect.offsetY + faceCyImg * rect.h
  const facePxW = bbox.width * rect.w
  const facePxH = bbox.height * rect.h

  let zoom: number
  if (opts.zoom !== undefined && Number.isFinite(opts.zoom)) {
    zoom = opts.zoom
  } else {
    const targetPx = targetFraction * Math.min(vp.width, vp.height)
    zoom = Math.min(targetPx / facePxW, targetPx / facePxH)
  }
  zoom = Math.min(Math.max(zoom, minZoom), maxZoom)

  // CSS applies transforms left-to-right as matrix multiplication, so for
  // `transform: scale(z) translate(tx, ty)` translation is applied first in
  // local space and then scaled. The effective screen-space shift of any
  // point is therefore `z * (tx, ty)`. Solving for the centre of the
  // viewport:
  //   faceCxPx + z * tx = vp.width / 2  →  tx = (vp.width/2 - faceCxPx) / z
  const cx = vp.width / 2
  const cy = vp.height / 2
  const tx = (cx - faceCxPx) / zoom
  const ty = (cy - faceCyPx) / zoom

  return {
    zoom,
    transform: `scale(${zoom.toFixed(3)}) translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`,
    transformOrigin: `${((faceCxPx / vp.width) * 100).toFixed(2)}% ${(
      (faceCyPx / vp.height) *
      100
    ).toFixed(2)}%`,
    faceScreen: { width: zoom * facePxW, height: zoom * facePxH },
  }
}

export interface SyncZoomInput {
  bbox: BBox
  viewport: ZoomViewport
}

/**
 * Compute matched zoom transforms for two photos so the two bboxes appear
 * at roughly the same on-screen size — the "equalize face size" behaviour
 * spelled out in issue #79. The independent zoom is computed for each
 * photo, then the smaller resulting face-width is used as the common
 * target and both photos are re-solved at that target. This keeps both
 * bboxes inside their respective viewports.
 */
export function computeSyncBboxZoom(
  a: SyncZoomInput,
  b: SyncZoomInput,
  opts: { targetFraction?: number; maxZoom?: number; minZoom?: number } = {},
): { a: ZoomComputation | null; b: ZoomComputation | null } {
  const zA = computeBboxZoom(a.bbox, a.viewport, opts)
  const zB = computeBboxZoom(b.bbox, b.viewport, opts)
  if (!zA || !zB) return { a: zA, b: zB }
  const targetW = Math.min(zA.faceScreen.width, zB.faceScreen.width)
  const rectA = containedRect(a.viewport)
  const rectB = containedRect(b.viewport)
  const newZoomA = targetW / (a.bbox.width * rectA.w)
  const newZoomB = targetW / (b.bbox.width * rectB.w)
  return {
    a: computeBboxZoom(a.bbox, a.viewport, { ...opts, zoom: newZoomA }),
    b: computeBboxZoom(b.bbox, b.viewport, { ...opts, zoom: newZoomB }),
  }
}

/**
 * Pick the best face bbox for a "zoom to face" gesture. Faces with a
 * `person_id` (the user has tagged them) beat unassigned faces; among
 * those, higher quality and larger bboxes win. Returns `null` when no
 * usable face is present.
 */
export interface PickFaceInput {
  bbox: BBox
  person_id?: number | null
  quality?: number | null
  ignored?: boolean
}

export function pickPrimaryBbox(
  faces: PickFaceInput[],
): { source: 'face'; bbox: BBox; person_id?: number | null } | null {
  const usable = faces.filter((f) => !f.ignored && isValidBbox(f.bbox))
  if (usable.length > 0) {
    const scored = usable
      .map((f) => ({
        f,
        score:
          (f.person_id ? 1000 : 0) +
          (f.quality ?? 0) * 10 +
          f.bbox.width * f.bbox.height,
      }))
      .sort((a, b) => b.score - a.score)
    const top = scored[0]!.f
    return { source: 'face', bbox: top.bbox, person_id: top.person_id ?? null }
  }
  return null
}

/**
 * For the "same person on both photos" optimisation (issue #79). Given a
 * person_id, return the largest assigned face in `faces` for that person.
 * Returns `null` when no face for that person exists.
 */
export function findFaceForPerson(
  faces: PickFaceInput[],
  personId: number,
): BBox | null {
  const matches = faces.filter(
    (f) => !f.ignored && f.person_id === personId && isValidBbox(f.bbox),
  )
  if (matches.length === 0) return null
  return [...matches].sort(
    (a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height,
  )[0]!.bbox
}

/**
 * Click-position-aware bbox picker for group photos. When the user
 * double-clicks a specific face in a multi-person shot, that face is
 * the intended zoom target — not whatever `pickPrimaryBbox()` would
 * have chosen globally.
 *
 * The `point` is in normalized image coords (0..1 of the photo).
 * Priority:
 *  1. Faces whose bbox CONTAINS the point. On a stack pick the tightest
 *     (smallest area) — that's almost certainly the face the user
 *     actually pointed at.
 *  2. The nearest face by centre distance, but only if it sits within
 *     `nearRadius` of the click (default 0.15 of image diagonal).
 *  3. Fall through to `pickPrimaryBbox` — the user clicked on neutral
 *     background and we should pick something reasonable.
 */
export function pickBboxAtPoint(
  faces: PickFaceInput[],
  point: { x: number; y: number },
  opts: { nearRadius?: number } = {},
): { source: 'face'; bbox: BBox; person_id?: number | null } | null {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    return pickPrimaryBbox(faces)
  }
  const usable = faces.filter((f) => !f.ignored && isValidBbox(f.bbox))
  if (usable.length === 0) return pickPrimaryBbox(faces)

  const containing = usable.filter(
    (f) =>
      point.x >= f.bbox.x &&
      point.x <= f.bbox.x + f.bbox.width &&
      point.y >= f.bbox.y &&
      point.y <= f.bbox.y + f.bbox.height,
  )
  if (containing.length > 0) {
    const tightest = [...containing].sort(
      (a, b) => a.bbox.width * a.bbox.height - b.bbox.width * b.bbox.height,
    )[0]!
    return { source: 'face', bbox: tightest.bbox, person_id: tightest.person_id ?? null }
  }

  const nearRadius = opts.nearRadius ?? 0.15
  const scored = usable.map((f) => ({
    f,
    d: Math.hypot(
      f.bbox.x + f.bbox.width / 2 - point.x,
      f.bbox.y + f.bbox.height / 2 - point.y,
    ),
  }))
  scored.sort((a, b) => a.d - b.d)
  const closest = scored[0]!
  if (closest.d <= nearRadius) {
    return { source: 'face', bbox: closest.f.bbox, person_id: closest.f.person_id ?? null }
  }

  return pickPrimaryBbox(faces)
}

/**
 * Convert a click event coordinate (viewport px) to normalized image
 * coordinates (0..1 of the photo content), accounting for
 * `object-fit: contain` letterboxing. Returns `null` when the click
 * lands on a letterbox stripe — the caller should treat that as
 * "no specific face picked".
 */
export function clickPointToImageCoords(
  vp: ZoomViewport,
  containerOffset: { left: number; top: number },
  clickX: number,
  clickY: number,
): { x: number; y: number } | null {
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return null
  const rect = containedRect(vp)
  const relX = clickX - containerOffset.left - rect.offsetX
  const relY = clickY - containerOffset.top - rect.offsetY
  if (relX < 0 || relX > rect.w) return null
  if (relY < 0 || relY > rect.h) return null
  return { x: relX / rect.w, y: relY / rect.h }
}
