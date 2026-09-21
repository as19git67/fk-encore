/**
 * Finds focusable elements whose focus ring would be clipped away (#1281).
 *
 * The ring is drawn *outside* its element — 2px wide, 2px clear of the edge,
 * so it reaches 4px out. A container that clips (a scroller, a fixed-height
 * row) cuts off whatever reaches past it, and the ring goes with it. Nothing
 * looks broken until someone navigates by keyboard: the hamburger's ring lost
 * its left side, the submenu items lost their top and bottom, and a
 * Sammelmappe row that fills its column lost both sides.
 *
 * The container is what has to give way, not the element: it takes the ring's
 * reach as padding and the same amount back as a negative margin, so the
 * content stays where it was. This check looks for the cases where that has
 * not been done.
 *
 * "Clipped" means the ring cannot be brought into view at *any* scroll
 * position, so the measurement is against the container's scrollable canvas
 * rather than the slice of it that happens to be visible. A row below the
 * fold is not clipped — it is one scroll away. A row flush with the start or
 * the end of the canvas is: there is nothing left to scroll to.
 *
 * Written to run inside `page.evaluate` as well as under jsdom: no imports,
 * no module-level helpers, and the style lookup is injectable.
 */

export interface ClippedRing {
  /** A CSS-ish path of the element, for the failure message. */
  path: string
  /** Which sides of the ring the container would cut off. */
  sides: string[]
  /** The container doing the clipping — the one that has to make room. */
  container: string
}

export interface FocusRingCheckOptions {
  /** How far the ring reaches past the element, in px. */
  reach?: number
  /** Tolerance in px for sub-pixel rounding. */
  tolerance?: number
  getStyle?: (el: Element) => {
    overflowX: string
    overflowY: string
    overflow: string
    visibility: string
    display: string
  }
}

export function findClippedFocusRings(
  root: ParentNode = document.body,
  options: FocusRingCheckOptions = {},
): ClippedRing[] {
  const reach = options.reach ?? 4
  const tolerance = options.tolerance ?? 0.5
  const getStyle = options.getStyle ?? ((el: Element) => getComputedStyle(el))

  // Local on purpose: `page.evaluate` serialises this function alone.
  const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip'])
  const FOCUSABLE =
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

  const describe = (el: Element): string => {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node !== document.body && parts.length < 4) {
      const tag = node.tagName.toLowerCase()
      const id = node.id ? `#${node.id}` : ''
      const cls =
        typeof node.className === 'string' && node.className.trim()
          ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
          : ''
      parts.unshift(`${tag}${id}${cls}`)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const clips = (el: Element, axis: 'x' | 'y'): boolean => {
    const style = getStyle(el)
    const own = axis === 'x' ? style.overflowX : style.overflowY
    return CLIPPING.has(own) || CLIPPING.has(style.overflow)
  }

  const isInvisible = (el: Element): boolean => {
    let node: Element | null = el
    while (node && node !== document.body) {
      const style = getStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') return true
      node = node.parentElement
    }
    return false
  }

  const found: ClippedRing[] = []
  for (const el of Array.from(root.querySelectorAll(FOCUSABLE))) {
    if ((el as HTMLElement & { disabled?: boolean }).disabled) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (isInvisible(el)) continue

    const sides = new Set<string>()
    let culprit: Element | null = null
    let node = el.parentElement
    while (node && node !== document.documentElement) {
      const box = node.getBoundingClientRect()
      if (clips(node, 'x')) {
        // Where the scrollable canvas starts and ends, in viewport
        // coordinates — scrolled back to position zero.
        const canvasLeft = box.left - node.scrollLeft
        const canvasRight = canvasLeft + node.scrollWidth
        // An element lying wholly outside the canvas is not described by
        // these numbers at all: it is positioned out of flow, or the
        // metrics have not caught up. Guessing from them produces findings
        // nobody can act on, so this axis is left alone.
        if (rect.right >= canvasLeft && rect.left <= canvasRight) {
          if (rect.left - canvasLeft < reach - tolerance) sides.add('left')
          if (canvasRight - rect.right < reach - tolerance) sides.add('right')
        }
      }
      if (clips(node, 'y')) {
        const canvasTop = box.top - node.scrollTop
        const canvasBottom = canvasTop + node.scrollHeight
        if (rect.bottom >= canvasTop && rect.top <= canvasBottom) {
          if (rect.top - canvasTop < reach - tolerance) sides.add('top')
          if (canvasBottom - rect.bottom < reach - tolerance) sides.add('bottom')
        }
      }
      if (sides.size > 0 && !culprit) culprit = node
      node = node.parentElement
    }
    if (sides.size > 0) {
      found.push({
        path: describe(el),
        sides: Array.from(sides),
        container: culprit ? describe(culprit) : '',
      })
    }
  }
  return found
}
