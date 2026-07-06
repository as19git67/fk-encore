import { describe, expect, it } from 'vitest'
import type { Transaction } from '../api/finance'
import { compareBasketCounterparties } from './financeBasketCompare'

const tx = (id: number, counterparty: string, amount: string, currency_code = 'EUR') => ({ id, counterparty, amount, currency_code, account_id: 1, booking_date: '2026-01-01', tags: [] } as Transaction)

describe('compareBasketCounterparties', () => {
  it('returns absolute deltas per counterparty', () => {
    expect(compareBasketCounterparties([tx(1, 'A', '-10')], [tx(2, 'A', '-15'), tx(3, 'B', '-3')]).rows).toEqual([
      { label: 'A', a: -10, b: -15, delta: -5 }, { label: 'B', a: 0, b: -3, delta: -3 },
    ])
  })
  it('refuses pseudo totals across currencies', () => {
    expect(compareBasketCounterparties([tx(1, 'A', '1', 'EUR')], [tx(2, 'A', '1', 'USD')])).toEqual({ currencyMismatch: true, rows: [] })
  })
})
