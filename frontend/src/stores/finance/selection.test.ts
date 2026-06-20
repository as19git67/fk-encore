import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Transaction } from '../../api/finance'
import { useTxSelectionStore } from './selection'

const STORAGE_KEY = 'finance.txSelection.v1'

function makeTx(id: number, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    account_id: 1,
    booking_date: '2026-06-01',
    value_date: null,
    amount: '12.34',
    currency_code: 'EUR',
    purpose: null,
    counterparty: 'Acme',
    counterparty_iban: null,
    counterparty_bic: null,
    end_to_end_ref: null,
    mandate_ref: null,
    creditor_id: null,
    bank_ref: null,
    originator_name: null,
    recipient_name: null,
    funds_code: null,
    transaction_type: null,
    transaction_code: null,
    entry_text: null,
    prima_nota_no: null,
    original_amount: null,
    original_currency_code: null,
    exchange_rate: null,
    notice: null,
    tags: [],
    created_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  window.sessionStorage.clear()
  // Each test gets a fresh Pinia so module state does not leak.
  setActivePinia(createPinia())
})

describe('useTxSelectionStore — session persistence', () => {
  it('hydrates from sessionStorage on first instantiation', () => {
    const seeded = { version: 1, items: [makeTx(101), makeTx(102)] }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))

    const store = useTxSelectionStore()
    expect(store.ids).toEqual([101, 102])
    expect(store.count).toBe(2)
  })

  it('starts empty when storage has no entry', () => {
    const store = useTxSelectionStore()
    expect(store.items).toEqual([])
  })

  it('ignores stored payloads with the wrong version', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 999, items: [makeTx(1)] }),
    )
    const store = useTxSelectionStore()
    expect(store.items).toEqual([])
  })

  it('ignores malformed JSON in storage', () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{not json')
    const store = useTxSelectionStore()
    expect(store.items).toEqual([])
  })

  it('filters out entries without a numeric id', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        items: [makeTx(1), { id: 'oops' }, null, makeTx(2)],
      }),
    )
    const store = useTxSelectionStore()
    expect(store.ids).toEqual([1, 2])
  })

  it('persists on add', async () => {
    const store = useTxSelectionStore()
    store.add(makeTx(7))
    await nextTick()
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { version: number; items: Transaction[] }
    expect(parsed.version).toBe(1)
    expect(parsed.items.map((t) => t.id)).toEqual([7])
  })

  it('keeps existing basket entries when another transaction is added', async () => {
    const store = useTxSelectionStore()
    store.add(makeTx(7))
    store.add(makeTx(8))

    expect(store.ids).toEqual([7, 8])
    expect(store.count).toBe(2)

    await nextTick()
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!) as {
      items: Transaction[]
    }
    expect(parsed.items.map((t) => t.id)).toEqual([7, 8])
  })

  it('persists on toggle/remove and clears storage on empty', async () => {
    const store = useTxSelectionStore()
    store.add(makeTx(1))
    store.add(makeTx(2))
    await nextTick()
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()

    store.remove(1)
    await nextTick()
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!) as {
      items: Transaction[]
    }
    expect(parsed.items.map((t) => t.id)).toEqual([2])

    store.clear()
    await nextTick()
    // Empty selections clear the key to avoid orphan entries in storage.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('persists set() replacement wholesale', async () => {
    const store = useTxSelectionStore()
    store.set([makeTx(10), makeTx(11), makeTx(12)])
    await nextTick()
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!) as {
      items: Transaction[]
    }
    expect(parsed.items.map((t) => t.id)).toEqual([10, 11, 12])
  })

  it('survives a sessionStorage quota error without throwing', async () => {
    const store = useTxSelectionStore()
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function () {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
    try {
      expect(() => store.add(makeTx(42))).not.toThrow()
      await nextTick()
      // In-memory state stays consistent even though persistence failed.
      expect(store.ids).toEqual([42])
    } finally {
      Storage.prototype.setItem = originalSetItem
    }
  })
})
