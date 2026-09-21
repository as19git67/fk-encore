/**
 * Finds elements that stick out of the viewport sideways (issue #1272).
 *
 * The page never scrolls horizontally, so an element wider than the screen
 * is either cut off (a bug) or inside a horizontal scroller of its own
 * (fine: a table in a ScrollX wrapper). The check therefore ignores anything
 * that has a clipping ancestor below <body>, and reports the rest.
 *
 * Written to run inside `page.evaluate` (Storybook test runner) as well as
 * under jsdom in a unit test: no imports, no module-level helpers, only DOM
 * APIs, and the viewport width and the style lookup are injectable.
 */

export interface OverflowingElement {
  /** A CSS-ish path of the element, for the failure message. */
  path: string
  right: number
}

export interface OverflowCheckOptions {
  /** Defaults to window.innerWidth. */
  viewportWidth?: number
  /** Tolerance in px for sub-pixel rounding. */
  tolerance?: number
  /** Defaults to getComputedStyle; injectable for jsdom. */
  getStyle?: (el: Element) => { overflowX: string; overflow: string; visibility: string }
}

export function findOverflowingElements(
  root: ParentNode = document.body,
  options: OverflowCheckOptions = {},
): OverflowingElement[] {
  const viewportWidth = options.viewportWidth ?? window.innerWidth
  const tolerance = options.tolerance ?? 1
  const getStyle = options.getStyle ?? ((el: Element) => getComputedStyle(el))

  // Everything below is local on purpose: `page.evaluate` serialises this
  // function's source alone, so a module-level helper would be undefined in
  // the browser.
  const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip'])

  const describe = (el: Element): string => {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node !== document.body && parts.length < 4) {
      const tag = node.tagName.toLowerCase()
      const id = node.id ? `#${node.id}` : ''
      const cls = typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : ''
      parts.unshift(`${tag}${id}${cls}`)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * Hidden means hidden: a measurement row rendered at its natural width
   * (`ResponsiveToolbar` keeps one to decide what fits) paints nothing and
   * takes no clicks, so its width is not something the user can lose.
   */
  const isInvisible = (el: Element): boolean => {
    let node: Element | null = el
    while (node && node !== document.body) {
      if (getStyle(node).visibility === 'hidden') return true
      node = node.parentElement
    }
    return false
  }

  const clipsHorizontally = (el: Element): boolean => {
    const style = getStyle(el)
    return CLIPPING.has(style.overflowX) || CLIPPING.has(style.overflow)
  }

  const hasClippingAncestor = (el: Element): boolean => {
    let node = el.parentElement
    while (node && node !== document.body && node !== document.documentElement) {
      if (clipsHorizontally(node)) return true
      node = node.parentElement
    }
    return false
  }

  const found: OverflowingElement[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.right <= viewportWidth + tolerance) continue
    // Off-screen on purpose (a closed drawer parked to the right).
    if (rect.left >= viewportWidth) continue
    if (hasClippingAncestor(el)) continue
    if (isInvisible(el)) continue
    found.push({ path: describe(el), right: Math.round(rect.right) })
  }
  return found
}
