import { ref, onUnmounted } from 'vue'

/**
 * Lazy-loads photo thumbnails using IntersectionObserver.
 *
 * Lifecycle:
 *   - `setupObserver(root)` — full (re)init: disconnect any prior observer,
 *     clear the visible set, observe every `[data-photo-id]` element under
 *     `root`, and synchronously seed the visible set from elements already
 *     in the viewport so thumbnails for the initial scroll position render
 *     without a one-tick delay. Use this on first mount and whenever the
 *     dataset is replaced wholesale (filter / sort / search reset).
 *   - `observeNewItems()` — incremental: just attach the existing observer
 *     to any `[data-photo-id]` elements that are not yet observed. Use this
 *     after appending a new batch of photos to the grid (background page
 *     load). Does NOT clear `visiblePhotoIds`, does NOT re-observe items
 *     that are already tracked, and does NOT walk every element with
 *     `getBoundingClientRect()` — those three operations together blocked
 *     the main thread for hundreds of ms per batch on a 45k-photo grid,
 *     which is what made the gallery feel frozen during scroll while pages
 *     were streaming in.
 *
 * Returns `visiblePhotoIds` — a reactive Set of photo IDs currently near
 * the viewport. The grid uses this with `v-if` to mount the actual
 * thumbnail only when needed.
 */
export function usePhotoLazyLoad(rootMargin = '300px 0px') {
  const visiblePhotoIds = ref(new Set<number>())

  let observer: IntersectionObserver | null = null
  let rootEl: HTMLElement | null = null
  let debounceTimeout: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<number>()
  // Tracks elements we have already called `observer.observe()` on, so
  // `observeNewItems` can skip them. WeakSet so detached elements are GC'd
  // automatically — there is nothing to clean up when Vue removes a photo
  // item from the grid.
  let observed = new WeakSet<Element>()

  function flush() {
    visiblePhotoIds.value = new Set(pending)
    debounceTimeout = null
  }

  function handleEntries(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const id = Number((entry.target as HTMLElement).dataset.photoId)
      if (!id) continue
      if (entry.isIntersecting) pending.add(id)
      else pending.delete(id)
    }
    if (debounceTimeout) clearTimeout(debounceTimeout)
    debounceTimeout = setTimeout(flush, 150)
  }

  function setupObserver(root: HTMLElement) {
    observer?.disconnect()
    observed = new WeakSet<Element>()
    visiblePhotoIds.value = new Set()
    pending.clear()
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null }
    rootEl = root

    observer = new IntersectionObserver(handleEntries, { root, rootMargin })

    const els = root.querySelectorAll('[data-photo-id]')
    els.forEach((el) => {
      observer!.observe(el)
      observed.add(el)
    })

    // Synchronous fallback: seed `pending` from elements already in (or
    // near) the viewport so the first frame shows real thumbnails instead
    // of empty placeholders. Each `getBoundingClientRect()` after the first
    // is essentially free because layout has already been forced, but the
    // total still scales with element count — keep this loop on the
    // *initial* setup only, never re-run on incremental updates.
    const rootRect = root.getBoundingClientRect()
    els.forEach((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
        const id = Number((el as HTMLElement).dataset.photoId)
        if (id) pending.add(id)
      }
    })
    flush()
  }

  /**
   * Observe newly-appended `[data-photo-id]` elements without disturbing
   * existing observations or the current visible set. Safe to call on every
   * `groupedPhotos` change after the initial `setupObserver`.
   */
  function observeNewItems() {
    if (!observer || !rootEl) return
    const els = rootEl.querySelectorAll('[data-photo-id]')
    // Cheap loop: just `observe()` for elements we have not seen yet. No
    // forced layout, no Set churn — this is what makes background-batch
    // grid updates feel instant even on a phone.
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!
      if (!observed.has(el)) {
        observer.observe(el)
        observed.add(el)
      }
    }
  }

  function teardown() {
    observer?.disconnect()
    observer = null
    rootEl = null
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null }
  }

  onUnmounted(teardown)

  return { visiblePhotoIds, setupObserver, observeNewItems, teardown }
}
