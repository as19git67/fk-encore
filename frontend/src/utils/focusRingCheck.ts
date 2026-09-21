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
 * The walk stops at `<body>`. The page itself clips sideways on purpose
 * (`overflow-x: clip`, so nothing can scroll the document), but a real page
 * keeps its content a gutter away from that edge — only a component story,
 * rendered bare at x=0, ends up flush against it, and that is Storybook's
 * layout rather than the app's.
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
    outlineOffset: string
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
    // A screen-reader-only input (PrimeVue puts one behind every Select and
    // Checkbox) is a 1px box nobody ever sees a ring on; the visible control
    // beside it is what gets focused.
    if (rect.width <= 2 || rect.height <= 2) continue
    if (isInvisible(el)) continue
    // An element that draws its ring *inside* itself cannot have it clipped
    // by anything outside. That is the answer where the clipping is the
    // point — a rounded map cropping its tiles — and it needs no annotation:
    // the negative offset says so.
    if (Number.parseFloat(getStyle(el).outlineOffset) < 0) continue

    const sides = new Set<string>()
    let culprit: Element | null = null
    let node = el.parentElement
    while (node && node !== document.body && node !== document.documentElement) {
      const box = node.getBoundingClientRect()
      // A container smaller than the ring itself is not hiding anything a
      // user can see — it is the 1px box a screen-reader-only control sits
      // in. Nothing to make room in.
      if (box.width <= reach || box.height <= reach) {
        node = node.parentElement
        continue
      }
      if (clips(node, 'x')) {
        // Where the scrollable canvas starts and ends, in viewport
        // coordinates — scrolled back to position zero.
        const canvasLeft = box.left - node.scrollLeft
        const canvasRight = canvasLeft + node.scrollWidth
        // The bug is an element sitting flush with an edge *from the
        // inside*: there is no room left for its ring and no scrolling that
        // reveals it. An element reaching past the edge is a different
        // problem — real overflow, which the 360px guard reports — and the
        // canvas numbers do not describe it, so this side is left alone.
        const insideLeft = rect.left - canvasLeft
        const insideRight = canvasRight - rect.right
        if (insideLeft >= -tolerance && insideLeft < reach - tolerance) sides.add('left')
        if (insideRight >= -tolerance && insideRight < reach - tolerance) sides.add('right')
      }
      if (clips(node, 'y')) {
        const canvasTop = box.top - node.scrollTop
        const canvasBottom = canvasTop + node.scrollHeight
        const insideTop = rect.top - canvasTop
        const insideBottom = canvasBottom - rect.bottom
        if (insideTop >= -tolerance && insideTop < reach - tolerance) sides.add('top')
        if (insideBottom >= -tolerance && insideBottom < reach - tolerance) sides.add('bottom')
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
