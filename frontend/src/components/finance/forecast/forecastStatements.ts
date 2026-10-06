import type { ForecastItemStatements, ForecastValuesSource } from '../../../api/finance'

/**
 * Wording for the Standmitteilungen of a forecast item (#1343), shared by
 * the item list and the statements dialog.
 */

/** "2026-03-15" → "03/2026" */
export function formatMonth(isoDate: string): string {
  const [y, m] = isoDate.slice(0, 7).split('-')
  return y && m ? `${m}/${y}` : isoDate
}

/** Where the values of an item come from, in one line. */
export function sourceText(src: ForecastValuesSource | null | undefined): string {
  if (!src) return 'Herkunft der Werte unbekannt'
  switch (src.kind) {
    case 'statement':
      return src.referenceDate ? `Werte aus Standmitteilung ${formatMonth(src.referenceDate)}` : 'Werte aus einer Standmitteilung'
    // The one-time spreadsheet import is gone; items it created still carry this source.
    case 'import':
      return `Werte aus dem Excel-Import ${formatMonth(src.updatedAt)}`
    case 'manual':
      return `Werte von Hand eingetragen ${formatMonth(src.updatedAt)}`
    case 'booking':
      return `Beitrag aus den Buchungen ${formatMonth(src.updatedAt)}`
  }
}

export type StatementBadgeTone = 'info' | 'warn' | 'success' | 'secondary'

export interface StatementBadge {
  text: string
  tone: StatementBadgeTone
}

/** Short status of an item's statements for its row in the list. */
export function statementBadge(s: ForecastItemStatements): StatementBadge {
  if (s.reading) return { text: 'Standmitteilung wird gelesen …', tone: 'info' }
  const b = s.bookings
  const bookingsToCheck = b.bookings.filter((x) => x.status === 'suggested').length
  const suggested = s.links.filter((l) => l.status === 'suggested').length
  const confirmed = s.links.filter((l) => l.status === 'confirmed').length
  const n = s.proposals.length
  if (n > 0) {
    const when = s.latest?.referenceDate ? ` ${formatMonth(s.latest.referenceDate)}` : ''
    return { text: `Standmitteilung${when} · ${n} Abweichung${n === 1 ? '' : 'en'}`, tone: 'warn' }
  }
  if (b.proposal) return { text: 'Beitrag laut Buchungen abweichend', tone: 'warn' }
  if (suggested > 0) return { text: `${suggested} Dokument${suggested === 1 ? '' : 'e'} prüfen`, tone: 'info' }
  if (bookingsToCheck > 0) return { text: `${bookingsToCheck} Buchung${bookingsToCheck === 1 ? '' : 'en'} prüfen`, tone: 'info' }
  if (s.overdue) return { text: 'Standmitteilung überfällig', tone: 'warn' }
  if (s.latest?.referenceDate) return { text: `Standmitteilung ${formatMonth(s.latest.referenceDate)}`, tone: 'success' }
  if (confirmed > 0) return { text: 'Standmitteilung ohne lesbare Werte', tone: 'secondary' }
  if (b.summary) return { text: `Beitrag laut Buchungen: ${RHYTHM_TEXT[b.summary.rhythm]}`, tone: 'success' }
  return { text: s.contractNo ? 'Keine Standmitteilung gefunden' : 'Nichts zugeordnet', tone: 'secondary' }
}

export const RHYTHM_TEXT: Record<string, string> = {
  monthly: 'monatlich',
  quarterly: 'vierteljährlich',
  halfyearly: 'halbjährlich',
  yearly: 'jährlich',
  irregular: 'unregelmäßig',
}
