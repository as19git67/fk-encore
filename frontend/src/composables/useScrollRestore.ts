import { onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

const PREFIX = 'scroll_restore:'

/**
 * Saves window.scrollY under a session-scoped key before navigating away,
 * and returns a restore() function the caller invokes after its data has
 * loaded (so the DOM is tall enough to actually scroll to the saved position).
 *
 * Usage:
 *   const { restore } = useScrollRestore('finance-anomalies')
 *   onMounted(async () => { await load(); restore() })
 */
/**
 * Where the scroll position lives. A view whose content scrolls inside an
 * element of its own — a list column beside a detail pane, say — leaves
 * `window.scrollY` at 0 forever, so saving and restoring it would silently do
 * nothing. Such a view passes a getter for its own scroller instead.
 */
export interface ScrollRestoreOptions {
  getScroller?: () => HTMLElement | null | undefined
}

export function useScrollRestore(key: string, options: ScrollRestoreOptions = {}) {
  const storageKey = PREFIX + key

  function currentTop(): number {
    const el = options.getScroller?.()
    return Math.round(el ? el.scrollTop : window.scrollY)
  }

  function scrollTo(top: number) {
    const el = options.getScroller?.()
    if (el) el.scrollTo({ top, behavior: 'instant' })
    else window.scrollTo({ top, behavior: 'instant' })
  }

  function save() {
    sessionStorage.setItem(storageKey, String(currentTop()))
  }

  function restore() {
    const raw = sessionStorage.getItem(storageKey)
    if (raw === null) return
    const y = parseInt(raw, 10)
    if (isNaN(y) || y <= 0) return
    // Use requestAnimationFrame so the browser has painted the new content.
    requestAnimationFrame(() => scrollTo(y))
  }

  function clear() {
    sessionStorage.removeItem(storageKey)
  }

  // Save before leaving to the detail view (or anywhere else).
  onBeforeRouteLeave(() => { save() })

  // Clear on unmount triggered by a non-back navigation (e.g. sidebar link).
  // We detect this by checking: if the user navigated forward the entry will
  // still be there; we only clear when the component is destroyed without a
  // matching restore call, which we track with a flag.
  let restored = false
  const wrappedRestore = () => { restored = true; restore() }
  onBeforeUnmount(() => { if (!restored) clear() })

  return { restore: wrappedRestore, save, clear }
}
