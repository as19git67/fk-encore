/**
 * Sparse data source for the virtualized photo gallery.
 *
 * Holds a fixed-length array `entries` of size `total` (the row count for
 * the current filter+sort) where each slot is either a `GalleryGridEntry`
 * (loaded) or `null` (not yet fetched). The virtualized grid asks for a
 * range of indexes via `ensureRange(start, end)`; the composable fetches
 * any pages whose slots are still `null` and splices them in.
 *
 * Design points:
 *   - `entries` is a `shallowRef`. Vue tracks reassignments of the array
 *     reference but does NOT proxy each slot — that is the difference
 *     between a 45k-photo gallery using ~1 MB of state and ~30 MB.
 *   - Pages are aligned to `PAGE_SIZE` so a single `ensureRange` call only
 *     fires fetches for the pages actually overlapped by the visible
 *     window.
 *   - Concurrent fetches for the same page are deduped via the
 *     `inflight` map.
 *   - All work is server-driven: we never iterate over `entries` outside
 *     of the helper that splices a fetched slice into its slot range.
 */
import { ref, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import {
  getGalleryGrid,
  type GalleryGridEntry,
  type GallerySortDir,
  type GallerySortField,
} from '../api/gallery'

/**
 * Page size for windowed fetches. Smaller than the legacy 2000 because
 * the virtualized scroller only needs to fill the immediately-visible rows
 * plus a small overscan; smaller pages mean smaller responses, faster
 * parse, less wasted bandwidth on idle scrolls.
 */
export const GALLERY_PAGE_SIZE = 500

export interface GallerySource {
  /** Reactive total row count for the current filter/sort. */
  total: Ref<number>
  /** Sparse array of length `total`. Slots are `null` until loaded. */
  entries: ShallowRef<(GalleryGridEntry | null)[]>
  /** True while the very first request (`init`) is in flight. */
  initialLoading: Ref<boolean>
  /** Last error message, if any. Cleared on every successful fetch. */
  error: Ref<string>
  /**
   * Initial fetch. Returns the offset of the centered/landed window so the
   * virtualized scroller knows where to position the user's viewport.
   */
  init(opts: {
    aroundPhotoId?: number | null
    sortBy?: GallerySortField
    sortDir?: GallerySortDir
  }): Promise<{ initialOffset: number; total: number }>
  /**
   * Make sure the slots in `[start, end)` are loaded (or in flight). Safe
   * to call on every virtualizer scroll event — no-ops when the covered
   * pages have already been requested.
   */
  ensureRange(start: number, end: number): void
  /** Cancel all in-flight requests (e.g., on unmount). */
  cancel(): void
}

export function useGallerySource(): GallerySource {
  const total = ref(0)
  const entries = shallowRef<(GalleryGridEntry | null)[]>([])
  const initialLoading = ref(false)
  const error = ref('')

  // Sort state for follow-up fetches. Captured at init() time so the
  // edge-fetches use the same parameters as the initial window.
  let currentSortBy: GallerySortField = 'taken_at'
  let currentSortDir: GallerySortDir = 'asc'

  /**
   * Pages whose fetch has been started already. Deduped by
   * `pageStart` (= floor(offset / PAGE_SIZE) * PAGE_SIZE). A page is in
   * the set whether its request is in flight or already resolved — once
   * we asked for it we never ask again.
   */
  const requestedPages = new Set<number>()
  const inflightControllers = new Set<AbortController>()

  function spliceIn(offset: number, photos: GalleryGridEntry[]) {
    if (photos.length === 0) return
    const arr = entries.value
    if (arr.length === 0) return
    // Mutate in place — the slots themselves are not Vue-reactive (we use
    // shallowRef), so we trigger a single reassignment at the end to
    // notify dependents (the virtualizer reads slots inside a computed
    // that depends on `entries`).
    for (let i = 0; i < photos.length; i++) {
      const idx = offset + i
      if (idx >= 0 && idx < arr.length) arr[idx] = photos[i]!
    }
    // shallowRef's reactivity is on the ref itself, not on the array.
    // Reassigning the same reference is a no-op for change detection, so
    // we must replace the array. `slice()` is O(total) but allocates a
    // single contiguous buffer — for 45k slots that is ~360 KB, which is
    // cheap compared to what a deep-reactive proxy refresh would cost.
    entries.value = arr.slice()
  }

  function pageStartForOffset(offset: number): number {
    return Math.floor(offset / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE
  }

  async function fetchPage(pageOffset: number) {
    if (requestedPages.has(pageOffset)) return
    requestedPages.add(pageOffset)
    const ctrl = new AbortController()
    inflightControllers.add(ctrl)
    try {
      const res = await getGalleryGrid(
        {
          limit: GALLERY_PAGE_SIZE,
          offset: pageOffset,
          sortBy: currentSortBy,
          sortDir: currentSortDir,
        },
        { signal: ctrl.signal },
      )
      // Server may have clamped the offset (e.g., if total shrank between
      // requests). Splice at the offset the server actually returned.
      spliceIn(res.offset, res.photos)
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      // Allow a retry by removing from the requested set on failure. The
      // virtualizer will trigger `ensureRange` again as the user keeps
      // scrolling, so a transient network blip self-heals.
      requestedPages.delete(pageOffset)
      error.value = err?.message ?? 'Fehler beim Laden weiterer Fotos.'
    } finally {
      inflightControllers.delete(ctrl)
    }
  }

  async function init(opts: {
    aroundPhotoId?: number | null
    sortBy?: GallerySortField
    sortDir?: GallerySortDir
  }): Promise<{ initialOffset: number; total: number }> {
    cancel()
    requestedPages.clear()
    initialLoading.value = true
    error.value = ''
    currentSortBy = opts.sortBy ?? 'taken_at'
    currentSortDir = opts.sortDir ?? 'asc'

    try {
      const ctrl = new AbortController()
      inflightControllers.add(ctrl)
      const res = await getGalleryGrid(
        {
          limit: GALLERY_PAGE_SIZE,
          aroundPhotoId: opts.aroundPhotoId ?? undefined,
          sortBy: currentSortBy,
          sortDir: currentSortDir,
        },
        { signal: ctrl.signal },
      )
      inflightControllers.delete(ctrl)
      total.value = res.total
      // Allocate the sparse backing array. `Array(total).fill(null)` is
      // O(total) memory allocation but no proxy creation per slot; for
      // 45k that's ~360 KB.
      const arr: (GalleryGridEntry | null)[] = new Array(res.total).fill(null)
      entries.value = arr
      // Mark this page as already requested so a subsequent ensureRange
      // pass over the same window doesn't refetch it.
      const pageStart = pageStartForOffset(res.offset)
      requestedPages.add(pageStart)
      spliceIn(res.offset, res.photos)
      return { initialOffset: res.offset, total: res.total }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        error.value = err?.message ?? 'Fehler beim Laden der Fotos.'
      }
      return { initialOffset: 0, total: 0 }
    } finally {
      initialLoading.value = false
    }
  }

  function ensureRange(start: number, end: number) {
    if (total.value === 0) return
    const lo = Math.max(0, Math.min(start, total.value - 1))
    const hi = Math.max(lo, Math.min(end, total.value))
    // Walk page-aligned offsets in [lo, hi) and fetch anything new.
    let p = pageStartForOffset(lo)
    while (p < hi) {
      if (!requestedPages.has(p)) {
        // Fire-and-forget; ensureRange itself is sync. The page becomes
        // visible as soon as `entries` updates after the splice.
        void fetchPage(p)
      }
      p += GALLERY_PAGE_SIZE
    }
  }

  function cancel() {
    for (const c of inflightControllers) {
      try { c.abort() } catch { /* ignore */ }
    }
    inflightControllers.clear()
  }

  return {
    total,
    entries,
    initialLoading,
    error,
    init,
    ensureRange,
    cancel,
  }
}
