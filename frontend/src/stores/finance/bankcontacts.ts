import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useBankcontactsStore = defineStore('finance.bankcontacts', () => {
  const items = ref<api.Bankcontact[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Pending TAN challenge — set while the TAN dialog is open. */
  const pendingTan = ref<{
    bankcontactId: number
    tanReference: string
    challenge: string
    tanMediaName?: string
  } | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      const resp = await api.listBankcontacts()
      items.value = resp.items
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function create(input: api.CreateBankcontactInput) {
    const created = await api.createBankcontact(input)
    items.value = [...items.value, created]
    return created
  }

  async function update(id: number, input: api.UpdateBankcontactInput) {
    const updated = await api.updateBankcontact(id, input)
    items.value = items.value.map((b) => (b.id === id ? updated : b))
    return updated
  }

  async function remove(id: number) {
    await api.deleteBankcontact(id)
    items.value = items.value.filter((b) => b.id !== id)
  }

  async function setCredentials(id: number, pin: string) {
    await api.setBankcontactCredentials(id, pin)
    items.value = items.value.map((b) =>
      b.id === id ? { ...b, credentials_set: true } : b,
    )
  }

  /**
   * Trigger a sync for a bankcontact. On tan-required the TAN dialog
   * state is populated — components watch `pendingTan` to know when
   * to open the dialog.
   */
  async function syncNow(id: number): Promise<api.SyncResponse> {
    const resp = await api.triggerSync(id)
    if (resp.state === 'tan-required') {
      pendingTan.value = {
        bankcontactId: id,
        tanReference: resp.tanReference,
        challenge: resp.challenge,
        tanMediaName: resp.tanMediaName,
      }
    }
    // Pull the fresh row so last_sync_at / status update in the UI.
    await refresh()
    return resp
  }

  async function submitTan(tan?: string): Promise<api.SyncResponse> {
    if (!pendingTan.value) throw new Error('no TAN challenge pending')
    const resp = await api.completeTan(pendingTan.value.tanReference, tan)
    if (resp.state === 'tan-required') {
      // Bank returned a fresh challenge for the same session — keep dialog open.
      pendingTan.value = {
        ...pendingTan.value,
        tanReference: resp.tanReference,
        challenge: resp.challenge,
        tanMediaName: resp.tanMediaName,
      }
    } else {
      pendingTan.value = null
      await refresh()
    }
    return resp
  }

  function cancelTan() {
    pendingTan.value = null
  }

  return {
    items,
    loading,
    error,
    pendingTan,
    refresh,
    create,
    update,
    remove,
    setCredentials,
    syncNow,
    submitTan,
    cancelTan,
  }
})
