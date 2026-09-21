import { describe, it, expect, afterEach } from 'vitest'
import { findOverflowingElements } from './overflowCheck'

/**
 * jsdom lays nothing out, so every element gets an explicit rectangle here
 * and the computed style is injected. What is under test is the rule: an
 * element past the right edge is reported unless something between it and
 * <body> clips or scrolls horizontally.
 */

const VIEWPORT = 360

function box(el: Element, left: number, width: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left, right: left + width, width, height: 20, top: 0, bottom: 20 }),
    configurable: true,
  })
}

function build(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-left]'))) {
    box(el, Number(el.dataset.left), Number(el.dataset.width))
  }
  return root
}

const styleOf = (el: Element) => ({
  overflowX: (el as HTMLElement).dataset?.overflowX ?? 'visible',
  overflow: 'visible',
  visibility: (el as HTMLElement).dataset?.visibility ?? 'visible',
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('findOverflowingElements', () => {
  it('ignores what is hidden, and what sits inside something hidden', () => {
    // A measurement row renders at its natural width to be measured; nobody
    // ever sees it, so its width cannot cut anything off.
    const root = build(`
      <div class="measure" data-visibility="hidden" data-left="0" data-width="500">
        <button class="sample" data-left="0" data-width="420"></button>
      </div>`)
    expect(findOverflowingElements(root, { viewportWidth: VIEWPORT, getStyle: styleOf })).toEqual([])
  })

  it('reports an element that sticks out of the viewport', () => {
    const root = build(`<div class="wide" data-left="0" data-width="500"></div>`)
    const found = findOverflowingElements(root, { viewportWidth: VIEWPORT, getStyle: styleOf })
    expect(found).toHaveLength(1)
    expect(found[0].path).toContain('div.wide')
    expect(found[0].right).toBe(500)
  })

  it('ignores content inside a horizontal scroller', () => {
    const root = build(`
      <div class="scroll-x" data-overflow-x="auto" data-left="0" data-width="360">
        <table data-left="0" data-width="1100"></table>
      </div>`)
    const found = findOverflowingElements(root, { viewportWidth: VIEWPORT, getStyle: styleOf })
    expect(found).toHaveLength(0)
  })

  it('ignores elements that fit, are empty, or are parked off-screen', () => {
    const root = build(`
      <p data-left="0" data-width="360"></p>
      <span data-left="0" data-width="0"></span>
      <aside data-left="360" data-width="300"></aside>
      <em data-left="359" data-width="2"></em>`)
    const found = findOverflowingElements(root, { viewportWidth: VIEWPORT, getStyle: styleOf })
    expect(found).toHaveLength(0)
  })
})
