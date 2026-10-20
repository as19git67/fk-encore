/**
 * The transaction list's amount filter. Bounds are absolute amounts — "ab
 * 100 €" keeps a 100 € expense as well as a 100 € credit — and the
 * direction picks money in or out on its own, so nobody has to type a
 * minus sign to mean "Ausgaben".
 */

export type TransactionDirection = 'in' | 'out'

export const directionOptions: { label: string; value: TransactionDirection | null }[] = [
  { label: 'Ein- und Ausgänge', value: null },
  { label: 'Nur Eingänge', value: 'in' },
  { label: 'Nur Ausgänge', value: 'out' },
]

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 })

/** The chip text for a bound pair, or null when neither is set. */
export function amountRangeLabel(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `Betrag: ${euro.format(min)} – ${euro.format(max)}`
  if (min !== null) return `Betrag: ab ${euro.format(min)}`
  if (max !== null) return `Betrag: bis ${euro.format(max)}`
  return null
}

export function directionLabel(direction: TransactionDirection): string {
  return direction === 'in' ? 'Nur Eingänge' : 'Nur Ausgänge'
}

/** A non-negative amount from a query value ("12,50" or "12.50"), else null. */
export function parseAmountQuery(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function parseDirectionQuery(v: unknown): TransactionDirection | null {
  return v === 'in' || v === 'out' ? v : null
}
