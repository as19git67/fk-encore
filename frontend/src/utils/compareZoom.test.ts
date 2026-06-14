import { describe, it, expect } from 'vitest'
import {
  containedRect,
  computeBboxZoom,
  computeSyncBboxZoom,
  pickPrimaryBbox,
  findFaceForPerson,
  pickBboxAtPoint,
  clickPointToImageCoords,
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
  it('returns null when no faces', () => {
    expect(pickPrimaryBbox([])).toBeNull()
  })
  it('returns the face when one is present', () => {
    const r = pickPrimaryBbox(
      [{ bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 } }],
    )!
    expect(r.source).toBe('face')
  })
  it('prefers faces with person_id over unassigned faces', () => {
    const r = pickPrimaryBbox(
      [
        { bbox: { x: 0.3, y: 0.3, width: 0.5, height: 0.5 }, quality: 0.5 },
        { bbox: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, person_id: 7, quality: 0.1 },
      ],
    )!
    expect(r.source).toBe('face')
    expect(r.person_id).toBe(7)
  })
  it('returns null when the only face is ignored', () => {
    expect(
      pickPrimaryBbox([{ bbox: { x: 0.3, y: 0.3, width: 0.5, height: 0.5 }, ignored: true }]),
    ).toBeNull()
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

describe('pickBboxAtPoint', () => {
  const alice = { bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.25 }, person_id: 1 }
  const bob = { bbox: { x: 0.55, y: 0.3, width: 0.15, height: 0.2 }, person_id: 2 }
  const carol = { bbox: { x: 0.35, y: 0.55, width: 0.18, height: 0.22 }, person_id: 3 }

  it('falls back to global pick when the click point is out of range', () => {
    const r = pickBboxAtPoint([alice, bob], { x: -0.1, y: 0.5 })!
    // Out-of-range click is treated as "no specific signal" — global pick wins.
    expect(r.source).toBe('face')
  })

  it('picks the face whose bbox contains the click', () => {
    const r = pickBboxAtPoint([alice, bob, carol], { x: 0.62, y: 0.4 })!
    expect(r.person_id).toBe(2) // bob
  })

  it('picks the tightest face when click sits in overlapping bboxes', () => {
    const big = { bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, person_id: 9 }
    const small = { bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, person_id: 10 }
    const r = pickBboxAtPoint([big, small], { x: 0.5, y: 0.5 })!
    expect(r.person_id).toBe(10)
  })

  it('picks the nearest face within the radius when no bbox contains the click', () => {
    const r = pickBboxAtPoint([alice, bob, carol], { x: 0.34, y: 0.5 })!
    // Click is near carol (centred at (0.44, 0.66)) and alice (0.2, 0.325).
    // Distance: carol ~ 0.187, alice ~ 0.225. carol wins within default 0.15? No,
    // 0.187 > 0.15 — should fall back to pickPrimaryBbox.
    // Use a generous radius to force the near-match path.
    const r2 = pickBboxAtPoint([alice, bob, carol], { x: 0.34, y: 0.5 }, { nearRadius: 0.3 })!
    expect(r2.person_id).toBe(3) // carol
    // Sanity: with default radius we get fallback (one of the tagged faces).
    expect(r.source).toBe('face')
  })

  it('falls back to global pick when no face is anywhere near the click', () => {
    const r = pickBboxAtPoint([alice], { x: 0.9, y: 0.9 })!
    // Default radius (0.15) doesn't catch alice (~0.75 away) → fallback returns alice anyway.
    expect(r.source).toBe('face')
    expect(r.person_id).toBe(1)
  })

  it('skips ignored faces but still inspects others', () => {
    const ignored = { bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, ignored: true, person_id: 99 }
    const real = { bbox: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 }, person_id: 7 }
    const r = pickBboxAtPoint([ignored, real], { x: 0.5, y: 0.5 })!
    expect(r.person_id).toBe(7)
  })

  it('returns null when there are no faces', () => {
    expect(pickBboxAtPoint([], { x: 0.5, y: 0.5 })).toBeNull()
  })
})

describe('clickPointToImageCoords', () => {
  const VP = { width: 400, height: 400, photoWidth: 1600, photoHeight: 1000 }
  const OFFSET = { left: 100, top: 50 }

  it('maps the centre of a landscape photo to (0.5, 0.5)', () => {
    // Photo 16:10 in 400x400 → 400x250 with 75px top/bottom letterbox.
    // Centre of content = container left + 200, top + 75 + 125 = container left + 200, top + 200.
    const r = clickPointToImageCoords(VP, OFFSET, 100 + 200, 50 + 200)!
    expect(r.x).toBeCloseTo(0.5, 5)
    expect(r.y).toBeCloseTo(0.5, 5)
  })

  it('returns null for clicks on the letterbox stripe', () => {
    // y = 50 + 10 lands above the photo content (letterbox top).
    expect(clickPointToImageCoords(VP, OFFSET, 100 + 200, 50 + 10)).toBeNull()
  })

  it('returns null for clicks outside the container entirely', () => {
    expect(clickPointToImageCoords(VP, OFFSET, 0, 0)).toBeNull()
  })

  it('maps a click on the top-left corner of the photo content', () => {
    // Content starts at (offsetLeft + 0, offsetTop + 75) for this letterboxed photo.
    const r = clickPointToImageCoords(VP, OFFSET, 100, 50 + 75)!
    expect(r.x).toBeCloseTo(0, 5)
    expect(r.y).toBeCloseTo(0, 5)
  })
})
