import { describe, it, expect } from 'vitest'
import { findClippedFocusRings } from './focusRingCheck'

/**
 * The arithmetic is the part that can be wrong, and was: measuring against
 * the *visible* slice of a scroller reported every row below the fold as
 * clipped. What matters is the scrollable canvas — a row one scroll away is
 * reachable, a row flush with the start or the end of the canvas is not.
 *
 * jsdom lays nothing out, so the geometry is stated outright.
 */

type Box = { left: number; top: number; right: number; bottom: number }

interface Spec {
  box: Box
  overflow?: string
  scrollLeft?: number
  scrollTop?: number
  scrollWidth?: number
  scrollHeight?: number
}

/** Builds a container with one focusable child, both placed by hand. */
function scene(container: Spec, child: Spec) {
  const root = document.createElement('div')
  const box = document.createElement('div')
  const button = document.createElement('button')
  box.appendChild(button)
  root.appendChild(box)

  const place = (el: Element, spec: Spec) => {
    const b = spec.box
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        left: b.left,
        top: b.top,
        right: b.right,
        bottom: b.bottom,
        width: b.right - b.left,
        height: b.bottom - b.top,
        x: b.left,
        y: b.top,
        toJSON: () => b,
      }),
    })
    for (const [key, value] of Object.entries({
      scrollLeft: spec.scrollLeft ?? 0,
      scrollTop: spec.scrollTop ?? 0,
      scrollWidth: spec.scrollWidth ?? b.right - b.left,
      scrollHeight: spec.scrollHeight ?? b.bottom - b.top,
    })) {
      Object.defineProperty(el, key, { value, configurable: true })
    }
  }
  place(box, container)
  place(button, child)

  const styles = new Map<Element, string>([
    [box, container.overflow ?? 'visible'],
    [button, 'visible'],
    [root, 'visible'],
  ])

  return findClippedFocusRings(root, {
    reach: 4,
    getStyle: (el) => ({
      overflowX: styles.get(el) ?? 'visible',
      overflowY: styles.get(el) ?? 'visible',
      overflow: styles.get(el) ?? 'visible',
      visibility: 'visible',
      display: 'block',
    }),
  })
}

const column: Box = { left: 0, top: 0, right: 200, bottom: 100 }

describe('findClippedFocusRings', () => {
  it('says nothing about a container that does not clip', () => {
    const found = scene(
      { box: column },
      { box: { left: 0, top: 0, right: 200, bottom: 40 } },
    )
    expect(found).toEqual([])
  })

  it('flags a row that fills a clipping column on both sides', () => {
    const found = scene(
      { box: column, overflow: 'auto', scrollHeight: 400 },
      { box: { left: 0, top: 10, right: 200, bottom: 50 } },
    )
    expect(found).toHaveLength(1)
    expect(found[0].sides.sort()).toEqual(['left', 'right'])
    expect(found[0].container).toContain('div')
  })

  it('leaves room when the container has padded itself', () => {
    // The fix: 4px of padding, so the canvas is 4px wider on each side.
    const found = scene(
      { box: { left: -4, top: 0, right: 204, bottom: 100 }, overflow: 'auto', scrollWidth: 208 },
      { box: { left: 0, top: 10, right: 200, bottom: 50 } },
    )
    expect(found).toEqual([])
  })

  it('does not call a row below the fold clipped — it is one scroll away', () => {
    const found = scene(
      { box: column, overflow: 'auto', scrollHeight: 400 },
      // Sits at 300–340 in the canvas, well inside it, currently off screen.
      { box: { left: 20, top: 300, right: 180, bottom: 340 } },
    )
    expect(found).toEqual([])
  })

  it('does flag the last row, which no scrolling can clear', () => {
    const found = scene(
      { box: column, overflow: 'auto', scrollHeight: 400 },
      { box: { left: 20, top: 360, right: 180, bottom: 400 } },
    )
    expect(found).toHaveLength(1)
    expect(found[0].sides).toEqual(['bottom'])
  })

  it('measures from where the canvas starts, not from the scrolled view', () => {
    // Scrolled down 120px: the first row is above the viewport but still
    // flush with the top of the canvas, so its ring is gone for good.
    const found = scene(
      { box: column, overflow: 'auto', scrollTop: 120, scrollHeight: 400 },
      { box: { left: 20, top: -120, right: 180, bottom: -80 } },
    )
    expect(found).toHaveLength(1)
    expect(found[0].sides).toEqual(['top'])
  })

  it('ignores an element nobody can focus or see', () => {
    const root = document.createElement('div')
    const span = document.createElement('span')
    root.appendChild(span)
    expect(findClippedFocusRings(root)).toEqual([])
  })
})
