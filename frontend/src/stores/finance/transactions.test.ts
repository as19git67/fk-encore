import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Transaction } from '../../api/finance'
import { useTransactionsStore } from './transactions'

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
  } as Transaction
}

describe('finance.transactions store — basket sync (#886)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('syncFrom applies edits made elsewhere to the displayed page', () => {
    const store = useTransactionsStore()
    store.items = [makeTx(1), makeTx(2), makeTx(3)]

    store.syncFrom([
      makeTx(2, { notice: 'geprüft', counterparty: 'Neu GmbH' }),
    ])

    expect(store.items.map((t) => t.notice)).toEqual([null, 'geprüft', null])
    expect(store.items[1]!.counterparty).toBe('Neu GmbH')
    // Untouched rows keep their identity — no needless re-render churn.
    expect(store.items[0]!.counterparty).toBe('Acme')
  })

  it('syncFrom ignores ids that are not on the current page', () => {
    const store = useTransactionsStore()
    store.items = [makeTx(1), makeTx(2)]
    const before = store.items

    store.syncFrom([makeTx(99, { notice: 'anderes Konto' })])

    // Same array instance: nothing on the page changed, so no re-render.
    expect(store.items).toBe(before)
    expect(store.items).toHaveLength(2)
  })

  it('syncFrom is a no-op for an empty update set', () => {
    const store = useTransactionsStore()
    store.items = [makeTx(1)]
    const before = store.items

    store.syncFrom([])

    expect(store.items).toBe(before)
  })

  it('patch applies the same change to several ids', () => {
    const store = useTransactionsStore()
    store.items = [makeTx(1), makeTx(2), makeTx(3)]

    store.patch([1, 3], { is_tax_relevant: true })

    expect(store.items.map((t) => !!t.is_tax_relevant)).toEqual([
      true,
      false,
      true,
    ])
  })

  it('patch ignores ids outside the current page', () => {
    const store = useTransactionsStore()
    store.items = [makeTx(1)]
    const before = store.items

    store.patch([42], { notice: 'x' })

    expect(store.items).toBe(before)
  })
})
