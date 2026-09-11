import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listMeterAnomalies } from '../api/meters'

/** Pending meter anomalies, for the badge on the "Auffälligkeiten" menu item. */
export const useMeterAnomalyStore = defineStore('meterAnomalies', () => {
  const count = ref(0)

  async function refresh() {
    try {
      const res = await listMeterAnomalies('pending')
      count.value = res.total
    } catch {
      // silently ignore – user may not have meters.view
    }
  }

  return { count, refresh }
})
