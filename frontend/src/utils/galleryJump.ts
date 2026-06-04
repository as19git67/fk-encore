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
