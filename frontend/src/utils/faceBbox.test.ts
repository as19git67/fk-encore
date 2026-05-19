import { describe, it, expect } from 'vitest'
import {
  validBbox,
  thumbnailZoom,
  thumbnailImageStyle,
  faceBoxStyle,
  thumbnailSrcWidth,
  autoCropThumbnailStyle,
} from './faceBbox'

describe('validBbox', () => {
  it('returns null for null/undefined', () => {
    expect(validBbox(null)).toBeNull()
    expect(validBbox(undefined)).toBeNull()
  })
  it('returns the bbox unchanged when coords are within range', () => {
    const b = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
    expect(validBbox(b)).toBe(b)
  })
  it('rejects bboxes with out-of-range origin', () => {
    expect(validBbox({ x: 2, y: 0.1, width: 0.2, height: 0.2 })).toBeNull()
    expect(validBbox({ x: 0.1, y: 2, width: 0.2, height: 0.2 })).toBeNull()
  })
})

describe('thumbnailZoom', () => {
  it('returns 1 when bbox is invalid', () => {
    expect(thumbnailZoom(null)).toBe(1)
  })
  it('clamps below 1.5 for very large bboxes', () => {
    expect(thumbnailZoom({ x: 0, y: 0, width: 0.9, height: 0.9 })).toBe(1.5)
  })
  it('clamps above 4 for tiny bboxes', () => {
    expect(thumbnailZoom({ x: 0, y: 0, width: 0.05, height: 0.05 })).toBe(4)
  })
})

describe('thumbnailImageStyle', () => {
  it('returns empty for null bbox', () => {
    expect(thumbnailImageStyle(null)).toEqual({})
  })
  it('centres the face via objectPosition + transform', () => {
    const style = thumbnailImageStyle({ x: 0.2, y: 0.3, width: 0.2, height: 0.2 })
    expect(style.objectPosition).toBe('30.0% 40.0%')
    expect(style.transform).toContain('scale(')
    expect(style.transform).toContain('translate(')
  })
})

describe('faceBoxStyle', () => {
  it('hides the overlay for null bbox', () => {
    expect(faceBoxStyle(null)).toEqual({ display: 'none' })
  })
  it('maps bbox coords to percent positions', () => {
    const s = faceBoxStyle({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    expect(s.left).toBe('10.00%')
    expect(s.top).toBe('20.00%')
    expect(s.width).toBe('30.00%')
    expect(s.height).toBe('40.00%')
  })
})

describe('thumbnailSrcWidth', () => {
  it('requests 800px for high zoom', () => {
    expect(thumbnailSrcWidth({ x: 0, y: 0, width: 0.1, height: 0.1 })).toBe(800)
  })
  it('requests 600px for medium zoom', () => {
    expect(thumbnailSrcWidth({ x: 0, y: 0, width: 0.26, height: 0.26 })).toBe(600)
  })
  it('falls back to 400 when bbox is missing', () => {
    expect(thumbnailSrcWidth(null)).toBe(400)
  })
})

describe('autoCropThumbnailStyle', () => {
  it('returns empty when auto_crop is missing', () => {
    expect(autoCropThumbnailStyle(null)).toEqual({})
    expect(autoCropThumbnailStyle(undefined)).toEqual({})
  })
  it('returns empty for out-of-range or non-finite values', () => {
    expect(autoCropThumbnailStyle({ x: -0.1, y: 0.5 })).toEqual({})
    expect(autoCropThumbnailStyle({ x: 0.5, y: 1.2 })).toEqual({})
    expect(autoCropThumbnailStyle({ x: Number.NaN, y: 0.5 })).toEqual({})
  })
  it('anchors object-position and transform-origin at the auto-crop point', () => {
    const style = autoCropThumbnailStyle({ x: 0.8, y: 0.2 })
    expect(style.objectPosition).toBe('80.0% 20.0%')
    expect(style.transformOrigin).toBe('80.0% 20.0%')
  })
  it('applies a moderate scale', () => {
    const style = autoCropThumbnailStyle({ x: 0.5, y: 0.5 })
    expect(style.transform).toMatch(/^scale\((\d+(?:\.\d+)?)\)$/)
    const match = style.transform!.match(/scale\(([\d.]+)\)/)!
    const z = Number(match[1])
    // Keep the zoom modest enough that the gallery context isn't lost.
    expect(z).toBeGreaterThan(1)
    expect(z).toBeLessThan(1.5)
  })
})
