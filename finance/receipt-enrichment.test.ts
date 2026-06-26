import { describe, expect, it } from 'vitest'
import { computeReceiptEnrichment } from './document-match.service'

describe('computeReceiptEnrichment', () => {
  const tx = { counterparty: 'Edeka', amount: '-12.50', booking_date: '2026-06-10' }

  it('returns no diff when document matches the transaction', () => {
    const diff = computeReceiptEnrichment(tx, { sender: 'Edeka', doc_date: '2026-06-10', amount: 12.5 })
    expect(diff).toEqual({})
  })

  it('suggests the sender when it differs (case/whitespace-insensitive match is ignored)', () => {
    const diff = computeReceiptEnrichment(tx, { sender: 'EDEKA  Müller GmbH', doc_date: '2026-06-10', amount: 12.5 })
    expect(diff.sender).toBe('EDEKA  Müller GmbH')
  })

  it('does not suggest the sender on a pure case/whitespace difference', () => {
    const diff = computeReceiptEnrichment(tx, { sender: '  edeka ', doc_date: '2026-06-10', amount: 12.5 })
    expect(diff.sender).toBeUndefined()
  })

  it('fills the sender when the counterparty is empty', () => {
    const diff = computeReceiptEnrichment(
      { counterparty: null, amount: '-12.50', booking_date: '2026-06-10' },
      { sender: 'Edeka', doc_date: '2026-06-10', amount: 12.5 },
    )
    expect(diff.sender).toBe('Edeka')
  })

  it('suggests the document date when it differs from the booking date', () => {
    const diff = computeReceiptEnrichment(tx, { sender: 'Edeka', doc_date: '2026-06-08', amount: 12.5 })
    expect(diff.doc_date).toBe('2026-06-08')
  })

  it('suggests the amount when it differs by more than a cent (sign ignored)', () => {
    const diff = computeReceiptEnrichment(tx, { sender: 'Edeka', doc_date: '2026-06-10', amount: 13.99 })
    expect(diff.amount).toBe('13.99')
  })

  it('ignores sub-cent amount differences', () => {
    const diff = computeReceiptEnrichment(tx, { sender: 'Edeka', doc_date: '2026-06-10', amount: 12.5 })
    expect(diff.amount).toBeUndefined()
  })

  it('ignores null document fields', () => {
    const diff = computeReceiptEnrichment(tx, { sender: null, doc_date: null, amount: null })
    expect(diff).toEqual({})
  })
})
