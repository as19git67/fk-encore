import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getExternalServiceHealth, type ExternalServiceHealth, type ExternalServiceName } from '../api/photos'

const POLL_INTERVAL_MS = 30_000

export const useServiceHealthStore = defineStore('serviceHealth', () => {
  const services = ref<ExternalServiceHealth[]>([])
  const loading = ref(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function refresh() {
    try {
      loading.value = true
      const res = await getExternalServiceHealth()
      services.value = res.services
    } catch {
      // Silently ignore – the UI can show defaults (all unavailable)
    } finally {
      loading.value = false
    }
  }

  function startPolling() {
    void refresh()
    if (!pollTimer) {
      pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function isAvailable(name: ExternalServiceName): boolean {
    return services.value.find(s => s.name === name)?.available ?? false
  }

  /** true when insightface is reachable (face recognition / reindex) */
  const faceServiceAvailable = computed(() => isAvailable('insightface'))
  /** true when embedding service is reachable (semantic search, quality, grouping) */
  const embeddingServiceAvailable = computed(() => isAvailable('embedding'))
  /** true when landmark service is reachable */
  const landmarkServiceAvailable = computed(() => isAvailable('landmark'))

  /** true when at least one service is unavailable */
  const hasUnavailableServices = computed(() =>
    services.value.length > 0 && services.value.some(s => !s.available)
  )

  return {
    services,
    loading,
    refresh,
    startPolling,
    stopPolling,
    isAvailable,
    faceServiceAvailable,
    embeddingServiceAvailable,
    landmarkServiceAvailable,
    hasUnavailableServices,
  }
})

