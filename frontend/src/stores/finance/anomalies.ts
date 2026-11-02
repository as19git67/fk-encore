import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listAnomalies } from '../../api/finance'

export const useAnomalyStore = defineStore('financeAnomalies', () => {
  const count = ref(0)

  async function refresh() {
    try {
      const res = await listAnomalies()
      count.value = res.total
    } catch {
      // silently ignore – user may not have finance.view
    }
  }

  /**
   * The anomaly page holds the whole open list itself; it reports the
   * number after loading and after every acknowledgement, so the badge in
   * the menu follows each tick instead of waiting until the page is left.
   */
  function setCount(n: number) {
    count.value = n
  }

  return { count, refresh, setCount }
})
