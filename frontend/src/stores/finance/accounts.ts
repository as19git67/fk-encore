import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '../../api/finance'

export const useAccountsStore = defineStore('finance.accounts', () => {
  const items = ref<api.Account[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** True once a list has come back from the server at least once. */
  const loaded = ref(false)
  let pending: Promise<void> | null = null

  /**
   * Whether any account the user may read is a depot. Kurse and Portfolio
   * only make sense with one, so the menu and the routes hide them without.
   * The server already filters the list by the ACL (admins see every
   * account), so this is exactly "a depot among the readable accounts".
   */
  const hasDepot = computed(() => items.value.some((a) => a.type_kind === 'depot'))

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      const resp = await api.listAccounts()
      items.value = resp.items
      loaded.value = true
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

  async function remove(id: number) {
    const resp = await api.deleteAccount(id)
    items.value = items.value.filter((a) => a.id !== id)
    return resp
  }

  async function link(id: number, input: api.LinkAccountInput) {
    const linked = await api.linkAccount(id, input)
    items.value = items.value.map((a) => (a.id === id ? linked : a))
    return linked
  }

  async function unlink(id: number) {
    const unlinked = await api.unlinkAccount(id)
    items.value = items.value.map((a) => (a.id === id ? unlinked : a))
    return unlinked
  }

  /** Loads the list once; later calls reuse it (or the request in flight). */
  async function ensureLoaded() {
    if (loaded.value) return
    pending ??= refresh().finally(() => {
      pending = null
    })
    await pending
  }

  /** Forgets the list, e.g. when the user signs out. */
  function reset() {
    items.value = []
    loaded.value = false
  }

  function byId(id: number): api.Account | undefined {
    return items.value.find((a) => a.id === id)
  }

  return {
    items,
    loading,
    error,
    loaded,
    hasDepot,
    refresh,
    ensureLoaded,
    reset,
    create,
    update,
    remove,
    link,
    unlink,
    byId,
  }
})
