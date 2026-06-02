/**
 * Pure geometry for the "fling a photo off-screen to discard it" gesture in
 * PhotoCompareView. Kept framework-free so it can be unit-tested in isolation.
 *
 * The compare view shows two photos: in landscape side-by-side
 * (currentPair[0] = left, [1] = right), in portrait stacked
 * (currentPair[0] = top, [1] = bottom). A discard fling may go in any
 * direction EXCEPT toward the partner photo (swiping the two together is
 * ambiguous).
 */
export type FlingDir = 'left' | 'right' | 'up' | 'down'

/** The direction that points at the partner photo — the one a fling must not go. */
export function partnerDirection(indexInPair: number, isPortrait: boolean): FlingDir {
  if (isPortrait) return indexInPair === 0 ? 'down' : 'up'
  return indexInPair === 0 ? 'right' : 'left'
}

/**
 * The dominant fling direction for a drag delta, or `null` when the gesture is
 * too short to count as a decisive fling.
 */
export function flingDirection(dx: number, dy: number, minTravel: number): FlingDir | null {
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  if (Math.max(absX, absY) < minTravel) return null
  return absX >= absY ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
}

/**
 * The direction to discard the photo at `indexInPair`, or `null` when the
 * gesture is not a valid discard (too short, or pointing at the partner photo).
 */
export function discardFlingDirection(opts: {
  indexInPair: number
  isPortrait: boolean
  dx: number
  dy: number
  minTravel: number
}): FlingDir | null {
  const dir = flingDirection(opts.dx, opts.dy, opts.minTravel)
  if (!dir) return null
  if (dir === partnerDirection(opts.indexInPair, opts.isPortrait)) return null
  return dir
}

/** CSS translate that carries the tile off-screen in the given direction. */
export function flingOffscreenTranslate(dir: FlingDir): { tx: string; ty: string } {
  return {
    tx: dir === 'left' ? '-110vw' : dir === 'right' ? '110vw' : '0',
    ty: dir === 'up' ? '-110vh' : dir === 'down' ? '110vh' : '0',
  }
}
