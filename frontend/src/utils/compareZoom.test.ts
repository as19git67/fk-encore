import { describe, it, expect } from 'vitest'
import {
  containedRect,
  computeBboxZoom,
  computeSyncBboxZoom,
  pickPrimaryBbox,
  findFaceForPerson,
} from './compareZoom'

const VP_SQUARE_SQUARE = { width: 400, height: 400, photoWidth: 1000, photoHeight: 1000 }
const VP_SQUARE_LANDSCAPE = { width: 400, height: 400, photoWidth: 1600, photoHeight: 1000 }
const VP_SQUARE_PORTRAIT = { width: 400, height: 400, photoWidth: 1000, photoHeight: 1600 }
const VP_LANDSCAPE_LANDSCAPE = { width: 800, height: 400, photoWidth: 1600, photoHeight: 1000 }

describe('containedRect', () => {
  it('fills both axes when aspect ratios match', () => {
    const r = containedRect(VP_SQUARE_SQUARE)
    expect(r.w).toBe(400)
    expect(r.h).toBe(400)
    expect(r.offsetX).toBe(0)
    expect(r.offsetY).toBe(0)
  })
  it('letterboxes vertically for a landscape photo in a square viewport', () => {
    const r = containedRect(VP_SQUARE_LANDSCAPE)
    expect(r.w).toBe(400)
    expect(r.h).toBe(250)
    expect(r.offsetX).toBe(0)
    expect(r.offsetY).toBe(75)
  })
  it('pillarboxes horizontally for a portrait photo in a square viewport', () => {
    const r = containedRect(VP_SQUARE_PORTRAIT)
    expect(r.w).toBe(250)
    expect(r.h).toBe(400)
    expect(r.offsetX).toBe(75)
    expect(r.offsetY).toBe(0)
  })
})

describe('computeBboxZoom — basics', () => {
  it('returns null for invalid bbox', () => {
    expect(computeBboxZoom({ x: 0, y: 0, width: 0, height: 0.5 }, VP_SQUARE_SQUARE)).toBeNull()
    expect(computeBboxZoom({ x: -1, y: 0, width: 0.5, height: 0.5 }, VP_SQUARE_SQUARE)).toBeNull()
  })
  it('returns null for invalid viewport', () => {
    const bad = { width: 0, height: 400, photoWidth: 1000, photoHeight: 1000 }
    expect(computeBboxZoom({ x: 0, y: 0, width: 0.5, height: 0.5 }, bad)).toBeNull()
  })
  it('centres a centred bbox without translation', () => {
    const z = computeBboxZoom(
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      VP_SQUARE_SQUARE,
    )!
    expect(z.transformOrigin).toBe('50.00% 50.00%')
    // tx, ty should be ~0 — the face is already centred.
    expect(z.transform).toMatch(/translate\(0\.0px, 0\.0px\)/)
  })
  it('clamps zoom to maxZoom', () => {
    const z = computeBboxZoom(
      { x: 0.49, y: 0.49, width: 0.02, height: 0.02 },
      VP_SQUARE_SQUARE,
      { maxZoom: 4 },
    )!
    expect(z.zoom).toBe(4)
  })
  it('clamps zoom to minZoom', () => {
    const z = computeBboxZoom(
      { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
      VP_SQUARE_SQUARE,
      { minZoom: 1 },
    )!
    expect(z.zoom).toBe(1)
  })
  it('uses explicit zoom when supplied', () => {
    const z = computeBboxZoom(
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      VP_SQUARE_SQUARE,
      { zoom: 2.5 },
    )!
    expect(z.zoom).toBe(2.5)
  })
})

describe('computeBboxZoom — letterboxing', () => {
  it('accounts for vertical letterbox in a landscape photo', () => {
    // Face at image (0.5, 0.5). With 75px top/bottom letterbox, faceCyPx = 200.
    const z = computeBboxZoom(
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      VP_SQUARE_LANDSCAPE,
    )!
    // Centre of viewport is at 200,200 → no translate needed.
    expect(z.transform).toMatch(/translate\(0\.0px, 0\.0px\)/)
    expect(z.transformOrigin).toBe('50.00% 50.00%')
  })
  it('correctly maps a bbox near the image top into IMG-element coords', () => {
    // Photo aspect 16:10 in a 400×400 viewport → 400×250 with 75px letterbox.
    // bbox starts at image y=0 and is 0.2 tall, so its centre is at image
    // y=0.1 → viewport y = 75 + 0.1*250 = 100 = 25% of 400.
    const z = computeBboxZoom(
      { x: 0.4, y: 0.0, width: 0.2, height: 0.2 },
      VP_SQUARE_LANDSCAPE,
    )!
    expect(z.transformOrigin).toBe('50.00% 25.00%')
  })
})

describe('computeBboxZoom — translation math', () => {
  it('moves an off-centre face to the viewport centre at the requested zoom', () => {
    const bbox = { x: 0.7, y: 0.7, width: 0.1, height: 0.1 }
    const z = computeBboxZoom(bbox, VP_SQUARE_SQUARE, { zoom: 2 })!
    // The math: face centre at (0.75, 0.75) of viewport, viewport centre at (0.5, 0.5)
    // → tx = (0.5 - 0.75) * 400 / 2 = -50px
    expect(z.transform).toContain('translate(-50.0px, -50.0px)')
  })
})

describe('computeSyncBboxZoom', () => {
  it('returns null pair when one input is invalid', () => {
    const bad = { bbox: { x: 0, y: 0, width: 0, height: 0 }, viewport: VP_SQUARE_SQUARE }
    const ok = {
      bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      viewport: VP_SQUARE_SQUARE,
    }
    const { a, b } = computeSyncBboxZoom(bad, ok)
    expect(a).toBeNull()
    expect(b).not.toBeNull()
  })
  it('equalises face screen size across two photos with different bbox sizes', () => {
    const a = {
      bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      viewport: VP_SQUARE_SQUARE,
    }
    const b = {
      bbox: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      viewport: VP_SQUARE_SQUARE,
    }
    const { a: zA, b: zB } = computeSyncBboxZoom(a, b)
    expect(zA).not.toBeNull()
    expect(zB).not.toBeNull()
    // Face screen widths should match to within rounding.
    expect(Math.abs(zA!.faceScreen.width - zB!.faceScreen.width)).toBeLessThan(0.5)
  })
  it('handles two photos with different aspect ratios', () => {
    const a = {
      bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      viewport: VP_SQUARE_LANDSCAPE,
    }
    const b = {
      bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      viewport: VP_SQUARE_PORTRAIT,
    }
    const { a: zA, b: zB } = computeSyncBboxZoom(a, b)
    expect(zA).not.toBeNull()
    expect(zB).not.toBeNull()
    expect(Math.abs(zA!.faceScreen.width - zB!.faceScreen.width)).toBeLessThan(0.5)
  })
})

describe('pickPrimaryBbox', () => {
  it('returns null when no faces and no landmarks', () => {
    expect(pickPrimaryBbox([], [])).toBeNull()
  })
  it('prefers faces over landmarks', () => {
    const r = pickPrimaryBbox(
      [{ bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 } }],
      [{ bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }, confidence: 0.99 }],
    )!
    expect(r.source).toBe('face')
  })
  it('prefers faces with person_id over unassigned faces', () => {
    const r = pickPrimaryBbox(
      [
        { bbox: { x: 0.3, y: 0.3, width: 0.5, height: 0.5 }, quality: 0.5 },
        { bbox: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, person_id: 7, quality: 0.1 },
      ],
      [],
    )!
    expect(r.source).toBe('face')
    expect(r.person_id).toBe(7)
  })
  it('skips ignored faces', () => {
    const r = pickPrimaryBbox(
      [{ bbox: { x: 0.3, y: 0.3, width: 0.5, height: 0.5 }, ignored: true }],
      [{ bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }, confidence: 0.5 }],
    )!
    expect(r.source).toBe('landmark')
  })
  it('returns top landmark by confidence', () => {
    const r = pickPrimaryBbox(
      [],
      [
        { bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.3 },
        { bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, confidence: 0.9 },
      ],
    )!
    expect(r.source).toBe('landmark')
    expect(r.bbox.x).toBe(0.3)
  })
})

describe('findFaceForPerson', () => {
  it('returns the largest face for a person', () => {
    const r = findFaceForPerson(
      [
        { bbox: { x: 0, y: 0, width: 0.1, height: 0.1 }, person_id: 5 },
        { bbox: { x: 0.5, y: 0.5, width: 0.3, height: 0.3 }, person_id: 5 },
        { bbox: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, person_id: 9 },
      ],
      5,
    )!
    expect(r.width).toBe(0.3)
  })
  it('returns null when no face matches', () => {
    expect(
      findFaceForPerson([{ bbox: { x: 0, y: 0, width: 0.1, height: 0.1 }, person_id: 5 }], 9),
    ).toBeNull()
  })
  it('ignores ignored faces', () => {
    expect(
      findFaceForPerson(
        [{ bbox: { x: 0, y: 0, width: 0.1, height: 0.1 }, person_id: 5, ignored: true }],
        5,
      ),
    ).toBeNull()
  })
})
