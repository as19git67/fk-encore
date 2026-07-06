import { describe, expect, it } from 'vitest'
import type { Transaction } from '../api/finance'
import { detectRecurringSelection } from './financeRecurringSelection'

const tx = (id: number, date: string, amount: string, counterparty = 'Strom GmbH') => ({
  id, booking_date: date, amount, counterparty, currency_code: 'EUR', tags: [], account_id: 1,
} as Transaction)

describe('detectRecurringSelection', () => {
  it('recognises monthly payments with small amount changes', () => {
    const groups = detectRecurringSelection([
      tx(1, '2026-01-01', '-100.00'), tx(2, '2026-01-31', '-103.00'), tx(3, '2026-03-02', '-99.00'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ count: 3, averageIntervalDays: 30 })
  })

  it('recognises weekly cadence and rejects volatile amounts', () => {
    expect(detectRecurringSelection([
      tx(1, '2026-01-01', '-10'), tx(2, '2026-01-08', '-10'), tx(3, '2026-01-15', '-10'),
    ])).toHaveLength(1)
    expect(detectRecurringSelection([
      tx(1, '2026-01-01', '-10'), tx(2, '2026-02-01', '-20'), tx(3, '2026-03-01', '-30'),
    ])).toHaveLength(0)
  })
})
