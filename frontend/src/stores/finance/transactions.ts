import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useTransactionsStore = defineStore('finance.transactions', () => {
  const items = ref<api.Transaction[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function refresh(q: api.ListTransactionsQuery = {}) {
    loading.value = true
    error.value = null
    try {
      const resp = await api.listTransactions(q)
      items.value = resp.items
      total.value = resp.total
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function create(input: api.CreateTransactionInput) {
    const created = await api.createTransaction(input)
    items.value = [created, ...items.value]
    total.value = total.value + 1
    return created
  }

  async function promoteAiTag(id: number, tag: string) {
    const resp = await api.promoteAiTag(id, tag)
    items.value = items.value.map((t) =>
      t.id === id ? { ...t, tags: resp.tags } : t,
    )
    return resp
  }

  async function batchTag(input: api.BatchTagInput) {
    const resp = await api.batchTag(input)
    // Cheapest correct update: reload the current page.
    return resp
  }

  return {
    items,
    total,
    loading,
    error,
    refresh,
    create,
    promoteAiTag,
    batchTag,
  }
})
