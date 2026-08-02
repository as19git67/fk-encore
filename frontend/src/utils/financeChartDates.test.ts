import { describe, it, expect } from 'vitest'
import {
  compactDateLabels,
  formatCompactDate,
  fullDateLabel,
  pickCompactDateStyle,
} from './financeChartDates'

describe('financeChartDates (#887)', () => {
  it('drops the year while the series stays inside one calendar year', () => {
    const dates = ['2026-01-05', '2026-04-20', '2026-07-19']
    expect(pickCompactDateStyle(dates)).toBe('day-month')
    expect(compactDateLabels(dates)).toEqual(['05.01.', '20.04.', '19.07.'])
  })

  it('falls back to month/year when there is at most one point per month', () => {
    const dates = ['2025-11-30', '2025-12-31', '2026-01-31']
    expect(pickCompactDateStyle(dates)).toBe('month-year')
    expect(compactDateLabels(dates)).toEqual(['11/25', '12/25', '01/26'])
  })

  it('keeps the day with a short year for dense multi-year series', () => {
    const dates = ['2025-12-01', '2025-12-20', '2026-01-10']
    expect(pickCompactDateStyle(dates)).toBe('day-month-year')
    expect(compactDateLabels(dates)).toEqual(['01.12.25', '20.12.25', '10.01.26'])
  })

  it('handles empty and unparsable input without throwing', () => {
    expect(compactDateLabels([])).toEqual([])
    expect(pickCompactDateStyle(['n/a'])).toBe('day-month')
    expect(formatCompactDate('n/a', 'month-year')).toBe('n/a')
    expect(fullDateLabel('n/a')).toBe('n/a')
  })

  it('formats the full tooltip date with a four-digit year', () => {
    expect(fullDateLabel('2026-07-19')).toBe('19.07.2026')
    expect(fullDateLabel('2026-07-19T00:00:00Z')).toBe('19.07.2026')
  })
})
