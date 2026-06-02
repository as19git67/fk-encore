import { describe, it, expect } from 'vitest'
import { containFit, cropToWrapper } from './cropperFit'

describe('containFit', () => {
  it('is the identity when the wrapper matches the image aspect', () => {
    const fit = containFit(1600, 900, 16 / 9)
    expect(fit.ox).toBeCloseTo(0, 6)
    expect(fit.oy).toBeCloseTo(0, 6)
    expect(fit.ow).toBeCloseTo(1, 6)
    expect(fit.oh).toBeCloseTo(1, 6)
  })

  it('pillarboxes a portrait image in a wider wrapper (the bug case)', () => {
    // 9:16 image inside a square wrapper → image keeps full height, narrower
    // than the wrapper, centred horizontally.
    const fit = containFit(1000, 1000, 9 / 16)
    expect(fit.oh).toBeCloseTo(1, 6)
    expect(fit.ow).toBeCloseTo(9 / 16, 6)
    expect(fit.ox).toBeCloseTo((1 - 9 / 16) / 2, 6)
    expect(fit.oy).toBeCloseTo(0, 6)
  })

  it('letterboxes a landscape image in a taller wrapper', () => {
    // 16:9 image inside a square wrapper → full width, shorter, centred.
    const fit = containFit(1000, 1000, 16 / 9)
    expect(fit.ow).toBeCloseTo(1, 6)
    expect(fit.oh).toBeCloseTo(9 / 16, 6)
    expect(fit.oy).toBeCloseTo((1 - 9 / 16) / 2, 6)
    expect(fit.ox).toBeCloseTo(0, 6)
  })

  it('falls back to identity for unmeasured / invalid inputs', () => {
    expect(containFit(0, 0, 1.5)).toEqual({ ox: 0, oy: 0, ow: 1, oh: 1 })
    expect(containFit(100, 100, 0)).toEqual({ ox: 0, oy: 0, ow: 1, oh: 1 })
  })
})

describe('cropToWrapper', () => {
  it('keeps a full-width portrait crop inside the rendered image edges', () => {
    // Portrait image pillarboxed in a square wrapper. A 16:9 crop is full
    // image width (w=1) — it must map to the image rect, not the wrapper.
    const fit = containFit(1000, 1000, 9 / 16)
    const r = cropToWrapper({ x: 0, y: 0.34, w: 1, h: 0.32 }, fit)
    // Left edge sits at the image's left edge (the pillarbox offset), and the
    // crop width equals the image width — never the full wrapper width.
    expect(r.left).toBeCloseTo(fit.ox, 6)
    expect(r.width).toBeCloseTo(fit.ow, 6)
    expect(r.left + r.width).toBeLessThanOrEqual(1 + 1e-9)
    expect(r.left).toBeGreaterThan(0) // strictly inside — not spilling into the bar
  })

  it('is a pass-through when the fit is the identity', () => {
    const fit = containFit(1600, 900, 16 / 9)
    const r = cropToWrapper({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, fit)
    expect(r).toEqual({ left: 0.1, top: 0.2, width: 0.5, height: 0.6 })
  })
})
