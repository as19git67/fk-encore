// Tests for the cropper drag math. Pure logic — no DOM. Covers the
// branches: pan, single-edge resize with no aspect, single-edge resize
// with aspect lock, corner resize, clamping at the image edges.

import { describe, it, expect } from 'vitest'
import { computeNextCrop } from './photoCropDrag'

const CENTER = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }

describe('computeNextCrop — pan', () => {
  it('shifts x and y by the delta', () => {
    const r = computeNextCrop('body', CENTER, 0.1, 0.05, null)!
    expect(r.x).toBeCloseTo(0.4, 5)
    expect(r.y).toBeCloseTo(0.35, 5)
    expect(r.w).toBeCloseTo(0.4, 5)
    expect(r.h).toBeCloseTo(0.4, 5)
  })
  it('clamps pan against the left edge', () => {
    const r = computeNextCrop('body', CENTER, -10, 0, null)!
    expect(r.x).toBe(0)
    expect(r.y).toBeCloseTo(0.3, 5)
  })
  it('clamps pan against the right edge', () => {
    const r = computeNextCrop('body', CENTER, 10, 0, null)!
    expect(r.x).toBeCloseTo(0.6, 5) // 1 - 0.4
  })
})

describe('computeNextCrop — single-edge resize, free aspect', () => {
  it('east handle widens the crop, x unchanged', () => {
    const r = computeNextCrop('e', CENTER, 0.1, 0, null)!
    expect(r.x).toBeCloseTo(0.3, 5)
    expect(r.w).toBeCloseTo(0.5, 5)
    expect(r.h).toBeCloseTo(0.4, 5)
  })
  it('west handle narrows from the left, x moves with it', () => {
    const r = computeNextCrop('w', CENTER, 0.1, 0, null)!
    expect(r.x).toBeCloseTo(0.4, 5)
    expect(r.w).toBeCloseTo(0.3, 5)
  })
  it('north handle moves the top edge down', () => {
    const r = computeNextCrop('n', CENTER, 0, 0.1, null)!
    expect(r.y).toBeCloseTo(0.4, 5)
    expect(r.h).toBeCloseTo(0.3, 5)
  })
  it('enforces a minimum 5% size on the moved edge', () => {
    const r = computeNextCrop('e', CENTER, -10, 0, null)!
    expect(r.w).toBeGreaterThanOrEqual(0.05 - 1e-6)
  })
})

describe('computeNextCrop — aspect-ratio lock', () => {
  it('east-handle drag preserves the requested ratio', () => {
    const r = computeNextCrop('e', CENTER, 0.1, 0, 1.0)!
    // Lock to 1:1: w/h must equal 1.
    expect(r.w / r.h).toBeCloseTo(1, 3)
  })

  it('corner-handle shrinking preserves the requested non-1 ratio', () => {
    // Caller's contract: aspectRatio is the normalised w/h, not the
    // pixel w/h. Earlier the editor was passing the pixel ratio for a
    // non-square image and the corner branch silently produced the
    // wrong shape. Pin the behaviour here.
    const start = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
    // Try various inward drags from NW.
    for (const [dx, dy] of [
      [0.05, 0.05],
      [0.1, 0.02],
      [0.02, 0.1],
      [0.15, 0.15],
    ] as const) {
      const r = computeNextCrop('nw', start, dx, dy, 0.75)!
      expect(r.w / r.h).toBeCloseTo(0.75, 3)
    }
  })

  it('north-handle drag preserves the ratio and recentres horizontally', () => {
    const r = computeNextCrop('n', CENTER, 0, 0.1, 1.0)!
    expect(r.w / r.h).toBeCloseTo(1, 3)
    // Centroid x unchanged (cx = 0.5 → after drag still ~0.5).
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 3)
  })

  it('returns null when the constraint cannot be satisfied within [0,1]', () => {
    // Crop already filling most of the image, requested ratio impossible.
    const start = { x: 0, y: 0.05, w: 1, h: 0.9 }
    // Drag e-handle further right → would need height > 1.
    const r = computeNextCrop('e', start, 1, 0, 100)
    expect(r).toBeNull()
  })

  it('corner-handle drag locks both dims to the dominant axis', () => {
    const r = computeNextCrop('se', CENTER, 0.05, 0.1, 1.0)!
    expect(r.w / r.h).toBeCloseTo(1, 3)
  })
})

describe('computeNextCrop — clamping at the image edges', () => {
  it('clamps a rightward east-handle drag at x=1', () => {
    const r = computeNextCrop('e', CENTER, 10, 0, null)!
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-6)
  })
  it('clamps a topward north-handle drag at y=0', () => {
    const r = computeNextCrop('n', CENTER, 0, -10, null)!
    expect(r.y).toBe(0)
  })
})
