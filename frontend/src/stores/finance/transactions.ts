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

  /**
   * Merge edits made outside the list (basket drawer, batch dialogs) into
   * the currently displayed page so the cards reflect them without a
   * reload — issue #886.
   *
   * Ids that aren't on the current page are ignored: they're simply not
   * visible, and pulling them in would break the active filter/scope.
   */
  function syncFrom(updated: api.Transaction[]) {
    if (updated.length === 0) return
    const byId = new Map(updated.map((tx) => [tx.id, tx]))
    if (!items.value.some((tx) => byId.has(tx.id))) return
    items.value = items.value.map((tx) => {
      const next = byId.get(tx.id)
      return next ? { ...tx, ...next } : tx
    })
  }

  /** Apply the same field changes to a set of ids on the current page. */
  function patch(ids: number[], changes: Partial<api.Transaction>) {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    if (!items.value.some((tx) => idSet.has(tx.id))) return
    items.value = items.value.map((tx) =>
      idSet.has(tx.id) ? { ...tx, ...changes } : tx,
    )
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
    syncFrom,
    patch,
  }
})
