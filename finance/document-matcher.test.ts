import { describe, expect, it } from 'vitest'
import {
  documentMatchDateRange,
  extractDocumentAmount,
  isWithinDocumentMatchWindow,
  resolveDocumentMatchAmount,
  scoreDocumentMatch,
} from './document-matcher'

describe('scoreDocumentMatch', () => {
  const transaction = { amount: -42.5, bookingDate: '2026-06-10', counterparty: 'Bäckerei Müller', purpose: 'Rechnung 4711' }
  it('extracts explicitly labelled German invoice totals', () => { expect(extractDocumentAmount('Gesamtbetrag: 1.234,56 EUR')).toBe(1234.56) })
  it('extracts common receipt total labels', () => {
    expect(extractDocumentAmount('SUMME | EUR | 11,79')).toBe(11.79)
    expect(extractDocumentAmount('Total 8.80 EUR')).toBe(8.80)
    expect(extractDocumentAmount('Bruttoumsatz *7,69 EUR')).toBe(7.69)
  })
  it('prefers the structured Paddle receipt amount and falls back to OCR text', () => {
    expect(resolveDocumentMatchAmount('8.80', 'Bar 10,00')).toBe(8.80)
    expect(resolveDocumentMatchAmount(null, 'Summe 12,34 EUR')).toBe(12.34)
  })
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
  it('passes the suggestion threshold using only exact amount and nearby date', () => {
    const score = scoreDocumentMatch(
      { amount: -8.80, bookingDate: '2026-06-30' },
      { amount: 8.80, documentDate: '2026-06-29' },
    )
    expect(score.amount).toBe(1)
    expect(score.text).toBe(0)
    expect(score.total).toBeGreaterThanOrEqual(0.45)
  })
})

describe('document match date window', () => {
  it('builds an inclusive seven-day range', () => {
    expect(documentMatchDateRange('2026-06-15 12:00:00')).toEqual({
      from: '2026-06-08',
      to: '2026-06-22',
    })
    expect(isWithinDocumentMatchWindow('2026-06-15', '2026-06-08')).toBe(true)
    expect(isWithinDocumentMatchWindow('2026-06-15', '2026-06-22')).toBe(true)
  })

  it('rejects older and undated documents', () => {
    expect(isWithinDocumentMatchWindow('2026-06-15', '2011-06-15')).toBe(false)
    expect(isWithinDocumentMatchWindow('2026-06-15', null)).toBe(false)
  })
})
