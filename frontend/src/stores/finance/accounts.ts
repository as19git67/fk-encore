import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useAccountsStore = defineStore('finance.accounts', () => {
  const items = ref<api.Account[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      const resp = await api.listAccounts()
      items.value = resp.items
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function create(input: api.CreateAccountInput) {
    const created = await api.createAccount(input)
    items.value = [...items.value, created]
    return created
  }

  async function update(id: number, input: api.UpdateAccountInput) {
    const updated = await api.updateAccount(id, input)
    items.value = items.value.map((a) => (a.id === id ? updated : a))
    return updated
  }

  function byId(id: number): api.Account | undefined {
    return items.value.find((a) => a.id === id)
  }

  return { items, loading, error, refresh, create, update, byId }
})
