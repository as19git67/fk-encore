import { describe, it, expect } from 'vitest'
import {
  shouldArmSlideshow,
  slideshowReachedEnd,
  isDayChange,
  shouldShowCaption,
  type SlideshowState,
} from './slideshow'

function state(overrides: Partial<SlideshowState> = {}): SlideshowState {
  return {
    playing: true,
    autoAdvanceMs: 10000,
    hasNext: true,
    currentLoaded: true,
    ...overrides,
  }
}

describe('shouldArmSlideshow', () => {
  it('arms when playing, configured, has next and loaded', () => {
    expect(shouldArmSlideshow(state())).toBe(true)
  })

  it('does not arm when not playing (default: no auto-start)', () => {
    expect(shouldArmSlideshow(state({ playing: false }))).toBe(false)
  })

  it('does not arm without a configured interval', () => {
    expect(shouldArmSlideshow(state({ autoAdvanceMs: 0 }))).toBe(false)
  })

  it('does not arm at the last photo', () => {
    expect(shouldArmSlideshow(state({ hasNext: false }))).toBe(false)
  })

  it('waits until the current photo has loaded', () => {
    expect(shouldArmSlideshow(state({ currentLoaded: false }))).toBe(false)
  })
})

describe('slideshowReachedEnd', () => {
  it('is true when playing with no next photo', () => {
    expect(slideshowReachedEnd({ playing: true, hasNext: false })).toBe(true)
  })

  it('is false while more photos remain', () => {
    expect(slideshowReachedEnd({ playing: true, hasNext: true })).toBe(false)
  })

  it('is false when not playing', () => {
    expect(slideshowReachedEnd({ playing: false, hasNext: false })).toBe(false)
  })
})

describe('isDayChange', () => {
  it('never fires for the photo the overlay opened on (no previous day)', () => {
    expect(isDayChange(null, '2026-01-14')).toBe(false)
  })

  it('fires when the day key changes', () => {
    expect(isDayChange('2026-01-14', '2026-01-15')).toBe(true)
  })

  it('does not fire within the same day', () => {
    expect(isDayChange('2026-01-14', '2026-01-14')).toBe(false)
  })
})

describe('shouldShowCaption', () => {
  it('shows while playing with a description and no split-view', () => {
    expect(shouldShowCaption(true, false, 'Sonnenuntergang am Strand')).toBe(true)
  })

  it('hides when the slideshow is not running', () => {
    expect(shouldShowCaption(false, false, 'Sonnenuntergang')).toBe(false)
  })

  it('hides while the details split-view is open', () => {
    expect(shouldShowCaption(true, true, 'Sonnenuntergang')).toBe(false)
  })

  it('hides when there is no description', () => {
    expect(shouldShowCaption(true, false, null)).toBe(false)
    expect(shouldShowCaption(true, false, undefined)).toBe(false)
  })

  it('treats a whitespace-only description as empty', () => {
    expect(shouldShowCaption(true, false, '   ')).toBe(false)
  })
})
