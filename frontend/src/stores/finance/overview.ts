import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useOverviewStore = defineStore('finance.overview', () => {
  const data = ref<api.OverviewResponse | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      data.value = await api.getOverview()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function save(sections: api.SaveOverviewSection[]) {
    saving.value = true
    error.value = null
    try {
      await api.saveOverview(sections)
      await refresh()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      saving.value = false
    }
  }

  return { data, loading, saving, error, refresh, save }
})
