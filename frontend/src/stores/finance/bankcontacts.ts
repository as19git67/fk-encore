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
    tanPhotoMime?: string
    tanPhotoBase64?: string
    /**
     * Bumped on every fresh challenge the bank sends for the same
     * session. `tanReference` is *our* session UUID and stays the same
     * across follow-ups, so it can't be used to tell "new challenge"
     * apart from "same challenge" — the dialog watches this instead to
     * clear the input field.
     */
    challengeSeq: number
  } | null>(null)

  /**
   * Terminal error of the last TAN submit (wrong TAN, dialog aborted,
   * live session gone). The backend deletes the session in that case,
   * so there is nothing left to submit — but the dialog stays open to
   * actually show the reason. Previously the store cleared `pendingTan`
   * here, the dialog vanished before rendering the message, and the
   * failure looked exactly like success until the next sync asked for
   * a TAN again.
   */
  const tanError = ref<string | null>(null)

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
    const resp = await api.deleteBankcontact(id)
    items.value = items.value.filter((b) => b.id !== id)
    return resp
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
      tanError.value = null
      pendingTan.value = {
        bankcontactId: id,
        tanReference: resp.tanReference,
        challenge: resp.challenge,
        tanMediaName: resp.tanMediaName,
        tanPhotoMime: resp.tanPhotoMime,
        tanPhotoBase64: resp.tanPhotoBase64,
        challengeSeq: 0,
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
      tanError.value = null
      pendingTan.value = {
        ...pendingTan.value,
        tanReference: resp.tanReference,
        challenge: resp.challenge,
        tanMediaName: resp.tanMediaName,
        tanPhotoMime: resp.tanPhotoMime,
        tanPhotoBase64: resp.tanPhotoBase64,
        challengeSeq: pendingTan.value.challengeSeq + 1,
      }
    } else if (resp.state === 'error') {
      // Keep the dialog open so the user sees *why* it failed; the
      // session is gone on the server, so the dialog only offers
      // "Schließen" from here (see TanDialog).
      tanError.value = `${resp.errorCode ?? 'error'}: ${
        resp.errorMessage ?? 'TAN-Dialog fehlgeschlagen'
      }`
      await refresh()
    } else {
      tanError.value = null
      pendingTan.value = null
      await refresh()
    }
    return resp
  }

  function cancelTan() {
    pendingTan.value = null
    tanError.value = null
  }

  return {
    items,
    loading,
    error,
    pendingTan,
    tanError,
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
