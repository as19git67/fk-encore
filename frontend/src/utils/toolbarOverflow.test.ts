import { describe, it, expect } from 'vitest'
import { computeVisibleCount } from './toolbarOverflow'

describe('computeVisibleCount', () => {
  it('keeps every item inline when they all fit', () => {
    // 3 × 100 + 2 × 10 gap = 320 ≤ 400
    expect(computeVisibleCount([100, 100, 100], 30, 400, 10)).toBe(3)
  })

  it('fits exactly to the available width without reserving overflow space', () => {
    // 100 + 10 + 100 = 210 ≤ 210
    expect(computeVisibleCount([100, 100], 30, 210, 10)).toBe(2)
  })

  it('reserves room for the overflow toggle once something spills', () => {
    // All three need 320 > 300, so reserve the 30px toggle:
    //   item0: 100 + gap(10) + toggle(30) = 140 ≤ 300 → keep
    //   item1: +110 → 210 + 10 + 30 = 250 ≤ 300 → keep
    //   item2: +110 → 320 + 10 + 30 = 360 > 300 → stop
    expect(computeVisibleCount([100, 100, 100], 30, 300, 10)).toBe(2)
  })

  it('can push everything into the menu when nothing fits beside the toggle', () => {
    // item0 alone: 200 + gap(10) + toggle(30) = 240 > 100 → 0 inline
    expect(computeVisibleCount([200, 200], 30, 100, 10)).toBe(0)
  })

  it('handles an empty toolbar', () => {
    expect(computeVisibleCount([], 30, 400, 10)).toBe(0)
  })

  it('ignores the gap before the first inline item', () => {
    // Single item, no leading gap: 90 + gap(10) + toggle(30) = 130 ≤ 130
    expect(computeVisibleCount([90, 90], 30, 130, 10)).toBe(1)
  })
})
