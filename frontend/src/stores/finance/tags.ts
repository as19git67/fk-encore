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

  function addLocal(names: string[]) {
    for (const name of names) {
      if (!items.value.some((t) => t.name === name)) {
        items.value.push({ id: 0, name, source: 'user', created_at: null })
      }
    }
  }

  return { items, loading, refresh, addLocal }
})
