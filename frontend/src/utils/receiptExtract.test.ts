import { describe, it, expect } from 'vitest'
import { extractReceiptAmount, extractReceiptDate } from './receiptExtract'

describe('extractReceiptAmount', () => {
  it('extracts labelled total', () => {
    expect(extractReceiptAmount('Summe 12,50 EUR')).toBe(12.5)
  })

  it('extracts Gesamtbetrag', () => {
    expect(extractReceiptAmount('Gesamtbetrag: 1.234,56')).toBe(1234.56)
  })

  it('extracts Kartenzahlung', () => {
    expect(extractReceiptAmount('Kartenzahlung   47,11')).toBe(47.11)
  })

  it('extracts EC-Cash', () => {
    expect(extractReceiptAmount('EC-Cash 9,99')).toBe(9.99)
  })

  it('falls back to last plausible amount', () => {
    expect(extractReceiptAmount('Artikel 2,00\nArtikel 3,50\n5,50')).toBe(5.5)
  })

  it('handles thousands separators', () => {
    expect(extractReceiptAmount('Total 2.500,00')).toBe(2500)
  })

  it('returns null for empty text', () => {
    expect(extractReceiptAmount('')).toBeNull()
    expect(extractReceiptAmount(null)).toBeNull()
  })
})

describe('extractReceiptDate', () => {
  it('extracts dd.mm.yyyy', () => {
    expect(extractReceiptDate('Datum: 15.03.2025')).toBe('2025-03-15')
  })

  it('extracts dd.mm.yy (two-digit year)', () => {
    expect(extractReceiptDate('25.12.24')).toBe('2024-12-25')
  })

  it('picks closest date to now from multiple matches', () => {
    const result = extractReceiptDate('01.01.2020\n26.06.2026')
    expect(result).toBe('2026-06-26')
  })

  it('rejects invalid month', () => {
    expect(extractReceiptDate('15.13.2025')).toBeNull()
  })

  it('rejects invalid day', () => {
    expect(extractReceiptDate('32.01.2025')).toBeNull()
  })

  it('returns null for empty text', () => {
    expect(extractReceiptDate('')).toBeNull()
    expect(extractReceiptDate(null)).toBeNull()
  })

  it('handles spaces in date', () => {
    expect(extractReceiptDate('15. 03. 2025')).toBe('2025-03-15')
  })
})
