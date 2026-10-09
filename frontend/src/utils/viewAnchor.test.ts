import { describe, expect, it } from 'vitest'
import { anchorScrollDelta, captureViewAnchor, type Rect } from './viewAnchor'

// Two pages of 600×800 CSS px, 16px apart, the first one starting at y=100.
const pages: Array<readonly [number, Rect]> = [
  [1, { left: 50, top: 100, width: 600, height: 800 }],
  [2, { left: 50, top: 916, width: 600, height: 800 }],
]

describe('captureViewAnchor', () => {
  it('returns null without any page', () => {
    expect(captureViewAnchor([], { clientX: 0, clientY: 0 })).toBeNull()
  })

  it('expresses the focal point as fractions of the page under it', () => {
    const anchor = captureViewAnchor(pages, { clientX: 350, clientY: 700 })
    expect(anchor).toMatchObject({ pageNumber: 1, fx: 0.5, fy: 0.75, clientX: 350, clientY: 700 })
  })

  it('picks the second page once the focal point lies on it', () => {
    const anchor = captureViewAnchor(pages, { clientX: 50, clientY: 1116 })
    expect(anchor).toMatchObject({ pageNumber: 2, fx: 0, fy: 0.25 })
  })

  it('takes the nearer page inside the gap between two pages', () => {
    expect(captureViewAnchor(pages, { clientX: 100, clientY: 905 })?.pageNumber).toBe(1)
    expect(captureViewAnchor(pages, { clientX: 100, clientY: 912 })?.pageNumber).toBe(2)
  })

  it('keeps the distance above the first page as a negative fraction', () => {
    const anchor = captureViewAnchor(pages, { clientX: 100, clientY: 60 })
    expect(anchor?.pageNumber).toBe(1)
    expect(anchor?.fy).toBeCloseTo(-0.05)
  })

  it('falls back to the page middle when a rect has no size yet', () => {
    const anchor = captureViewAnchor([[1, { left: 0, top: 0, width: 0, height: 0 }]], {
      clientX: 10,
      clientY: 10,
    })
    expect(anchor).toMatchObject({ fx: 0.5, fy: 0 })
  })
})

describe('anchorScrollDelta', () => {
  it('is zero when the page has not moved or changed size', () => {
    const anchor = captureViewAnchor(pages, { clientX: 350, clientY: 700 })!
    expect(anchorScrollDelta(anchor, pages[0]![1])).toEqual({ dx: 0, dy: 0 })
  })

  it('scrolls so the same spot of a doubled page returns under the pointer', () => {
    const anchor = captureViewAnchor(pages, { clientX: 350, clientY: 700 })!
    // After zooming to 200 % the page starts at the same corner but is twice
    // as large: the spot at (0.5, 0.75) now sits at (650, 1300) on screen.
    const delta = anchorScrollDelta(anchor, { left: 50, top: 100, width: 1200, height: 1600 })
    expect(delta).toEqual({ dx: 300, dy: 600 })
  })

  it('scrolls back up when the page shrinks', () => {
    const anchor = captureViewAnchor(pages, { clientX: 350, clientY: 700 })!
    const delta = anchorScrollDelta(anchor, { left: 50, top: 100, width: 300, height: 400 })
    expect(delta).toEqual({ dx: -150, dy: -300 })
  })
})
