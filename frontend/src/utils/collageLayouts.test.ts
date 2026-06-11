import { describe, it, expect } from 'vitest'
import {
  canCollage,
  collageLayouts,
  coverCropRect,
  collageObjectPosition,
  swapOrder,
  MIN_COLLAGE_PHOTOS,
  MAX_COLLAGE_PHOTOS,
} from './collageLayouts'

describe('canCollage', () => {
  it('accepts 2..9 photos and rejects the rest', () => {
    expect(canCollage(1)).toBe(false)
    expect(canCollage(2)).toBe(true)
    expect(canCollage(9)).toBe(true)
    expect(canCollage(10)).toBe(false)
    expect(canCollage(0)).toBe(false)
  })

  it('matches the exported bounds', () => {
    expect(MIN_COLLAGE_PHOTOS).toBe(2)
    expect(MAX_COLLAGE_PHOTOS).toBe(9)
  })
})

describe('collageLayouts', () => {
  it('returns three variants for every supported count', () => {
    for (let n = MIN_COLLAGE_PHOTOS; n <= MAX_COLLAGE_PHOTOS; n++) {
      const layouts = collageLayouts(n)
      expect(layouts, `count ${n}`).toHaveLength(3)
    }
  })

  it('returns no layouts outside the supported range', () => {
    expect(collageLayouts(1)).toEqual([])
    expect(collageLayouts(10)).toEqual([])
  })

  it('gives every layout exactly `count` cells', () => {
    for (let n = MIN_COLLAGE_PHOTOS; n <= MAX_COLLAGE_PHOTOS; n++) {
      for (const layout of collageLayouts(n)) {
        expect(layout.cells, `${n}/${layout.id}`).toHaveLength(n)
      }
    }
  })

  it('uses unique variant ids per count', () => {
    for (let n = MIN_COLLAGE_PHOTOS; n <= MAX_COLLAGE_PHOTOS; n++) {
      const ids = collageLayouts(n).map((l) => l.id)
      expect(new Set(ids).size, `count ${n}`).toBe(ids.length)
    }
  })

  it('keeps all cells inside the unit square with positive size', () => {
    for (let n = MIN_COLLAGE_PHOTOS; n <= MAX_COLLAGE_PHOTOS; n++) {
      for (const layout of collageLayouts(n)) {
        expect(layout.aspect).toBeGreaterThan(0)
        for (const c of layout.cells) {
          expect(c.w).toBeGreaterThan(0)
          expect(c.h).toBeGreaterThan(0)
          expect(c.x).toBeGreaterThanOrEqual(-1e-9)
          expect(c.y).toBeGreaterThanOrEqual(-1e-9)
          expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9)
          expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9)
        }
      }
    }
  })

  it('tiles the canvas exactly (cell areas sum to 1)', () => {
    for (let n = MIN_COLLAGE_PHOTOS; n <= MAX_COLLAGE_PHOTOS; n++) {
      for (const layout of collageLayouts(n)) {
        const area = layout.cells.reduce((s, c) => s + c.w * c.h, 0)
        expect(area, `${n}/${layout.id}`).toBeCloseTo(1, 6)
      }
    }
  })
})

describe('coverCropRect', () => {
  it('crops the sides of a landscape image into a square cell', () => {
    // 200×100 image into a 1:1 cell → full height, half the width.
    const r = coverCropRect(200, 100, 1)
    expect(r.sh).toBeCloseTo(100)
    expect(r.sw).toBeCloseTo(100)
    // Centred horizontally by default.
    expect(r.sx).toBeCloseTo(50)
    expect(r.sy).toBeCloseTo(0)
  })

  it('crops the top/bottom of a portrait image into a square cell', () => {
    const r = coverCropRect(100, 200, 1)
    expect(r.sw).toBeCloseTo(100)
    expect(r.sh).toBeCloseTo(100)
    expect(r.sx).toBeCloseTo(0)
    expect(r.sy).toBeCloseTo(50)
  })

  it('honours the focal point via object-position semantics', () => {
    // Landscape into square, focal at the left edge → window pinned left.
    const left = coverCropRect(200, 100, 1, { x: 0, y: 0.5 })
    expect(left.sx).toBeCloseTo(0)
    // Focal at the right edge → window pinned right.
    const right = coverCropRect(200, 100, 1, { x: 1, y: 0.5 })
    expect(right.sx).toBeCloseTo(100)
  })

  it('clamps out-of-range / non-finite focal points to the centre', () => {
    const r = coverCropRect(200, 100, 1, { x: NaN, y: 5 })
    expect(r.sx).toBeCloseTo(50) // NaN → 0.5
    expect(r.sy).toBeCloseTo(0) // 5 clamped to 1, but sh==natH so no room
  })

  it('zoom shrinks the visible window', () => {
    const plain = coverCropRect(100, 100, 1, { x: 0.5, y: 0.5 }, 1)
    const zoomed = coverCropRect(100, 100, 1, { x: 0.5, y: 0.5 }, 2)
    expect(zoomed.sw).toBeCloseTo(plain.sw / 2)
    expect(zoomed.sh).toBeCloseTo(plain.sh / 2)
  })

  it('degrades gracefully on invalid input', () => {
    const r = coverCropRect(0, 0, 1)
    expect(r).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
  })
})

describe('collageObjectPosition', () => {
  it('formats the focal point as percentages', () => {
    expect(collageObjectPosition({ x: 0.25, y: 0.75 })).toBe('25.0% 75.0%')
  })

  it('defaults to centre when absent or invalid', () => {
    expect(collageObjectPosition()).toBe('50.0% 50.0%')
    expect(collageObjectPosition(null)).toBe('50.0% 50.0%')
    expect(collageObjectPosition({ x: 2, y: -1 })).toBe('100.0% 0.0%')
  })
})

describe('swapOrder', () => {
  it('swaps two indices into a new array', () => {
    const out = swapOrder([0, 1, 2, 3], 0, 3)
    expect(out).toEqual([3, 1, 2, 0])
  })

  it('does not mutate the input', () => {
    const input = [0, 1, 2]
    swapOrder(input, 0, 2)
    expect(input).toEqual([0, 1, 2])
  })

  it('is a no-op for equal or out-of-bounds indices', () => {
    expect(swapOrder([0, 1, 2], 1, 1)).toEqual([0, 1, 2])
    expect(swapOrder([0, 1, 2], -1, 1)).toEqual([0, 1, 2])
    expect(swapOrder([0, 1, 2], 0, 9)).toEqual([0, 1, 2])
  })
})
