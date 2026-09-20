export type GallerySortDir = 'asc' | 'desc'

/**
 * Index of the newest photo in a date-sorted grid of `total` items.
 * Ascending date sort puts the newest at the end; descending at the start.
 */
export function newestIndex(total: number, dir: GallerySortDir): number {
  if (total <= 0) return 0
  return dir === 'asc' ? total - 1 : 0
}

/** Index of the oldest photo (mirror of newestIndex). */
export function oldestIndex(total: number, dir: GallerySortDir): number {
  if (total <= 0) return 0
  return dir === 'asc' ? 0 : total - 1
}

/** Target index for a "jump to newest / oldest" action. */
export function jumpTargetIndex(
  target: 'newest' | 'oldest',
  total: number,
  dir: GallerySortDir,
): number {
  return target === 'newest' ? newestIndex(total, dir) : oldestIndex(total, dir)
}

/**
 * Whether the viewport sits in the second half of a scroller, with a band
 * around the middle so the answer does not chatter while crossing it.
 *
 * Deliberately a position, not an "am I at an end" flag: a phone collapses
 * and restores its URL bar while scrolling, which changes the scroller's
 * height by ~60px. An edge flag flips on every one of those, and anything
 * driven by it — the gallery's jump button, and with it the whole toolbar —
 * redraws in a loop. Halfway is far from both edges, so a height change of
 * that size cannot cross it.
 */
export const HALF_ENTER = 0.55
export const HALF_LEAVE = 0.45

export function isPastHalf(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  wasPastHalf: boolean,
): boolean {
  const max = scrollHeight - clientHeight
  // Nothing to scroll: the whole list is in view, so it is not "past" it.
  if (max <= 0) return false
  const ratio = scrollTop / max
  return wasPastHalf ? ratio > HALF_LEAVE : ratio > HALF_ENTER
}
