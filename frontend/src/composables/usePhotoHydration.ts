import type { Ref } from 'vue'
import { getPhotoDetailsBatch, type Photo } from '../api/photos'
import { useServiceHealthStore } from '../stores/serviceHealth'

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
  /** Stop any in-flight background hydration and abort pending requests. */
  cancel(): void
}

interface Options {
  /** Max IDs per /photos/details request. Backend uses a query string so keep modest. */
  batchSize?: number
  /** Pause between background batches so the UI thread stays responsive. */
  backgroundPauseMs?: number
  /** Pause between batches when the server reports it is under pressure. */
  pressurePauseMs?: number
}

export function usePhotoHydration(
  photos: Ref<Photo[]>,
  options: Options = {}
): PhotoHydrationController {
  const batchSize = options.batchSize ?? 50
  const backgroundPauseMs = options.backgroundPauseMs ?? 50
  const pressurePauseMs = options.pressurePauseMs ?? 5_000

  const serviceHealth = useServiceHealthStore()

  const hydratedIds = new Set<number>()
  /** IDs currently being fetched — dedupes concurrent ensureLoaded calls. */
  const inflightIds = new Set<number>()
  /** Tracks all in-flight fetch controllers so cancel() actually aborts the
   *  XHR (otherwise the browser keeps the response buffer until the server
   *  finally responds, which on an overloaded backend can OOM the tab). */
  const inflightControllers = new Set<AbortController>()
  let backgroundRunId = 0

  function applyDetails(detailed: Photo[]) {
    if (detailed.length === 0) return
    const byId = new Map<number, Photo>()
    for (const p of detailed) byId.set(p.id, p)

    // Copy the hydrated fields onto the existing photo objects rather than
    // replacing the array reference. With 45k photos + 900 batches, cloning
    // the array via .slice() each batch allocated ~320 MB over the run and
    // triggered every computed that depends on `photos.value` (grouping,
    // selection, timeline) to re-evaluate on each batch. Property-level
    // mutations only notify effects that actually read the new fields
    // (sidebar, compare view), which is what we want.
    const arr = photos.value
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i]!
      const merged = byId.get(cur.id)
      if (merged) {
        Object.assign(cur, merged)
        hydratedIds.add(cur.id)
      }
    }
  }

  async function fetchBatch(ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true
    for (const id of ids) inflightIds.add(id)
    const controller = new AbortController()
    inflightControllers.add(controller)
    try {
      const res = await getPhotoDetailsBatch(ids, controller.signal)
      applyDetails(res.photos)
      return true
    } catch (err) {
      // Non-fatal: detail fields stay undefined, grid still works.
      // Returning false lets the background loop back off instead of
      // hammering an overloaded server with the next batch immediately.
      if ((err as Error)?.name !== 'AbortError') {
        console.warn('[usePhotoHydration] details batch failed', err)
      }
      return false
    } finally {
      for (const id of ids) inflightIds.delete(id)
      inflightControllers.delete(controller)
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
      let consecutiveFailures = 0
      while (myRun === backgroundRunId && i < photos.value.length) {
        // Back off when the server flags pressure: the index endpoint reports
        // event-loop lag, and continuing to fire detail batches at a stalled
        // server is the fastest way to OOM the browser tab.
        if (serviceHealth.serverPressure.underPressure) {
          await new Promise(r => setTimeout(r, pressurePauseMs))
          if (myRun !== backgroundRunId) return
          continue
        }

        const slice: number[] = []
        while (slice.length < batchSize && i < photos.value.length) {
          const p = photos.value[i++]
          if (p && !hydratedIds.has(p.id) && !inflightIds.has(p.id)) {
            slice.push(p.id)
          }
        }
        if (slice.length > 0) {
          const ok = await fetchBatch(slice)
          if (myRun !== backgroundRunId) return

          if (!ok) {
            // Exponential backoff up to 30 s; gives the server room to recover
            // and stops the browser from queueing more huge JSONB responses.
            consecutiveFailures = Math.min(consecutiveFailures + 1, 5)
            const delay = Math.min(backgroundPauseMs * 2 ** consecutiveFailures, 30_000)
            await new Promise(r => setTimeout(r, delay))
          } else {
            consecutiveFailures = 0
            // Yield to the event loop so user-driven detail fetches and rendering
            // stay snappy.
            await new Promise(r => setTimeout(r, backgroundPauseMs))
          }
        }
      }
    })()
  }

  function cancelAllInflight() {
    for (const c of inflightControllers) {
      try { c.abort() } catch { /* ignore */ }
    }
    inflightControllers.clear()
    inflightIds.clear()
  }

  return {
    markHydrated(ids: number[]) {
      for (const id of ids) hydratedIds.add(id)
    },
    reset() {
      hydratedIds.clear()
      backgroundRunId++ // cancel in-flight background loop
      cancelAllInflight()
    },
    ensureLoaded,
    hydrateAllInBackground,
    cancel() {
      backgroundRunId++
      cancelAllInflight()
    },
  }
}
