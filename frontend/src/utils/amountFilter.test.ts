import { describe, expect, it } from 'vitest'
import { amountRangeLabel, directionLabel, parseAmountQuery, parseDirectionQuery } from './amountFilter'

// Intl puts a narrow no-break space before the euro sign.
const norm = (s: string | null) => s?.replace(/\s/g, ' ') ?? null

describe('amountRangeLabel', () => {
  it('names a range, an open lower and an open upper bound', () => {
    expect(norm(amountRangeLabel(100, 500))).toBe('Betrag: 100,00 € – 500,00 €')
    expect(norm(amountRangeLabel(100, null))).toBe('Betrag: ab 100,00 €')
    expect(norm(amountRangeLabel(null, 12.5))).toBe('Betrag: bis 12,50 €')
  })

  it('keeps a zero bound', () => {
    expect(norm(amountRangeLabel(0, null))).toBe('Betrag: ab 0,00 €')
  })

  it('is null without bounds', () => {
    expect(amountRangeLabel(null, null)).toBeNull()
  })
})

describe('query parsing', () => {
  it('reads amounts with comma or dot and rejects the rest', () => {
    expect(parseAmountQuery('12,50')).toBe(12.5)
    expect(parseAmountQuery('100')).toBe(100)
    expect(parseAmountQuery('-5')).toBeNull()
    expect(parseAmountQuery('abc')).toBeNull()
    expect(parseAmountQuery('')).toBeNull()
    expect(parseAmountQuery(undefined)).toBeNull()
  })

  it('reads only the two directions', () => {
    expect(parseDirectionQuery('in')).toBe('in')
    expect(parseDirectionQuery('out')).toBe('out')
    expect(parseDirectionQuery('both')).toBeNull()
    expect(directionLabel('out')).toBe('Nur Ausgänge')
  })
})
