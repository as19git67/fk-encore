/**
 * The scroll offset of whatever is scrolling, remembered per route.
 *
 * One place decides this for the whole app (issue #1272, stage 4): the router
 * saves the offset when a navigation leaves a page, and `PageLayout` puts it
 * back once the page says its data is there — a list cannot be scrolled to
 * 3000px while it is still two rows tall.
 *
 * Only going back restores. Picking the same page from a menu is a fresh
 * start and begins at the top, which is why `markNavigation` records whether
 * the navigation came from history.
 *
 * Which element is "whatever is scrolling" differs per page: a page that
 * scrolls with the document leaves `window.scrollY`, a page that scrolls
 * inside its content area (`scroll="self"`) leaves that element's `scrollTop`.
 * `PageLayout` registers the right one, so nothing else has to know.
 */

const PREFIX = 'scroll_offset:'

type ScrollerGetter = () => HTMLElement | null

let activeScroller: ScrollerGetter | null = null
let cameFromHistory = false

/**
 * Register the element whose `scrollTop` is this page's position, or `null`
 * for a page that scrolls with the document. Registering replaces the
 * previous page's scroller, since only one page is on screen.
 */
export function setPageScroller(getter: ScrollerGetter | null): void {
  activeScroller = getter
}

/** Drop the registration if it is still the current one (on unmount). */
export function clearPageScroller(getter: ScrollerGetter | null): void {
  if (activeScroller === getter) activeScroller = null
}

export function currentScrollTop(): number {
  const el = activeScroller?.() ?? null
  return Math.round(el ? el.scrollTop : window.scrollY)
}

export function scrollToTop(top: number): void {
  const el = activeScroller?.() ?? null
  if (el) el.scrollTo({ top, behavior: 'instant' })
  else window.scrollTo({ top, behavior: 'instant' })
}

export function saveScrollOffset(routeKey: string, top = currentScrollTop()): void {
  try {
    if (top > 0) sessionStorage.setItem(PREFIX + routeKey, String(Math.round(top)))
    else sessionStorage.removeItem(PREFIX + routeKey)
  } catch {
    /* private mode — the page just starts at the top */
  }
}

export function readScrollOffset(routeKey: string): number | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + routeKey)
    if (raw === null) return null
    const top = Number.parseInt(raw, 10)
    return Number.isFinite(top) && top > 0 ? top : null
  } catch {
    return null
  }
}

export function clearScrollOffset(routeKey: string): void {
  try {
    sessionStorage.removeItem(PREFIX + routeKey)
  } catch {
    /* nothing stored, nothing to lose */
  }
}

/**
 * Record how the current navigation happened. `fromHistory` is true for back
 * and forward (vue-router hands `scrollBehavior` a saved position only then).
 */
export function markNavigation(fromHistory: boolean): void {
  cameFromHistory = fromHistory
}

/** Whether the page now showing was reached by going back or forward. */
export function navigatedFromHistory(): boolean {
  return cameFromHistory
}
