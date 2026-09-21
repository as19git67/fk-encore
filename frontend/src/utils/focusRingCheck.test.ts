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
      outlineOffset: '2px',
      borderTopWidth: '0px',
      borderLeftWidth: '0px',
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

  it('says nothing about an element that draws its ring inside itself', () => {
    const root = document.createElement('div')
    const box = document.createElement('div')
    const link = document.createElement('a')
    link.setAttribute('href', '#')
    box.appendChild(link)
    root.appendChild(box)
    const rect = (el: Element, b: Box) =>
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({ ...b, width: b.right - b.left, height: b.bottom - b.top, x: b.left, y: b.top, toJSON: () => b }),
      })
    // The link covers the box edge to edge, and the box clips on purpose.
    rect(box, column)
    rect(link, column)

    const found = findClippedFocusRings(root, {
      reach: 4,
      getStyle: (el) => ({
        overflowX: el === box ? 'hidden' : 'visible',
        overflowY: el === box ? 'hidden' : 'visible',
        overflow: el === box ? 'hidden' : 'visible',
        visibility: 'visible',
        display: 'block',
        // The negative offset is the element saying "my ring is inside me".
        outlineOffset: el === link ? '-2px' : '2px',
        borderTopWidth: '0px',
        borderLeftWidth: '0px',
      }),
    })
    expect(found).toEqual([])
  })

  it('leaves an element that reaches past the edge alone — that is overflow', () => {
    // Sticking out is a different bug, and the canvas numbers do not
    // describe such an element: reporting it produces a finding that the
    // padding fix cannot resolve.
    const found = scene(
      { box: column, overflow: 'auto', scrollWidth: 200 },
      { box: { left: 20, top: 10, right: 260, bottom: 50 } },
    )
    expect(found).toEqual([])
  })

  it('measures from inside the border, where the canvas actually starts', () => {
    // `scrollHeight` spans the padding box. A card with a 1px border and
    // exactly 4px of padding below its last button has the room; measuring
    // from the border box instead loses that border and reports it anyway.
    const root = document.createElement('div')
    const card = document.createElement('div')
    const button = document.createElement('button')
    card.appendChild(button)
    root.appendChild(card)
    const place = (el: Element, b: Box, scrollHeight?: number) => {
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({ ...b, width: b.right - b.left, height: b.bottom - b.top, x: b.left, y: b.top, toJSON: () => b }),
      })
      Object.defineProperty(el, 'scrollHeight', { value: scrollHeight ?? b.bottom - b.top, configurable: true })
      Object.defineProperty(el, 'scrollWidth', { value: b.right - b.left, configurable: true })
      Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true })
      Object.defineProperty(el, 'scrollLeft', { value: 0, configurable: true })
    }
    // Border box 0–102, 1px border each side, so the canvas is 1–101.
    place(card, { left: 0, top: 0, right: 200, bottom: 102 }, 100)
    // The button ends 4px above the canvas bottom (101 - 4 = 97).
    place(button, { left: 20, top: 60, right: 180, bottom: 97 })

    const found = findClippedFocusRings(root, {
      reach: 4,
      getStyle: (el) => ({
        overflowX: el === card ? 'hidden' : 'visible',
        overflowY: el === card ? 'hidden' : 'visible',
        overflow: el === card ? 'hidden' : 'visible',
        visibility: 'visible',
        display: 'block',
        outlineOffset: '2px',
        borderTopWidth: el === card ? '1px' : '0px',
        borderLeftWidth: el === card ? '1px' : '0px',
      }),
    })
    expect(found).toEqual([])
  })

  it('ignores an element nobody can focus or see', () => {
    const root = document.createElement('div')
    const span = document.createElement('span')
    root.appendChild(span)
    expect(findClippedFocusRings(root)).toEqual([])
  })
})
