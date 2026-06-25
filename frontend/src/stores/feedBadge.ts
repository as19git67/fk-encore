import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getFeedUnreadCount } from '../api/feed'
import { realtimeBus } from '../composables/useRealtime'
import { useAuthStore } from './auth'

export const useFeedBadgeStore = defineStore('feedBadge', () => {
  const count = ref(0)

  async function refresh() {
    try {
      const res = await getFeedUnreadCount()
      count.value = res.count
    } catch {
      // silently ignore – user may lack photos.view
    }
    syncAppBadge()
  }

  function reset() {
    count.value = 0
    syncAppBadge()
  }

  function syncAppBadge() {
    if (!('setAppBadge' in navigator)) return
    if (count.value > 0) {
      (navigator as Navigator & { setAppBadge: (n: number) => Promise<void> })
        .setAppBadge(count.value)
        .catch(() => {})
    } else {
      (navigator as Navigator & { clearAppBadge: () => Promise<void> })
        .clearAppBadge()
        .catch(() => {})
    }
  }

  function init() {
    const auth = useAuthStore()

    realtimeBus.on('feed', 'item.added', () => {
      void refresh()
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && auth.isAuthenticated) {
        void refresh()
      }
    })

    if (auth.isAuthenticated) {
      void refresh()
    }

    watch(() => auth.isAuthenticated, (authenticated) => {
      if (authenticated) void refresh()
      else reset()
    })
  }

  return { count, refresh, reset, init }
})
