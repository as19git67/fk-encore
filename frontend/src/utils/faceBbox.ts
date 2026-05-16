import type { FaceBBox } from '../api/photos'

export function validBbox(bbox: FaceBBox | undefined | null): FaceBBox | null {
  if (!bbox) return null
  if (bbox.x > 1.1 || bbox.y > 1.1) return null
  return bbox
}

export function thumbnailZoom(bbox: FaceBBox | undefined | null): number {
  const b = validBbox(bbox)
  if (!b) return 1
  return Math.min(4, Math.max(1.5, 0.4 / Math.max(b.width, b.height)))
}

export function thumbnailImageStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return {}
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const zoom = thumbnailZoom(bbox)
  return {
    objectPosition: `${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%`,
    transform: `scale(${zoom.toFixed(2)}) translate(${((0.5 - cx) * 100).toFixed(1)}%, ${((0.5 - cy) * 100).toFixed(1)}%)`,
    transformOrigin: '50% 50%',
  }
}

export function faceBoxStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return { display: 'none' }
  return {
    left: `${(b.x * 100).toFixed(2)}%`,
    top: `${(b.y * 100).toFixed(2)}%`,
    width: `${(b.width * 100).toFixed(2)}%`,
    height: `${(b.height * 100).toFixed(2)}%`,
  }
}

export function thumbnailSrcWidth(bbox: FaceBBox | undefined | null): number {
  const zoom = thumbnailZoom(bbox)
  return zoom >= 2 ? 800 : zoom >= 1.5 ? 600 : 400
}

/**
 * Gallery-tile style for thumbnails that have an `auto_crop` centre but no
 * bbox. `auto_crop` is the server-computed focal point (face or landmark
 * centre, normalized 0..1) that the gallery uses to pick the visible crop
 * under `object-fit: cover`. Combined with a moderate scale anchored at
 * that same point, the face/landmark ends up both *visible* (via
 * `object-position`) and *more prominent* (via the scale) — the
 * "zoom and move" requested by issue #73 / Track N.
 *
 * Anchoring the scale at the auto-crop point keeps that pixel stationary
 * on screen, so the face does not drift to a tile corner under zoom; the
 * surrounding content is what gets clipped by the tile's `overflow:hidden`.
 */
export function autoCropThumbnailStyle(
  autoCrop: { x: number; y: number } | undefined | null,
): Record<string, string> {
  if (!autoCrop) return {}
  const { x, y } = autoCrop
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {}
  if (x < 0 || x > 1 || y < 0 || y > 1) return {}
  const zoom = 1.18
  const xPct = (x * 100).toFixed(1)
  const yPct = (y * 100).toFixed(1)
  return {
    objectPosition: `${xPct}% ${yPct}%`,
    transform: `scale(${zoom})`,
    transformOrigin: `${xPct}% ${yPct}%`,
  }
}
