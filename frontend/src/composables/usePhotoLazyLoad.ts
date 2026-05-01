import { ref, onUnmounted } from 'vue'

/**
 * Lazy-loads grid items using IntersectionObserver.
 * Call setupObserver(containerEl) after the grid is mounted/updated.
 * Returns visiblePhotoIds – a reactive Set of item IDs currently near the
 * viewport.
 *
 * `datasetKey` is the camelCase form of the `data-…` attribute that carries
 * the item id (default: `photoId`, i.e. `data-photo-id`). The album list
 * passes `albumId` so the same observer logic can drive `data-album-id`
 * cards without forking.
 */
export function usePhotoLazyLoad(rootMargin = '300px 0px', datasetKey = 'photoId') {
  const visiblePhotoIds = ref(new Set<number>())

  let observer: IntersectionObserver | null = null
  let debounceTimeout: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<number>()
  const selector = `[data-${datasetKey.replace(/([A-Z])/g, '-$1').toLowerCase()}]`

  function readId(el: Element): number {
    return Number((el as HTMLElement).dataset[datasetKey])
  }

  function flush() {
    visiblePhotoIds.value = new Set(pending)
    debounceTimeout = null
  }

  function setupObserver(root: HTMLElement) {
    observer?.disconnect()
    visiblePhotoIds.value = new Set()
    pending.clear()
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null }

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = readId(entry.target)
          if (!id) continue
          if (entry.isIntersecting) pending.add(id)
          else pending.delete(id)
        }
        if (debounceTimeout) clearTimeout(debounceTimeout)
        debounceTimeout = setTimeout(flush, 150)
      },
      { root, rootMargin }
    )

    const els = root.querySelectorAll(selector)
    els.forEach(el => observer!.observe(el))

    // Immediate fallback for elements already in viewport
    const rootRect = root.getBoundingClientRect()
    els.forEach(el => {
      const rect = el.getBoundingClientRect()
      if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
        const id = readId(el)
        if (id) pending.add(id)
      }
    })
    flush()
  }

  function teardown() {
    observer?.disconnect()
    observer = null
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null }
  }

  onUnmounted(teardown)

  return { visiblePhotoIds, setupObserver, teardown }
}
