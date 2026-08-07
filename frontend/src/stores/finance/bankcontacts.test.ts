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
