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
import { ref, shallowRef, triggerRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import {
  getGalleryGrid,
  type GalleryGridEntry,
  type GallerySortDir,
  type GallerySortField,
} from '../api/gallery'
import type { PhotoFilter } from '../api/photos'

/**
 * Page size for windowed fetches. Smaller than the legacy 2000 because
 * the virtualized scroller only needs to fill the immediately-visible rows
 * plus a small overscan; smaller pages mean smaller responses, faster
 * parse, less wasted bandwidth on idle scrolls.
 */
export const GALLERY_PAGE_SIZE = 500

export interface GalleryQueryState {
  filter: PhotoFilter
  sortBy: GallerySortField
  sortDir: GallerySortDir
  /**
   * Search-result IDs in ranked order. When non-empty the gallery shows
   * only these photos in this order, ignoring sort.
   */
  photoIds: number[] | null
}

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
   * Initial fetch. Captures the supplied query state for use by subsequent
   * `ensureRange` calls. Returns the offset of the centered/landed window
   * so the virtualized scroller can position the viewport.
   */
  init(opts: GalleryQueryState & { aroundPhotoId?: number | null }): Promise<{
    initialOffset: number
    total: number
  }>
  /**
   * Make sure the slots in `[start, end)` are loaded (or in flight). Safe
   * to call on every virtualizer scroll event — no-ops when the covered
   * pages have already been requested.
   */
  ensureRange(start: number, end: number): void
  /**
   * Re-run `init` with the same query state and a new anchor (defaults to
   * the currently visible window). Used after curation, upload or stack
   * review to refresh the data without dropping the user's scroll
   * position. Caller may supply `aroundPhotoId` to anchor on a specific
   * photo (e.g. the one the user just acted on).
   */
  reload(opts?: { aroundPhotoId?: number | null }): Promise<void>
  /**
   * Mutate the loaded slot for `photoId` in place. Used for optimistic
   * curation updates so the user sees the change instantly without a
   * roundtrip. No-op if the photo isn't in the loaded window. Triggers a
   * reactive update so the cell re-renders.
   */
  updateEntry(photoId: number, partial: Partial<GalleryGridEntry>): void
  /**
   * Resolve the entry at a given absolute index. If the slot is already
   * populated, resolves synchronously with that entry. Otherwise, fires a
   * page fetch (deduped via the same in-flight tracking that `ensureRange`
   * uses) and waits for the page to land. Used by the fullscreen viewer to
   * prev/next through indexes whose pages haven't been scrolled into yet.
   * Returns `null` for out-of-range indexes or when the underlying fetch
   * fails.
   */
  loadEntryAt(index: number): Promise<GalleryGridEntry | null>
  /** Cancel all in-flight requests (e.g., on unmount). */
  cancel(): void
}

export function useGallerySource(): GallerySource {
  const total = ref(0)
  const entries = shallowRef<(GalleryGridEntry | null)[]>([])
  const initialLoading = ref(false)
  const error = ref('')

  // Active query state — captured at init() time so follow-up edge fetches
  // and reloads use exactly the same parameters.
  const query: GalleryQueryState = {
    filter: {},
    sortBy: 'taken_at',
    sortDir: 'asc',
    photoIds: null,
  }

  /**
   * Pages whose fetch has been started already, keyed by `pageStart`
   * (= floor(offset / PAGE_SIZE) * PAGE_SIZE). A page stays in the map
   * whether its request is in flight or already resolved — once we asked
   * for it we never ask again. The promise lets callers (e.g. the
   * fullscreen viewer's `loadEntryAt`) await an in-flight load instead of
   * polling for the slot to populate.
   */
  const pagePromises = new Map<number, Promise<void>>()
  const inflightControllers = new Set<AbortController>()

  function spliceIn(offset: number, photos: GalleryGridEntry[]) {
    if (photos.length === 0) return
    const arr = entries.value
    if (arr.length === 0) return
    for (let i = 0; i < photos.length; i++) {
      const idx = offset + i
      if (idx >= 0 && idx < arr.length) arr[idx] = photos[i]!
    }
    // shallowRef's reactivity is on the ref itself, not on the array.
    // Trigger explicitly so anything observing `entries` (the row-slot
    // computed in VirtualGallery) refreshes — much cheaper than
    // re-allocating a 45k-slot copy via .slice().
    triggerRef(entries)
  }

  function pageStartForOffset(offset: number): number {
    return Math.floor(offset / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE
  }

  function fetchPage(pageOffset: number): Promise<void> {
    const existing = pagePromises.get(pageOffset)
    if (existing) return existing
    const ctrl = new AbortController()
    inflightControllers.add(ctrl)
    const promise = (async () => {
      try {
        const res = await getGalleryGrid(
          {
            limit: GALLERY_PAGE_SIZE,
            offset: pageOffset,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
            filter: query.filter,
            photoIds: query.photoIds ?? undefined,
          },
          { signal: ctrl.signal },
        )
        spliceIn(res.offset, res.photos)
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        // Allow a retry by dropping the promise on failure. The virtualizer
        // will trigger `ensureRange` again as the user keeps scrolling, so
        // a transient network blip self-heals.
        pagePromises.delete(pageOffset)
        error.value = err?.message ?? 'Fehler beim Laden weiterer Fotos.'
      } finally {
        inflightControllers.delete(ctrl)
      }
    })()
    pagePromises.set(pageOffset, promise)
    return promise
  }

  async function init(
    opts: GalleryQueryState & { aroundPhotoId?: number | null },
  ): Promise<{ initialOffset: number; total: number }> {
    cancel()
    pagePromises.clear()
    initialLoading.value = true
    error.value = ''
    query.filter = opts.filter
    query.sortBy = opts.sortBy
    query.sortDir = opts.sortDir
    query.photoIds = opts.photoIds && opts.photoIds.length > 0 ? opts.photoIds : null

    try {
      const ctrl = new AbortController()
      inflightControllers.add(ctrl)
      const res = await getGalleryGrid(
        {
          limit: GALLERY_PAGE_SIZE,
          aroundPhotoId: opts.aroundPhotoId ?? undefined,
          sortBy: query.sortBy,
          sortDir: query.sortDir,
          filter: query.filter,
          photoIds: query.photoIds ?? undefined,
        },
        { signal: ctrl.signal },
      )
      inflightControllers.delete(ctrl)
      total.value = res.total
      // Allocate the sparse backing array.
      const arr: (GalleryGridEntry | null)[] = new Array(res.total).fill(null)
      entries.value = arr
      // Mark the initial page as already loaded so a subsequent
      // ensureRange() over the same window doesn't re-fetch it. We resolve
      // immediately because the data is in `entries` already.
      const pageStart = pageStartForOffset(res.offset)
      pagePromises.set(pageStart, Promise.resolve())
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

  async function reload(opts?: { aroundPhotoId?: number | null }): Promise<void> {
    await init({
      filter: query.filter,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
      photoIds: query.photoIds,
      aroundPhotoId: opts?.aroundPhotoId,
    })
  }

  function ensureRange(start: number, end: number) {
    if (total.value === 0) return
    const lo = Math.max(0, Math.min(start, total.value - 1))
    const hi = Math.max(lo, Math.min(end, total.value))
    let p = pageStartForOffset(lo)
    while (p < hi) {
      if (!pagePromises.has(p)) {
        void fetchPage(p)
      }
      p += GALLERY_PAGE_SIZE
    }
  }

  async function loadEntryAt(index: number): Promise<GalleryGridEntry | null> {
    if (total.value === 0 || index < 0 || index >= total.value) return null
    const cur = entries.value[index]
    if (cur) return cur
    await fetchPage(pageStartForOffset(index))
    return entries.value[index] ?? null
  }

  function updateEntry(photoId: number, partial: Partial<GalleryGridEntry>) {
    const arr = entries.value
    // Linear scan is fine: typically only a few hundred entries are
    // loaded at any time (the visible window plus prefetched neighbours).
    // Slots beyond the loaded window are `null` and are skipped quickly.
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i]
      if (e && e.id === photoId) {
        arr[i] = { ...e, ...partial }
        triggerRef(entries)
        return
      }
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
    reload,
    updateEntry,
    loadEntryAt,
    cancel,
  }
}
