/**
 * Which row the split view is showing, as the list under it changes.
 *
 * The rule the issue asks for is "always exactly one row is current, as long
 * as there is one" — which is easy to state and easy to get wrong in the two
 * moments the list moves underneath: a reload that drops the current row
 * (deleted, filtered away, a search narrowed) and keyboard navigation at the
 * ends. Both are decided here so the view holds no arithmetic.
 */

export interface HasId {
  id: number
}

/**
 * The row to make current after the list changed.
 *
 * Keeps the current one when it is still there, so a reload or a background
 * refresh does not move the detail pane out from under the reader. Otherwise
 * falls to the row that took its place — the one now at the old index, which
 * after a deletion is the following row and after a shortening is the last —
 * and to nothing at all when the list ran empty.
 */
export function resolveActiveId<T extends HasId>(
  items: readonly T[],
  currentId: number | null,
  previousItems: readonly T[] = [],
): number | null {
  if (items.length === 0) return null
  if (currentId != null && items.some((item) => item.id === currentId)) return currentId

  const previousIndex = previousItems.findIndex((item) => item.id === currentId)
  if (previousIndex >= 0) {
    return items[Math.min(previousIndex, items.length - 1)]!.id
  }
  return items[0]!.id
}

/**
 * The row `delta` steps from the current one.
 *
 * Stops at the ends rather than wrapping: in a list that pages in more rows on
 * demand, wrapping from the last row to the first reads as a jump to somewhere
 * else entirely. Returns the current id unchanged when there is nowhere to go,
 * so the caller can skip the work without a second comparison.
 */
export function stepActiveId<T extends HasId>(
  items: readonly T[],
  currentId: number | null,
  delta: number,
): number | null {
  if (items.length === 0) return null
  const index = items.findIndex((item) => item.id === currentId)
  if (index < 0) return items[0]!.id
  const next = Math.min(Math.max(index + delta, 0), items.length - 1)
  return items[next]!.id
}
