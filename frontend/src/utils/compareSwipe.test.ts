import { describe, it, expect } from 'vitest'
import {
  partnerDirection,
  flingDirection,
  discardFlingDirection,
  flingOffscreenTranslate,
} from './compareSwipe'

const MIN = 64

describe('partnerDirection', () => {
  it('points horizontally in landscape (left photo → right, right photo → left)', () => {
    expect(partnerDirection(0, false)).toBe('right')
    expect(partnerDirection(1, false)).toBe('left')
  })
  it('points vertically in portrait (top photo → down, bottom photo → up)', () => {
    expect(partnerDirection(0, true)).toBe('down')
    expect(partnerDirection(1, true)).toBe('up')
  })
})

describe('flingDirection', () => {
  it('returns null below the minimum travel', () => {
    expect(flingDirection(40, 0, MIN)).toBeNull()
    expect(flingDirection(-30, 30, MIN)).toBeNull()
  })
  it('picks the dominant axis and sign', () => {
    expect(flingDirection(-100, 10, MIN)).toBe('left')
    expect(flingDirection(100, -10, MIN)).toBe('right')
    expect(flingDirection(10, -100, MIN)).toBe('up')
    expect(flingDirection(-10, 100, MIN)).toBe('down')
  })
  it('prefers horizontal on an exact tie (absX >= absY)', () => {
    expect(flingDirection(70, 70, MIN)).toBe('right')
    expect(flingDirection(-70, -70, MIN)).toBe('left')
  })
})

describe('discardFlingDirection', () => {
  it('rejects a too-short gesture', () => {
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: false, dx: 10, dy: 0, minTravel: MIN }),
    ).toBeNull()
  })

  it('rejects a fling toward the partner photo (landscape)', () => {
    // Left photo swiped right = toward the right partner → not a discard.
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: false, dx: 100, dy: 0, minTravel: MIN }),
    ).toBeNull()
    // Right photo swiped left = toward the left partner → not a discard.
    expect(
      discardFlingDirection({ indexInPair: 1, isPortrait: false, dx: -100, dy: 0, minTravel: MIN }),
    ).toBeNull()
  })

  it('accepts flings away from the partner (landscape)', () => {
    // Left photo: left / up / down are all valid discards.
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: false, dx: -100, dy: 0, minTravel: MIN }),
    ).toBe('left')
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: false, dx: 0, dy: -100, minTravel: MIN }),
    ).toBe('up')
    // Right photo: right is valid.
    expect(
      discardFlingDirection({ indexInPair: 1, isPortrait: false, dx: 100, dy: 0, minTravel: MIN }),
    ).toBe('right')
  })

  it('rejects a fling toward the partner photo (portrait)', () => {
    // Top photo swiped down = toward the bottom partner.
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: true, dx: 0, dy: 100, minTravel: MIN }),
    ).toBeNull()
    // Bottom photo swiped up = toward the top partner.
    expect(
      discardFlingDirection({ indexInPair: 1, isPortrait: true, dx: 0, dy: -100, minTravel: MIN }),
    ).toBeNull()
  })

  it('accepts flings away from the partner (portrait)', () => {
    // Top photo: up / left / right are valid.
    expect(
      discardFlingDirection({ indexInPair: 0, isPortrait: true, dx: 0, dy: -100, minTravel: MIN }),
    ).toBe('up')
    expect(
      discardFlingDirection({ indexInPair: 1, isPortrait: true, dx: 0, dy: 100, minTravel: MIN }),
    ).toBe('down')
    expect(
      discardFlingDirection({ indexInPair: 1, isPortrait: true, dx: 100, dy: 0, minTravel: MIN }),
    ).toBe('right')
  })
})

describe('flingOffscreenTranslate', () => {
  it('translates fully off-screen on the swiped axis only', () => {
    expect(flingOffscreenTranslate('left')).toEqual({ tx: '-110vw', ty: '0' })
    expect(flingOffscreenTranslate('right')).toEqual({ tx: '110vw', ty: '0' })
    expect(flingOffscreenTranslate('up')).toEqual({ tx: '0', ty: '-110vh' })
    expect(flingOffscreenTranslate('down')).toEqual({ tx: '0', ty: '110vh' })
  })
})
