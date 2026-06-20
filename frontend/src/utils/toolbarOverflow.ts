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
