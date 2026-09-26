import { describe, expect, it } from 'vitest'
import type { ForecastItemStatements } from '../../../api/finance'
import { formatMonth, sourceText, statementBadge } from './forecastStatements'

const base: ForecastItemStatements = {
  itemId: 1,
  contractNo: 'X-000111',
  links: [],
  latest: null,
  proposals: [],
  history: [],
  valuesSource: null,
  overdue: false,
  reading: false,
  notes: [],
  declinedWithoutDocument: [],
}

describe('forecastStatements', () => {
  it('formats a month', () => {
    expect(formatMonth('2026-03-15')).toBe('03/2026')
    expect(formatMonth('2026-03-15T10:00:00Z')).toBe('03/2026')
  })

  it('names the source of values', () => {
    expect(sourceText(null)).toMatch(/unbekannt/)
    expect(sourceText({ kind: 'statement', referenceDate: '2026-01-01', updatedAt: '2026-02-01T00:00:00Z' })).toBe('Werte aus Standmitteilung 01/2026')
    expect(sourceText({ kind: 'import', updatedAt: '2026-09-20T00:00:00Z' })).toBe('Werte aus dem Excel-Import 09/2026')
    expect(sourceText({ kind: 'manual', updatedAt: '2026-08-01T00:00:00Z' })).toMatch(/von Hand/)
  })

  it('puts reading, differences and suggestions before the rest', () => {
    expect(statementBadge({ ...base, reading: true }).tone).toBe('info')
    const latest = { id: 1, documentId: 2, referenceDate: '2026-01-01', values: {} as never, method: 'regex' as const, status: 'proposed' as const, extractedAt: '' }
    const diff = statementBadge({
      ...base,
      latest,
      proposals: [{ field: 'surrenderValue', label: 'Rückkaufswert', kind: 'amount', current: 1, proposed: 2 }],
      overdue: true,
    })
    expect(diff).toEqual({ text: 'Standmitteilung 01/2026 · 1 Abweichung', tone: 'warn' })
    const link = { id: 1, documentId: 2, title: null, docDate: null, documentType: null, matchKind: 'text' as const, status: 'suggested' as const, kind: 'statement' as const, kindByUser: false }
    expect(statementBadge({ ...base, links: [link, { ...link, id: 2 }] }).text).toBe('2 Dokumente prüfen')
    expect(statementBadge({ ...base, overdue: true, latest: { ...latest, status: 'accepted' } }).text).toBe('Standmitteilung überfällig')
    expect(statementBadge({ ...base, latest: { ...latest, status: 'accepted' } }).tone).toBe('success')
    expect(statementBadge(base).text).toBe('Keine Standmitteilung gefunden')
  })
})
