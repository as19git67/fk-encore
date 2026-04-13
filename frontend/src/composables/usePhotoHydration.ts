import type { Ref } from 'vue'
import { getPhotoDetailsBatch, type Photo } from '../api/photos'

/**
 * Detail fields that the lightweight /photos/index endpoint does not return.
 * If none of these are present on a Photo, we treat it as "not yet hydrated"
 * and need to fetch its full record from /photos/details.
 *
 * `description`, `latitude`, `longitude`, `location_*`, `ai_quality_*` and
 * `hash` are all optional in the DB too, so a hydrated photo may legitimately
 * have all of them undefined. We use a separate Set to track hydration state
 * deterministically rather than guessing from field presence.
 */
export interface PhotoHydrationController {
  /** Mark the given IDs as hydrated (e.g. when injecting freshly uploaded photos). */
  markHydrated(ids: number[]): void
  /** Reset all tracking — call when reloading the entire index. */
  reset(): void
  /** Ensure full details are loaded for the given IDs (skips already-hydrated). Returns when done. */
  ensureLoaded(ids: number[]): Promise<void>
  /** Kick off a background hydration pass over all current photos. Idempotent. */
  hydrateAllInBackground(): void
  /** Stop any in-flight background hydration. */
  cancel(): void
}

interface Options {
  /** Max IDs per /photos/details request. Backend uses a query string so keep modest. */
  batchSize?: number
  /** Pause between background batches so the UI thread stays responsive. */
  backgroundPauseMs?: number
}

export function usePhotoHydration(
  photos: Ref<Photo[]>,
  options: Options = {}
): PhotoHydrationController {
  const batchSize = options.batchSize ?? 100
  const backgroundPauseMs = options.backgroundPauseMs ?? 50

  const hydratedIds = new Set<number>()
  /** IDs currently being fetched — dedupes concurrent ensureLoaded calls. */
  const inflightIds = new Set<number>()
  let backgroundRunId = 0

  function applyDetails(detailed: Photo[]) {
    if (detailed.length === 0) return
    const byId = new Map<number, Photo>()
    for (const p of detailed) byId.set(p.id, p)

    // Replace photo records in-place so reactive consumers see new heavy fields
    // while preserving array order (important for selectedIndex stability).
    const next = photos.value.slice()
    let changed = false
    for (let i = 0; i < next.length; i++) {
      const cur = next[i]!
      const merged = byId.get(cur.id)
      if (merged) {
        next[i] = merged
        hydratedIds.add(cur.id)
        changed = true
      }
    }
    if (changed) photos.value = next
  }

  async function fetchBatch(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    for (const id of ids) inflightIds.add(id)
    try {
      const res = await getPhotoDetailsBatch(ids)
      applyDetails(res.photos)
    } catch (err) {
      // Non-fatal: detail fields stay undefined, grid still works
      console.warn('[usePhotoHydration] details batch failed', err)
    } finally {
      for (const id of ids) inflightIds.delete(id)
    }
  }

  async function ensureLoaded(ids: number[]): Promise<void> {
    const todo = ids.filter(id => !hydratedIds.has(id) && !inflightIds.has(id))
    if (todo.length === 0) return
    // Split into batches and run sequentially so we don't hammer the API.
    for (let i = 0; i < todo.length; i += batchSize) {
      await fetchBatch(todo.slice(i, i + batchSize))
    }
  }

  function hydrateAllInBackground(): void {
    backgroundRunId++
    const myRun = backgroundRunId
    void (async () => {
      // Walk current photos array order — typically already sorted by date,
      // so we hydrate from newest to oldest first (matches typical scroll).
      let i = 0
      while (myRun === backgroundRunId && i < photos.value.length) {
        const slice: number[] = []
        while (slice.length < batchSize && i < photos.value.length) {
          const p = photos.value[i++]
          if (p && !hydratedIds.has(p.id) && !inflightIds.has(p.id)) {
            slice.push(p.id)
          }
        }
        if (slice.length > 0) {
          await fetchBatch(slice)
          if (myRun !== backgroundRunId) return
          // Yield to the event loop so user-driven detail fetches and rendering
          // stay snappy.
          await new Promise(r => setTimeout(r, backgroundPauseMs))
        }
      }
    })()
  }

  return {
    markHydrated(ids: number[]) {
      for (const id of ids) hydratedIds.add(id)
    },
    reset() {
      hydratedIds.clear()
      inflightIds.clear()
      backgroundRunId++ // cancel in-flight background loop
    },
    ensureLoaded,
    hydrateAllInBackground,
    cancel() {
      backgroundRunId++
    },
  }
}
