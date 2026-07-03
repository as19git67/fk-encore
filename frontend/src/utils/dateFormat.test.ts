import { describe, expect, it } from 'vitest'
import { parseLocalDate, toLocalIsoDate } from './dateFormat'

describe('local date-only conversion', () => {
  it('round-trips a finance booking date without UTC or today fallback', () => {
    const parsed = parseLocalDate('2026-06-24')

    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(5)
    expect(parsed.getDate()).toBe(24)
    expect(toLocalIsoDate(parsed)).toBe('2026-06-24')
  })
})
