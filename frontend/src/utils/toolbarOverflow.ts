/**
 * Pure layout math for {@link ResponsiveToolbar}.
 *
 * Given the natural width of each toolbar item, decide how many fit on a
 * single row of `available` pixels. If they do not all fit, room for an
 * overflow toggle (`overflowWidth`) is reserved and the remaining items spill
 * into a dropdown.
 *
 * Kept free of any DOM access so the (otherwise hard to reach) overflow logic
 * can be unit-tested directly.
 *
 * @param itemWidths   Natural pixel width of each item, in display order.
 * @param overflowWidth Pixel width of the overflow toggle button.
 * @param available    Pixel width available for the toolbar row.
 * @param gap          Pixel gap rendered between adjacent items.
 * @returns Number of leading items to render inline (the rest overflow).
 */
export function computeVisibleCount(
  itemWidths: number[],
  overflowWidth: number,
  available: number,
  gap: number,
): number {
  // Does everything fit without needing an overflow button at all?
  let totalAll = 0
  itemWidths.forEach((w, i) => {
    totalAll += w + (i > 0 ? gap : 0)
  })
  if (totalAll <= available) return itemWidths.length

  // Otherwise reserve room for the overflow toggle and fit what we can.
  let total = 0
  let count = 0
  for (let i = 0; i < itemWidths.length; i++) {
    const width = itemWidths[i] ?? 0
    const add = width + (i > 0 ? gap : 0)
    if (total + add + gap + overflowWidth <= available) {
      total += add
      count++
    } else {
      break
    }
  }
  return count
}

/**
 * Whether a freshly measured item count would continue a two-state
 * oscillation, i.e. the toolbar is caught in a measurement loop.
 *
 * `ResponsiveToolbar` measures the width it has, decides how many items fit
 * and renders them — and in a wrapping flex row the rendered items can
 * change that very width again (fewer items → the row no longer wraps → a
 * different width → a different count → …). The result is a toolbar that
 * flips between two layouts for as long as the page is open, which shifts
 * everything below it on every flip.
 *
 * The CSS keeps the container's width independent of its contents, so the
 * loop should not arise in the first place; this is the safety net for the
 * layouts (and browsers) where it still does.
 *
 * @param applied   Counts applied so far, oldest first; only the last two matter.
 * @param candidate The count the current measurement asks for.
 */
export function continuesOscillation(applied: readonly number[], candidate: number): boolean {
  const last = applied[applied.length - 1]
  const beforeLast = applied[applied.length - 2]
  if (last === undefined || beforeLast === undefined) return false
  return candidate !== last && candidate === beforeLast
}
