import { describe, expect, it } from 'vitest'
import { scoreDocumentMatch } from './document-matcher'

describe('scoreDocumentMatch', () => {
  const transaction = { amount: -42.5, bookingDate: '2026-06-10', counterparty: 'Bäckerei Müller', purpose: 'Rechnung 4711' }
  it('scores an exact amount, near date and matching OCR text highly', () => {
    const score = scoreDocumentMatch(transaction, { amount: 42.5, documentDate: '2026-06-11', sender: 'Bäckerei Müller', text: 'Rechnung 4711' })
    expect(score.amount).toBe(1)
    expect(score.date).toBeGreaterThan(0.9)
    expect(score.text).toBeGreaterThan(0.5)
    expect(score.total).toBeGreaterThan(0.8)
  })
  it('does not suggest unrelated documents strongly', () => {
    const score = scoreDocumentMatch(transaction, { amount: 9.99, documentDate: '2025-01-01', sender: 'Stadtwerke', text: 'Gasabschlag' })
    expect(score.total).toBeLessThan(0.2)
  })
})
