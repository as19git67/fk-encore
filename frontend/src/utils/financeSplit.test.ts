import { describe, expect, it } from 'vitest'
import {
  amountSeparators,
  applySplitSign,
  defaultSplitMagnitudes,
  formatAmountForInput,
  isSplitBalanced,
  parseLocalizedAmount,
  splitDifference,
  splitMagnitude,
} from './financeSplit'

describe('amountSeparators', () => {
  it('reports comma/dot for German', () => {
    expect(amountSeparators('de-DE')).toEqual({ decimal: ',', group: '.' })
  })

  it('reports dot/comma for English', () => {
    expect(amountSeparators('en-US')).toEqual({ decimal: '.', group: ',' })
  })
})

describe('parseLocalizedAmount', () => {
  it('reads the comma as decimal separator in German', () => {
    expect(parseLocalizedAmount('18,90')).toBe(18.9)
  })

  it('ignores the thousands separator', () => {
    expect(parseLocalizedAmount('1.234,50')).toBe(1234.5)
    expect(parseLocalizedAmount('1.234.567,89')).toBe(1234567.89)
  })

  it('reads the dot as decimal separator in English', () => {
    expect(parseLocalizedAmount('1,234.50', 'en-US')).toBe(1234.5)
  })

  it('accepts input without a fractional part', () => {
    expect(parseLocalizedAmount('42')).toBe(42)
    expect(parseLocalizedAmount('42,')).toBe(42)
  })

  it('accepts input without an integer part', () => {
    expect(parseLocalizedAmount(',75')).toBe(0.75)
  })

  it('drops any sign the user types — magnitudes are always positive', () => {
    expect(parseLocalizedAmount('-18,90')).toBe(18.9)
    expect(parseLocalizedAmount('+18,90')).toBe(18.9)
  })

  it('strips currency symbols and whitespace', () => {
    expect(parseLocalizedAmount(' 1.234,50 € ')).toBe(1234.5)
  })

  it('keeps only the first decimal separator', () => {
    expect(parseLocalizedAmount('1,2,3')).toBe(1.23)
  })

  it('returns null when there is no digit at all', () => {
    expect(parseLocalizedAmount('')).toBeNull()
    expect(parseLocalizedAmount('  ')).toBeNull()
    expect(parseLocalizedAmount('abc')).toBeNull()
  })
})

describe('formatAmountForInput', () => {
  it('formats with the locale decimal separator and two digits', () => {
    expect(formatAmountForInput(18.9)).toBe('18,90')
    expect(formatAmountForInput(1234.5, 'en-US')).toBe('1234.50')
  })

  it('formats stored negatives as positive magnitudes', () => {
    expect(formatAmountForInput(-18.9)).toBe('18,90')
  })

  it('round-trips through the parser', () => {
    expect(parseLocalizedAmount(formatAmountForInput(1234.56))).toBe(1234.56)
  })
})

describe('splitMagnitude', () => {
  it('turns stored amounts into unsigned edit values', () => {
    expect(splitMagnitude('-18.90')).toBe(18.9)
    expect(splitMagnitude(18.9)).toBe(18.9)
  })

  it('falls back to 0 for unusable values', () => {
    expect(splitMagnitude('nope')).toBe(0)
  })
})

describe('applySplitSign', () => {
  it('makes parts of an expense negative', () => {
    expect(applySplitSign(18.9, '-45.00')).toBe(-18.9)
  })

  it('keeps parts of an income positive', () => {
    expect(applySplitSign(18.9, '45.00')).toBe(18.9)
  })

  it('ignores a sign that slipped into the magnitude', () => {
    expect(applySplitSign(-18.9, '-45.00')).toBe(-18.9)
    expect(applySplitSign(-18.9, '45.00')).toBe(18.9)
  })
})

describe('splitDifference', () => {
  it('reports what is left to distribute for an expense', () => {
    expect(splitDifference('-45.00', [18.9, 20])).toBe(6.1)
  })

  it('reports the overshoot as a negative remainder', () => {
    expect(splitDifference('-45.00', [40, 10])).toBe(-5)
  })

  it('is zero for a balanced split', () => {
    expect(splitDifference('-45.00', [18.9, 26.1])).toBe(0)
    expect(isSplitBalanced('-45.00', [18.9, 26.1])).toBe(true)
  })

  it('does not accumulate float drift', () => {
    expect(splitDifference('-0.30', [0.1, 0.1, 0.1])).toBe(0)
  })

  it('rejects unbalanced splits', () => {
    expect(isSplitBalanced('-45.00', [18.9, 20])).toBe(false)
  })
})

describe('defaultSplitMagnitudes', () => {
  it('halves the transaction amount', () => {
    expect(defaultSplitMagnitudes('-45.00')).toEqual([22.5, 22.5])
  })

  it('puts the rounding remainder on the second row', () => {
    const rows = defaultSplitMagnitudes('-0.05')
    expect(rows).toEqual([0.03, 0.02])
    expect(isSplitBalanced('-0.05', rows)).toBe(true)
  })

  it('starts balanced for incomes too', () => {
    expect(isSplitBalanced('99.99', defaultSplitMagnitudes('99.99'))).toBe(true)
  })
})
