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
export function useScrollRestore(key: string) {
  const storageKey = PREFIX + key

  function save() {
    sessionStorage.setItem(storageKey, String(Math.round(window.scrollY)))
  }

  function restore() {
    const raw = sessionStorage.getItem(storageKey)
    if (raw === null) return
    const y = parseInt(raw, 10)
    if (isNaN(y) || y <= 0) return
    // Use requestAnimationFrame so the browser has painted the new content.
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }))
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
