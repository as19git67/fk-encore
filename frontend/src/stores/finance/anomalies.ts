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

  return { count, refresh }
})
