import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Account } from '../../api/finance'

const listAccounts = vi.fn()
vi.mock('../../api/finance', () => ({ listAccounts: () => listAccounts() }))

import { useAccountsStore } from './accounts'

function account(id: number, type_kind: string): Account {
  return { id, type_kind, label: `Konto ${id}` } as Account
}

describe('accounts store: hasDepot', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listAccounts.mockReset()
  })

  it('is false without a depot among the readable accounts', async () => {
    listAccounts.mockResolvedValue({ items: [account(1, 'giro'), account(2, 'savings')] })
    const store = useAccountsStore()
    await store.ensureLoaded()
    expect(store.loaded).toBe(true)
    expect(store.hasDepot).toBe(false)
  })

  it('is true as soon as one readable account is a depot', async () => {
    listAccounts.mockResolvedValue({ items: [account(1, 'giro'), account(2, 'depot')] })
    const store = useAccountsStore()
    await store.ensureLoaded()
    expect(store.hasDepot).toBe(true)
  })

  it('loads only once and forgets the list on reset', async () => {
    listAccounts.mockResolvedValue({ items: [account(1, 'depot')] })
    const store = useAccountsStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    await store.ensureLoaded()
    expect(listAccounts).toHaveBeenCalledTimes(1)
    store.reset()
    expect(store.loaded).toBe(false)
    expect(store.hasDepot).toBe(false)
  })
})
