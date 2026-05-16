/**
 * Pure zoom math for the compare-view's "zoom to face / landmark" feature
 * (Track N / #79). Given a normalized bbox (face or landmark) and a
 * viewport that hosts a photo rendered with `object-fit: contain`, returns
 * the CSS `transform` + `transform-origin` that brings the bbox centre to
 * the viewport centre at a chosen zoom level.
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
 * Pick the best bbox for a "zoom to face" gesture. Faces with a
 * `person_id` (the user has tagged them) beat unassigned faces; among
 * those, higher quality and larger bboxes win. Falls back to the top
 * landmark by confidence. Returns `null` when nothing is suitable.
 */
export interface PickFaceInput {
  bbox: BBox
  person_id?: number | null
  quality?: number | null
  ignored?: boolean
}

export interface PickLandmarkInput {
  bbox: BBox
  confidence: number
}

export function pickPrimaryBbox(
  faces: PickFaceInput[],
  landmarks: PickLandmarkInput[],
): { source: 'face' | 'landmark'; bbox: BBox; person_id?: number | null } | null {
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
  const usableLm = landmarks.filter((l) => isValidBbox(l.bbox))
  if (usableLm.length > 0) {
    const top = [...usableLm].sort((a, b) => b.confidence - a.confidence)[0]!
    return { source: 'landmark', bbox: top.bbox }
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
