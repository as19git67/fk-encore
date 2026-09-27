import { describe, expect, it } from 'vitest'
import {
  deflate,
  describeTimeRef,
  describeWhen,
  effectiveMilestone,
  formatEur,
  summarizeItem,
  withAlpha,
} from './forecastModel'
import type { ForecastMilestone, ForecastPerson, ForecastScenarioConfig } from '../../../api/finance'

const persons: ForecastPerson[] = [
  { id: 1, label: 'A', birthDate: '1970-01-01', sortOrder: 0 },
  { id: 2, label: 'B', birthDate: '1972-01-01', sortOrder: 1 },
]
const milestone: ForecastMilestone = { id: 5, personId: 1, kind: 'leave_work', label: 'Ausstieg', date: null, age: 63 }
const config = { milestoneOverrides: {} } as unknown as ForecastScenarioConfig

describe('forecastModel', () => {
  it('deflates nominal amounts to today', () => {
    expect(deflate(121, 2028, 2026, 0.1)).toBeCloseTo(100, 9)
  })

  it('lets a scenario override win over the stored milestone', () => {
    expect(effectiveMilestone(milestone, config)).toEqual({ date: null, age: 63 })
    const moved = { milestoneOverrides: { '5': { age: 60, date: null } } } as unknown as ForecastScenarioConfig
    expect(effectiveMilestone(milestone, moved)).toEqual({ date: null, age: 60 })
    const dated = { milestoneOverrides: { '5': { date: '2031-05-01' } } } as unknown as ForecastScenarioConfig
    expect(effectiveMilestone(milestone, dated)).toEqual({ date: '2031-05-01', age: null })
  })

  it('describes points in time in German', () => {
    expect(describeWhen({ date: null, age: 63 })).toBe('mit 63')
    expect(describeWhen({ date: '2031-05-01', age: null })).toBe('am 01.05.2031')
    expect(describeTimeRef(null, [milestone], persons, 'Ab sofort')).toBe('Ab sofort')
    expect(describeTimeRef({ kind: 'milestone', milestoneId: 5 }, [milestone], persons, '')).toBe('Ausstieg (A)')
    expect(describeTimeRef({ kind: 'milestone', milestoneId: 9 }, [milestone], persons, '')).toBe('Zeitpunkt fehlt')
    expect(describeTimeRef({ kind: 'age', personId: 2, age: 65 }, [], persons, '')).toBe('B mit 65')
  })

  it('names the end of an item where it is set', () => {
    const ctx = { milestones: [milestone], persons }
    const clean = (t: string) => t.replace(/ /g, ' ')
    // An end is exclusive: 2031-07-01 means the last month is 06/2031.
    expect(clean(summarizeItem('expense', { amount: 900, frequency: 'monthly', end: { kind: 'date', date: '2031-07-01' } }, null, ctx))).toMatch(/, bis 06\/2031$/)
    expect(clean(summarizeItem('expense', { amount: 900, frequency: 'monthly' }, null, ctx))).not.toMatch(/bis/)
    expect(clean(summarizeItem('salary', { amount: 3000, end: { kind: 'milestone', milestoneId: 5 } }, null, ctx))).toBe('3.000 € / Monat, bis Ausstieg (A)')
    // A salary without an end stops when its person leaves work.
    expect(clean(summarizeItem('salary', { amount: 3000 }, null, ctx))).toBe('3.000 € / Monat, bis Ausstieg')
    expect(clean(summarizeItem('pension', { monthlyAmount: 500, start: { kind: 'age', personId: 1, age: 67 } }, null, ctx))).toBe('500 € / Monat, ab A mit 67')
    expect(clean(summarizeItem('life_insurance', { surrenderValue: 1000, projectedPayout: 2000, maturity: { kind: 'date', date: '2032-12-01' } }, null, ctx))).toBe(
      'Rückkauf 1.000 €, Ablauf 12/2032: 2.000 €',
    )
    expect(clean(summarizeItem('asset', { currentValue: 10, monthlyContribution: 50, contributionEnd: { kind: 'date', date: '2030-01-01' } }, null, ctx))).toBe(
      '10 €, Sparrate bis 12/2029',
    )
    // Without the context nothing changes.
    expect(clean(summarizeItem('salary', { amount: 3000 }, null))).toBe('3.000 € / Monat')
  })

  it('formats money without cents by default', () => {
    expect(formatEur(1234.56).replace(/ /g, ' ')).toBe('1.235 €')
    expect(formatEur(null)).toBe('–')
  })

  it('summarises items and prefers the linked balance', () => {
    expect(summarizeItem('asset', { currentValue: 5 }, 1234).replace(/ /g, ' ')).toBe('1.234 € (aus Konto)')
    expect(summarizeItem('salary', { amount: 3000 }, null).replace(/ /g, ' ')).toBe('3.000 € / Monat')
  })

  it('turns a hex colour into rgba and leaves others alone', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)')
  })
})
