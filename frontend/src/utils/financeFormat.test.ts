import { describe, expect, it } from 'vitest'

import { formatQuoteTime, formatSplitRatio, priceOriginLabel } from './financeFormat'

describe('priceOriginLabel', () => {
  it('names the time of a quote and the day of a bank price', () => {
    const quote = priceOriginLabel({ price_source: 'quote', price_as_of: '2026-10-02', price_at: '2026-10-02T13:05:00.000Z' })
    expect(quote).toBe(`Kurs vom ${formatQuoteTime('2026-10-02T13:05:00.000Z')}`)
    expect(priceOriginLabel({ price_source: 'bank', price_as_of: '2026-09-30', price_at: null })).toBe('Kurs der Bank vom 30.09.2026')
    expect(priceOriginLabel({ price_source: null, price_as_of: null, price_at: null })).toBeNull()
  })

  it('shows a dash for a missing or broken timestamp', () => {
    expect(formatQuoteTime(null)).toBe('–')
    expect(formatQuoteTime('kein Datum')).toBe('–')
  })
})

describe('formatSplitRatio', () => {
  it('prints new shares per old one, reverse splits the other way round', () => {
    expect(formatSplitRatio(4)).toBe('4:1')
    expect(formatSplitRatio(0.1)).toBe('1:10')
    expect(formatSplitRatio(1 / 3)).toBe('1:3')
    expect(formatSplitRatio(null)).toBeNull()
  })
})
