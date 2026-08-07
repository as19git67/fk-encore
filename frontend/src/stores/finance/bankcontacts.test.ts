import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import * as api from '../../api/finance'
import { useBankcontactsStore } from './bankcontacts'

vi.mock('../../api/finance', () => ({
  listBankcontacts: vi.fn(),
  triggerSync: vi.fn(),
  completeTan: vi.fn(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.listBankcontacts).mockResolvedValue({ items: [] } as never)
  vi.mocked(api.triggerSync).mockReset()
  vi.mocked(api.completeTan).mockReset()
})

async function openTanDialog() {
  const store = useBankcontactsStore()
  vi.mocked(api.triggerSync).mockResolvedValue({
    state: 'tan-required',
    tanReference: 'session-uuid',
    challenge: 'photoTAN scannen',
  } as never)
  await store.syncNow(7)
  return store
}

describe('finance/bankcontacts store — TAN flow', () => {
  it('opens the dialog on tan-required', async () => {
    const store = await openTanDialog()
    expect(store.pendingTan).toMatchObject({
      bankcontactId: 7,
      tanReference: 'session-uuid',
      challenge: 'photoTAN scannen',
      challengeSeq: 0,
    })
    expect(store.tanError).toBeNull()
  })

  it('keeps the dialog open and surfaces the reason when the TAN is rejected', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({
      state: 'error',
      errorCode: '9942',
      errorMessage: 'TAN ungültig',
    } as never)

    await store.submitTan('123456')

    // The session is gone server-side, but the dialog must stay up so
    // the user learns the TAN was not accepted — closing silently made
    // a rejection look like success until the next sync asked again.
    expect(store.pendingTan).not.toBeNull()
    expect(store.tanError).toBe('9942: TAN ungültig')
  })

  it('bumps challengeSeq for a follow-up challenge on the same session', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({
      state: 'tan-required',
      tanReference: 'session-uuid',
      challenge: 'Noch eine TAN',
    } as never)

    await store.submitTan('123456')

    expect(store.pendingTan).toMatchObject({
      tanReference: 'session-uuid',
      challenge: 'Noch eine TAN',
      challengeSeq: 1,
    })
    expect(store.tanError).toBeNull()
  })

  it('closes the dialog and clears the error on success', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({ state: 'idle' } as never)

    await store.submitTan('123456')

    expect(store.pendingTan).toBeNull()
    expect(store.tanError).toBeNull()
    expect(api.listBankcontacts).toHaveBeenCalled()
  })

  it('refreshes the row so a completed TAN clears "tan-required"', async () => {
    vi.mocked(api.listBankcontacts).mockResolvedValue({
      items: [{ id: 7, name: 'Testbank', last_sync_status: 'tan-required' }],
    } as never)
    const store = await openTanDialog()
    expect(store.items[0]?.last_sync_status).toBe('tan-required')

    vi.mocked(api.listBankcontacts).mockResolvedValue({
      items: [{ id: 7, name: 'Testbank', last_sync_status: 'ok' }],
    } as never)
    vi.mocked(api.completeTan).mockResolvedValue({ state: 'idle' } as never)

    await store.submitTan('123456')

    // Views read the row out of `items` — a stale copy here is what
    // left the detail page showing "TAN offen" until a page reload.
    expect(store.items[0]?.last_sync_status).toBe('ok')
  })

  it('does not report a result while the TAN is still outstanding', async () => {
    const store = await openTanDialog()
    // tan-required is not an outcome — the view must keep showing the
    // pre-TAN state until the dialog resolves one way or the other.
    expect(store.lastSyncResult).toBeNull()
  })

  it('reports the sync outcome after the TAN completes it', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({
      state: 'idle',
      accounts_matched: 3,
      transactions_inserted: 12,
    } as never)

    await store.submitTan('123456')

    // The sync was started by the detail view but finished inside the
    // TAN dialog; without this the view kept rendering "TAN offen"
    // until the page was reloaded.
    expect(store.lastSyncResult).toMatchObject({
      bankcontactId: 7,
      seq: 1,
      response: { state: 'idle', accounts_matched: 3, transactions_inserted: 12 },
    })
  })

  it('reports a terminal TAN failure as a sync outcome too', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({
      state: 'error',
      errorCode: 'live-client-evicted',
      errorMessage: 'Sitzung geschlossen',
    } as never)

    await store.submitTan('123456')

    expect(store.lastSyncResult).toMatchObject({
      bankcontactId: 7,
      response: { state: 'error', errorCode: 'live-client-evicted' },
    })
  })

  it('bumps seq so two identical outcomes stay distinguishable', async () => {
    const store = useBankcontactsStore()
    vi.mocked(api.triggerSync).mockResolvedValue({ state: 'idle' } as never)

    await store.syncNow(7)
    expect(store.lastSyncResult?.seq).toBe(1)

    await store.syncNow(7)
    expect(store.lastSyncResult?.seq).toBe(2)
  })

  it('clears both dialog state and error on cancel', async () => {
    const store = await openTanDialog()
    vi.mocked(api.completeTan).mockResolvedValue({
      state: 'error',
      errorCode: 'live-client-evicted',
      errorMessage: 'Sitzung geschlossen',
    } as never)
    await store.submitTan('123456')

    store.cancelTan()

    expect(store.pendingTan).toBeNull()
    expect(store.tanError).toBeNull()
  })
})
