import { describe, it, expect } from 'vitest'
import {
  classifySharpness,
  normalizeSharpness,
  faceCropRect,
  grayscaleFromRgba,
  laplacianVariance,
  sharpnessFromRgba,
  sharpnessLabel,
  peakDescription,
  FACE_SAMPLE_SIZE,
  LAPLACIAN_FULL_SCALE,
  SHARP_MIN,
  MEDIUM_MIN,
} from './focusPeaking'

/** Pack a grayscale plane into RGBA the way canvas getImageData returns it. */
function toRgba(gray: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length * 4)
  gray.forEach((v, i) => {
    out[i * 4] = v
    out[i * 4 + 1] = v
    out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  })
  return out
}

/** Hard-edged checkerboard — the sharpest possible pattern at this scale. */
function checkerboard(size: number, cell = 1): number[] {
  const out: number[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.push((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255)
    }
  }
  return out
}

/** Smooth gradient — no high-frequency detail, i.e. an out-of-focus region. */
function gradient(size: number): number[] {
  const out: number[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.push(Math.round(((x + y) / (2 * (size - 1))) * 255))
    }
  }
  return out
}

describe('classifySharpness', () => {
  it('maps scores onto the traffic-light levels', () => {
    expect(classifySharpness(0.9)).toBe('sharp')
    expect(classifySharpness(SHARP_MIN)).toBe('sharp')
    expect(classifySharpness(SHARP_MIN - 0.01)).toBe('medium')
    expect(classifySharpness(MEDIUM_MIN)).toBe('medium')
    expect(classifySharpness(MEDIUM_MIN - 0.01)).toBe('unsharp')
    expect(classifySharpness(0)).toBe('unsharp')
  })

  it('treats non-finite scores as unsharp', () => {
    expect(classifySharpness(Number.NaN)).toBe('unsharp')
    expect(classifySharpness(Number.POSITIVE_INFINITY)).toBe('unsharp')
  })
})

describe('normalizeSharpness', () => {
  it('scales variance against the full-scale value and clamps at 1', () => {
    expect(normalizeSharpness(0)).toBe(0)
    expect(normalizeSharpness(-5)).toBe(0)
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE / 2)).toBeCloseTo(0.5, 6)
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE)).toBe(1)
    expect(normalizeSharpness(LAPLACIAN_FULL_SCALE * 10)).toBe(1)
    expect(normalizeSharpness(Number.NaN)).toBe(0)
  })
})

describe('faceCropRect', () => {
  it('converts a normalised bbox into a pixel rect', () => {
    const rect = faceCropRect({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 }, 400, 200)
    expect(rect).toEqual({ x: 100, y: 100, width: 100, height: 50 })
  })

  it('clamps a bbox that runs past the image edge', () => {
    const rect = faceCropRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, 100, 100)
    expect(rect).toEqual({ x: 80, y: 80, width: 20, height: 20 })
  })

  it('rejects bboxes in a foreign coordinate space', () => {
    expect(faceCropRect({ x: 120, y: 80, width: 40, height: 40 }, 400, 400)).toBeNull()
  })

  it('rejects degenerate, empty and non-finite bboxes', () => {
    expect(faceCropRect(null, 400, 400)).toBeNull()
    expect(faceCropRect({ x: 0.1, y: 0.1, width: 0, height: 0.2 }, 400, 400)).toBeNull()
    expect(
      faceCropRect({ x: Number.NaN, y: 0.1, width: 0.2, height: 0.2 }, 400, 400),
    ).toBeNull()
  })

  it('rejects crops below the minimum measurable size', () => {
    // 0.02 × 400 = 8 px — below MIN_FACE_PIXELS (10).
    expect(faceCropRect({ x: 0.1, y: 0.1, width: 0.02, height: 0.02 }, 400, 400)).toBeNull()
    expect(faceCropRect({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, 0, 0)).toBeNull()
  })
})

describe('grayscaleFromRgba', () => {
  it('applies Rec. 601 luma weights', () => {
    const gray = grayscaleFromRgba(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]))
    expect(gray).toHaveLength(2)
    expect(gray[0]).toBeCloseTo(0.299 * 255, 6)
    expect(gray[1]).toBeCloseTo(0.587 * 255, 6)
  })
})

describe('laplacianVariance', () => {
  it('is zero for a flat region', () => {
    const flat = new Array(64).fill(128)
    expect(laplacianVariance(flat, 8, 8)).toBeCloseTo(0, 6)
  })

  it('is far higher for a hard-edged pattern than for a smooth gradient', () => {
    const sharp = laplacianVariance(checkerboard(32), 32, 32)
    const blurry = laplacianVariance(gradient(32), 32, 32)
    expect(sharp).toBeGreaterThan(blurry * 100)
  })

  it('returns 0 when the plane is smaller than the declared size', () => {
    expect(laplacianVariance([1, 2, 3], 8, 8)).toBe(0)
    expect(laplacianVariance([], 0, 0)).toBe(0)
  })
})

describe('sharpnessFromRgba', () => {
  it('scores a detailed crop sharp and a smooth crop unsharp', () => {
    const size = FACE_SAMPLE_SIZE
    const sharp = sharpnessFromRgba(toRgba(checkerboard(size)), size, size)
    const blurry = sharpnessFromRgba(toRgba(gradient(size)), size, size)
    expect(classifySharpness(sharp)).toBe('sharp')
    expect(classifySharpness(blurry)).toBe('unsharp')
  })

  it('lands in the middle band for a coarse, low-contrast pattern', () => {
    // Wide cells at reduced contrast: some edge energy, but far less than a
    // per-pixel checkerboard — the "not quite in focus" case.
    const size = FACE_SAMPLE_SIZE
    const coarse = checkerboard(size, 16).map((v) => 118 + Math.round((v / 255) * 20))
    const score = sharpnessFromRgba(toRgba(coarse), size, size)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(SHARP_MIN)
  })
})

describe('labels', () => {
  it('renders a rounded percentage', () => {
    expect(sharpnessLabel(0.723)).toBe('72 %')
    expect(sharpnessLabel(1.5)).toBe('100 %')
    expect(sharpnessLabel(-1)).toBe('0 %')
  })

  it('describes the level in German for screen readers', () => {
    expect(peakDescription(0.8)).toBe('Gesicht scharf – 80 %')
    expect(peakDescription(0.3)).toBe('Gesicht mittelscharf – 30 %')
    expect(peakDescription(0.05)).toBe('Gesicht unscharf – 5 %')
  })
})
