import { describe, expect, it } from 'vitest'
import { slotImageBox } from './photoBookImage'

describe('slotImageBox', () => {
  // A 3:2 photo in a square frame: the window keeps the middle two thirds of its width.
  const window = { x: 1 / 6, y: 0, w: 2 / 3, h: 1 }

  it('draws exactly the window when the image has the aspect the server reckoned with', () => {
    const r = slotImageBox(window, 1, 1.5)
    expect(r.w).toBeCloseTo(1.5, 9)
    expect(r.h).toBeCloseTo(1, 9)
    expect(r.x).toBeCloseTo(-0.25, 9)
    expect(r.y).toBeCloseTo(0, 9)
    expect(slotImageBox(window, 1, null)).toEqual(r)
  })

  it('keeps the image shape when it is not the one on record', () => {
    // On record 3:2, but the file is portrait 2:3.
    const r = slotImageBox(window, 1, 2 / 3)
    const frame = 1
    expect((r.w / r.h) * frame).toBeCloseTo(2 / 3, 9)
    // It still covers the frame.
    expect(r.x).toBeLessThanOrEqual(0)
    expect(r.y).toBeLessThanOrEqual(0)
    expect(r.x + r.w).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(r.y + r.h).toBeGreaterThanOrEqual(1 - 1e-9)
  })
})
