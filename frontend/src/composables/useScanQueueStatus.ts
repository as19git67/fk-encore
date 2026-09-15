import { computed, onMounted, ref } from 'vue'
import { getScanQueueStatus, type ScanQueueStatus } from '../api/photos'
import { useRealtimeEvent } from './useRealtime'

/**
 * Shared view of the photo scan queue.
 *
 * The maintenance actions (grouping, GPS, crops, metadata) refuse to start
 * while the queue is busy. They used to read that straight off the combined
 * data-management page; now that each action lives in its own panel the state
 * is held here once and shared, so a page with five panels still issues one
 * request per refresh rather than five.
 */
const status = ref<ScanQueueStatus>({ services: [] })
let inFlight: Promise<void> | null = null

const totalPending = computed(() =>
  status.value.services.reduce((s, svc) => s + svc.pending, 0),
)
const totalProcessing = computed(() =>
  status.value.services.reduce((s, svc) => s + svc.processing, 0),
)
const totalFailed = computed(() =>
  status.value.services.reduce((s, svc) => s + svc.failed, 0),
)
const isActive = computed(() => totalPending.value > 0 || totalProcessing.value > 0)

/** Fetch once, sharing a single request between concurrent callers. */
function refresh(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = getScanQueueStatus()
    .then((res) => { status.value = res })
    .catch(() => { /* ignore transient errors — the next push event refreshes */ })
    .finally(() => { inFlight = null })
  return inFlight
}

export function useScanQueueStatus() {
  onMounted(() => { void refresh() })
  // Push updates: the backend emits `scan-queue/state.changed` (debounced to
  // at most one event every 500ms) for every queue mutation. We just refetch —
  // the REST endpoint remains the source of truth. The WebSocket bus
  // auto-reconnects with exponential backoff and replays the outbox on resume,
  // so no separate polling fallback is needed.
  useRealtimeEvent('scan-queue', 'state.changed', () => { void refresh() })

  return { status, totalPending, totalProcessing, totalFailed, isActive, refresh }
}
