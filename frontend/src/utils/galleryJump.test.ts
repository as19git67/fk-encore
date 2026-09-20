import { describe, it, expect } from 'vitest'
import { newestIndex, oldestIndex, jumpTargetIndex, isPastHalf } from './galleryJump'

describe('galleryJump', () => {
  it('newestIndex: end for ascending, start for descending', () => {
    expect(newestIndex(10, 'asc')).toBe(9)
    expect(newestIndex(10, 'desc')).toBe(0)
  })

  it('oldestIndex: start for ascending, end for descending', () => {
    expect(oldestIndex(10, 'asc')).toBe(0)
    expect(oldestIndex(10, 'desc')).toBe(9)
  })

  it('handles empty / single item lists safely', () => {
    expect(newestIndex(0, 'asc')).toBe(0)
    expect(oldestIndex(0, 'desc')).toBe(0)
    expect(newestIndex(1, 'asc')).toBe(0)
    expect(newestIndex(1, 'desc')).toBe(0)
  })

  it('jumpTargetIndex maps target + direction to the right edge', () => {
    expect(jumpTargetIndex('newest', 10, 'asc')).toBe(9)
    expect(jumpTargetIndex('oldest', 10, 'asc')).toBe(0)
    expect(jumpTargetIndex('newest', 10, 'desc')).toBe(0)
    expect(jumpTargetIndex('oldest', 10, 'desc')).toBe(9)
  })
})

describe('isPastHalf', () => {
  // A phone's URL bar collapsing and restoring changes the scroller's height
  // by about 60px on every scroll. The reported flicker was the jump button's
  // label flipping on each of those, which redrew the whole toolbar.
  const SCROLL_HEIGHT = 33_400

  it('is false while the whole list fits', () => {
    expect(isPastHalf(0, 800, 800, false)).toBe(false)
    expect(isPastHalf(0, 800, 500, true)).toBe(false)
  })

  it('turns on past the middle and off again before it', () => {
    const max = SCROLL_HEIGHT - 410
    expect(isPastHalf(max * 0.5, 410, SCROLL_HEIGHT, false)).toBe(false)
    expect(isPastHalf(max * 0.6, 410, SCROLL_HEIGHT, false)).toBe(true)
    // Coming back needs to fall below the lower edge of the band, not just
    // below the upper one — otherwise it chatters while crossing.
    expect(isPastHalf(max * 0.5, 410, SCROLL_HEIGHT, true)).toBe(true)
    expect(isPastHalf(max * 0.4, 410, SCROLL_HEIGHT, true)).toBe(false)
  })

  it('survives the viewport height change a phone makes while scrolling', () => {
    // Parked two pixels from the bottom, the position that used to flip.
    const tall = 470
    const short = 410
    const topShort = SCROLL_HEIGHT - short - 2
    const topTall = SCROLL_HEIGHT - tall
    let state = isPastHalf(topShort, short, SCROLL_HEIGHT, false)
    expect(state).toBe(true)
    for (let i = 0; i < 6; i++) {
      state = isPastHalf(topTall, tall, SCROLL_HEIGHT, state)
      expect(state).toBe(true)
      state = isPastHalf(topShort, short, SCROLL_HEIGHT, state)
      expect(state).toBe(true)
    }
  })

  it('also holds steady at the top of the list', () => {
    let state = isPastHalf(0, 410, SCROLL_HEIGHT, false)
    expect(state).toBe(false)
    state = isPastHalf(0, 470, SCROLL_HEIGHT, state)
    expect(state).toBe(false)
    state = isPastHalf(2, 410, SCROLL_HEIGHT, state)
    expect(state).toBe(false)
  })
})

