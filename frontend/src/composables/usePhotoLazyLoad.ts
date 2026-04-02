import { ref, onUnmounted } from 'vue'

/**
 * Lazy-loads photo thumbnails using IntersectionObserver.
 * Call setupObserver(containerEl) after the grid is mounted/updated.
 * Returns visiblePhotoIds – a reactive Set of photo IDs currently near the viewport.
 */
export function usePhotoLazyLoad(rootMargin = '300px 0px') {
  const visiblePhotoIds = ref(new Set<number>())

  let observer: IntersectionObserver | null = null
  let debounceTimeout: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<number>()

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
          const id = Number((entry.target as HTMLElement).dataset.photoId)
          if (!id) continue
          if (entry.isIntersecting) pending.add(id)
          else pending.delete(id)
        }
        if (debounceTimeout) clearTimeout(debounceTimeout)
        debounceTimeout = setTimeout(flush, 150)
      },
      { root, rootMargin }
    )

    const els = root.querySelectorAll('[data-photo-id]')
    els.forEach(el => observer!.observe(el))

    // Immediate fallback for elements already in viewport
    const rootRect = root.getBoundingClientRect()
    els.forEach(el => {
      const rect = el.getBoundingClientRect()
      if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
        const id = Number((el as HTMLElement).dataset.photoId)
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
