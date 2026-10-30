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
 * Whatever is scrolling is always the document (issue #1674): no page has a
 * scroller of its own around its main content any more, because iOS only
 * scrolls to the top on a tap on the status bar when the document scrolls.
 */

const PREFIX = 'scroll_offset:'

let cameFromHistory = false
let nextIsReturn = false

export function currentScrollTop(): number {
  return Math.round(window.scrollY)
}

export function scrollToTop(top: number): void {
  window.scrollTo({ top, behavior: 'instant' })
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
  cameFromHistory = fromHistory || nextIsReturn
  nextIsReturn = false
}

/**
 * Declare the navigation about to happen a return, even though it is a push.
 *
 * The "Zurück" button of a detail page opened from a shared link has no
 * in-module history entry to go back to, so `useModuleBack` pushes the
 * module's list instead. For the reader that push is still "back": the list
 * must land on the entry they came from (the detail page saved the anchor on
 * load), not start at the top as if picked from the menu. The flag covers
 * exactly one navigation — `markNavigation`, which the router calls for every
 * confirmed navigation, consumes it.
 */
export function markNextNavigationAsReturn(): void {
  nextIsReturn = true
}

/** Whether the page now showing was reached by going back or forward. */
export function navigatedFromHistory(): boolean {
  return cameFromHistory
}
