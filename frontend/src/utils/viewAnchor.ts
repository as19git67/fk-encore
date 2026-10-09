/**
 * Keeping the spot the user looks at in place while the pages change size.
 *
 * A zoom re-measures every page, so a scroll offset in pixels would land
 * somewhere else afterwards. Instead the viewer remembers *which page* sits
 * under a focal point on screen and *where on that page* — as fractions of
 * its width and height, which do not change with the scale — and after the
 * relayout scrolls so that the same spot is back under the same screen point.
 *
 * The geometry is kept free of the DOM so it can be tested with plain
 * rectangles; the viewer measures with `getBoundingClientRect` and feeds the
 * results in.
 */

/** The parts of a `DOMRect` the anchor math needs. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** A point in viewport (client) coordinates. */
export interface ClientPoint {
  clientX: number
  clientY: number
}

export interface ViewAnchor extends ClientPoint {
  /** The page under (or, in a gap, nearest to) the focal point. */
  pageNumber: number
  /** Horizontal position on that page, 0 at its left edge, 1 at its right. */
  fx: number
  /** Vertical position on that page, 0 at its top edge, 1 at its bottom. */
  fy: number
}

/**
 * Pick the page under the focal point and express the point in page
 * fractions. Between two pages (in the gap) the nearer one is taken; above
 * the first or below the last page the fraction leaves the 0…1 range, which
 * is intended — restoring it then keeps the same distance from the page edge.
 */
export function captureViewAnchor(
  rects: Iterable<readonly [pageNumber: number, rect: Rect]>,
  focal: ClientPoint,
): ViewAnchor | null {
  let best: { pageNumber: number; rect: Rect } | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [pageNumber, rect] of rects) {
    const bottom = rect.top + rect.height
    const distance =
      focal.clientY < rect.top ? rect.top - focal.clientY : focal.clientY > bottom ? focal.clientY - bottom : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = { pageNumber, rect }
    }
  }
  if (!best) return null
  const { rect } = best
  return {
    pageNumber: best.pageNumber,
    fx: rect.width > 0 ? (focal.clientX - rect.left) / rect.width : 0.5,
    fy: rect.height > 0 ? (focal.clientY - rect.top) / rect.height : 0,
    clientX: focal.clientX,
    clientY: focal.clientY,
  }
}

/**
 * How far the scroll offsets have to move so that the anchored spot on the
 * page, now measured at `rect`, lands back under the anchor's screen point.
 * Positive values scroll right/down.
 */
export function anchorScrollDelta(anchor: ViewAnchor, rect: Rect): { dx: number; dy: number } {
  return {
    dx: rect.left + anchor.fx * rect.width - anchor.clientX,
    dy: rect.top + anchor.fy * rect.height - anchor.clientY,
  }
}
