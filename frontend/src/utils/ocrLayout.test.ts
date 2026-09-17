import { describe, it, expect } from 'vitest'
import {
  polygonAngle,
  lineLayout,
  fitScaleX,
  mapPointIntoCrop,
  mapBlockIntoCrop,
  isVisibleLayout,
} from './ocrLayout'
import type { PhotoOcrBlock } from '../api/photos'

function block(overrides: Partial<PhotoOcrBlock> = {}): PhotoOcrBlock {
  return {
    text: 'Hauptbahnhof',
    confidence: 0.9,
    polygon: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.3 }, { x: 0.1, y: 0.3 }],
    left: 0.1, top: 0.2, right: 0.5, bottom: 0.3,
    ...overrides,
  }
}

describe('polygonAngle', () => {
  it('is zero for a level line', () => {
    expect(polygonAngle(block().polygon)).toBe(0)
  })

  it('follows a tilted top edge', () => {
    // Top edge rises to the right by as much as it runs: 45° upwards on screen.
    const angle = polygonAngle([{ x: 0, y: 0.5 }, { x: 0.5, y: 0 }])
    expect(angle).toBeCloseTo(-Math.PI / 4, 6)
  })

  it('treats a degenerate polygon as level', () => {
    expect(polygonAngle([])).toBe(0)
    expect(polygonAngle([{ x: 0.2, y: 0.2 }])).toBe(0)
    expect(polygonAngle([{ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 }])).toBe(0)
  })
})

describe('lineLayout', () => {
  it('lays a level line into its box', () => {
    const l = lineLayout(block())
    expect(l.x).toBe(0.1)
    expect(l.y).toBe(0.2)
    expect(l.width).toBeCloseTo(0.4)
    expect(l.height).toBeCloseTo(0.1)
    expect(l.angle).toBe(0)
  })

  it('anchors a tilted line at its first corner with the quad\'s own size', () => {
    const tilted = block({
      polygon: [{ x: 0.1, y: 0.4 }, { x: 0.4, y: 0.1 }, { x: 0.45, y: 0.15 }, { x: 0.15, y: 0.45 }],
    })
    const l = lineLayout(tilted)
    expect(l.x).toBe(0.1)
    expect(l.y).toBe(0.4)
    expect(l.width).toBeCloseTo(Math.hypot(0.3, 0.3), 6)
    expect(l.height).toBeCloseTo(Math.hypot(0.05, 0.05), 6)
    expect(l.angle).toBeCloseTo(-Math.PI / 4, 6)
  })

  it('falls back to the bounding box without a usable quad', () => {
    const l = lineLayout(block({ polygon: [] }))
    expect(l.x).toBe(0.1)
    expect(l.y).toBe(0.2)
    expect(l.width).toBeCloseTo(0.4)
    expect(l.height).toBeCloseTo(0.1)
    expect(l.angle).toBe(0)
  })

  it('falls back when the quad has no area', () => {
    const flat = block({ polygon: [{ x: 0.1, y: 0.2 }, { x: 0.1, y: 0.2 }, { x: 0.1, y: 0.2 }, { x: 0.1, y: 0.2 }] })
    expect(lineLayout(flat).angle).toBe(0)
    expect(lineLayout(flat).width).toBeCloseTo(0.4)
  })
})

describe('fitScaleX', () => {
  it('stretches measured text to the box width', () => {
    expect(fitScaleX(50, 100)).toBe(2)
    expect(fitScaleX(200, 100)).toBe(0.5)
  })

  it('leaves text alone when nothing sensible was measured', () => {
    expect(fitScaleX(0, 100)).toBe(1)
    expect(fitScaleX(Number.NaN, 100)).toBe(1)
    expect(fitScaleX(50, 0)).toBe(1)
  })

  it('clamps an absurd ratio', () => {
    expect(fitScaleX(1, 1000)).toBe(8)
    expect(fitScaleX(1000, 1)).toBe(0.125)
  })
})

describe('crop mapping', () => {
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }

  it('re-bases a point onto the crop', () => {
    expect(mapPointIntoCrop({ x: 0.25, y: 0.25 }, crop)).toEqual({ x: 0, y: 0 })
    expect(mapPointIntoCrop({ x: 0.5, y: 0.5 }, crop)).toEqual({ x: 0.5, y: 0.5 })
    expect(mapPointIntoCrop({ x: 0.75, y: 0.75 }, crop)).toEqual({ x: 1, y: 1 })
  })

  it('puts a point the crop cut off outside 0..1', () => {
    expect(mapPointIntoCrop({ x: 0.1, y: 0.1 }, crop).x).toBeLessThan(0)
    expect(mapPointIntoCrop({ x: 0.9, y: 0.9 }, crop).y).toBeGreaterThan(1)
  })

  it('leaves the point alone for a degenerate crop', () => {
    expect(mapPointIntoCrop({ x: 0.3, y: 0.3 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 0.3, y: 0.3 })
  })

  it('maps a whole block, corners and box alike', () => {
    const b = block({
      polygon: [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.35 }, { x: 0.3, y: 0.35 }],
      left: 0.3, top: 0.3, right: 0.5, bottom: 0.35,
    })
    const m = mapBlockIntoCrop(b, crop)
    expect(m.polygon[0].x).toBeCloseTo(0.1)
    expect(m.polygon[0].y).toBeCloseTo(0.1)
    expect(m.polygon[1].x).toBeCloseTo(0.5)
    expect(m.polygon[1].y).toBeCloseTo(0.1)
    expect(m.left).toBeCloseTo(0.1)
    expect(m.right).toBeCloseTo(0.5)
    expect(m.bottom).toBeCloseTo(0.2)
    expect(m.text).toBe(b.text)
  })

  it('keeps the tilt of a line after cropping', () => {
    const tilted = block({
      polygon: [{ x: 0.3, y: 0.6 }, { x: 0.6, y: 0.3 }, { x: 0.65, y: 0.35 }, { x: 0.35, y: 0.65 }],
    })
    expect(lineLayout(mapBlockIntoCrop(tilted, crop)).angle).toBeCloseTo(-Math.PI / 4, 6)
  })
})

describe('isVisibleLayout', () => {
  it('keeps a line inside the view', () => {
    expect(isVisibleLayout({ x: 0.1, y: 0.1, width: 0.2, height: 0.05, angle: 0 })).toBe(true)
  })

  it('keeps a line that straddles the edge', () => {
    expect(isVisibleLayout({ x: -0.1, y: 0.1, width: 0.2, height: 0.05, angle: 0 })).toBe(true)
    expect(isVisibleLayout({ x: 0.95, y: 0.1, width: 0.2, height: 0.05, angle: 0 })).toBe(true)
  })

  it('drops a line the crop cut off entirely', () => {
    expect(isVisibleLayout({ x: -0.5, y: 0.1, width: 0.2, height: 0.05, angle: 0 })).toBe(false)
    expect(isVisibleLayout({ x: 1.2, y: 0.1, width: 0.2, height: 0.05, angle: 0 })).toBe(false)
    expect(isVisibleLayout({ x: 0.1, y: 1.5, width: 0.2, height: 0.05, angle: 0 })).toBe(false)
  })
})
