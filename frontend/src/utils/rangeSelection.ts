/**
 * Shift-click range selection for the photo grid (issue #830).
 *
 * The grid's selection is a flat `Set<number>` of photo ids, but a range is
 * expressed in grid positions, so a range click needs two things the Set does
 * not carry: where the last plain click landed, and whether that click was
 * selecting or deselecting. The anchor holds both — a shift-click then repeats
 * that decision across everything between anchor and click, which is what makes
 * "shift-click again to deselect the span" work without a second gesture.
 *
 * The anchor deliberately survives a range click, so dragging the range wider
 * or narrower with repeated shift-clicks keeps measuring from the same photo.
 */

/** Where the last plain click landed, and what it did. */
export interface SelectionAnchor {
  /** Absolute index of the photo in the current grid order. */
  index: number
  /** True when that click selected the photo, false when it deselected it. */
  adding: boolean
}

/**
 * Above this many photos a range is resolved from the server's id list in one
 * request instead of page-by-page through the grid source (150 photos per
 * page). Below it the pages are usually loaded already — or worth loading,
 * since the user is looking at them.
 */
export const RANGE_ID_FETCH_THRESHOLD = 300

/** Ordered bounds of the span between two indexes, either way round. */
export function rangeBounds(a: number, b: number): { start: number; end: number } {
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/**
 * Toggle one photo. Returns a fresh Set (the grid's refs are compared by
 * identity, so mutating in place would not re-render) plus what the click did,
 * which becomes the new anchor's direction.
 */
export function toggleOne(
  selected: ReadonlySet<number>,
  id: number,
): { selected: Set<number>; adding: boolean } {
  const next = new Set(selected)
  const adding = !next.has(id)
  if (adding) next.add(id)
  else next.delete(id)
  return { selected: next, adding }
}

/** Apply the anchor's direction to every photo in the range. */
export function applyRange(
  selected: ReadonlySet<number>,
  ids: readonly number[],
  adding: boolean,
): Set<number> {
  const next = new Set(selected)
  for (const id of ids) {
    if (adding) next.add(id)
    else next.delete(id)
  }
  return next
}

/**
 * The photo ids at grid positions `start..end` (both inclusive).
 *
 * The grid source is sparse — only the pages around the viewport are loaded —
 * so the ids of a span the user scrolled past are not necessarily in memory.
 * A short span is filled through the source (which fetches the missing pages
 * and keeps them cached for the grid itself); a long one takes the ordered id
 * list the "select all" action already uses, because one request beats dozens
 * of page fetches. Positions that resolve to nothing are skipped rather than
 * failing the whole range.
 */
export async function collectRangeIds(
  start: number,
  end: number,
  source: {
    loadEntryAt: (index: number) => Promise<{ id: number } | null | undefined>
    fetchAllIds: () => Promise<number[]>
  },
  threshold: number = RANGE_ID_FETCH_THRESHOLD,
): Promise<number[]> {
  if (end < start) return []
  const length = end - start + 1

  if (length > threshold) {
    const ids = await source.fetchAllIds()
    return ids.slice(start, end + 1)
  }

  const entries = await Promise.all(
    Array.from({ length }, (_, i) => source.loadEntryAt(start + i)),
  )
  return entries.filter((e): e is { id: number } => !!e).map(e => e.id)
}
