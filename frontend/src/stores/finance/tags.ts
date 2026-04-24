import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useTagsStore = defineStore('finance.tags', () => {
  const items = ref<api.Tag[]>([])
  const loading = ref(false)

  async function refresh(source: 'user' | 'ai' | 'all' = 'user') {
    loading.value = true
    try {
      const resp = await api.listTags(source)
      items.value = resp.items
    } finally {
      loading.value = false
    }
  }

  return { items, loading, refresh }
})
