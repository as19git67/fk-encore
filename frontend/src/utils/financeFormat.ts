/**
 * Number formatting for securities figures (issue #1336).
 *
 * The backend hands every amount over as a fixed-scale string, so each
 * helper takes `string | number | null` and renders a dash for "unknown"
 * instead of a zero that would read as a fact.
 */

function toNumber(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null
  const n = typeof val === 'number' ? val : Number(val)
  return Number.isFinite(n) ? n : null
}

export function formatCurrency(
  val: string | number | null | undefined,
  currency?: string | null,
): string {
  const n = toNumber(val)
  if (n === null) return '–'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(n)
}

/** Like `formatCurrency`, with an explicit plus on gains so G/L reads at a glance. */
export function formatSignedCurrency(
  val: string | number | null | undefined,
  currency?: string | null,
): string {
  const n = toNumber(val)
  if (n === null) return '–'
  const formatted = formatCurrency(n, currency)
  return n > 0 ? '+' + formatted : formatted
}

export function formatSignedPercent(val: string | number | null | undefined): string {
  const n = toNumber(val)
  if (n === null) return '–'
  const sign = n > 0 ? '+' : ''
  return sign + n.toFixed(2).replace('.', ',') + ' %'
}

export function formatPercent(val: string | number | null | undefined, digits = 1): string {
  const n = toNumber(val)
  if (n === null) return '–'
  return n.toFixed(digits).replace('.', ',') + ' %'
}

/** Quantities: up to four decimals, no trailing zeros. */
export function formatQuantity(val: string | number | null | undefined): string {
  const n = toNumber(val)
  if (n === null) return '–'
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(n)
}

export type GainSign = 'pos' | 'neg' | 'flat'

export function gainSign(val: string | number | null | undefined): GainSign {
  const n = toNumber(val)
  if (n === null || n === 0) return 'flat'
  return n > 0 ? 'pos' : 'neg'
}

/** `YYYY-MM-DD` → `DD.MM.YYYY` without a Date round trip (no timezone shift). */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return '–'
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}

const quoteTimeFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' })

/** A quote's ISO timestamp in local time ("02.10.2026, 15:05"). */
export function formatQuoteTime(at: string | null | undefined): string {
  if (!at) return '–'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '–' : quoteTimeFormat.format(d)
}

/** Where a position's price comes from, for a hint or a tooltip. */
export function priceOriginLabel(p: {
  price_source: 'quote' | 'bank' | null
  price_as_of: string | null
  price_at: string | null
}): string | null {
  if (p.price_source === 'quote' && p.price_at) return `Kurs vom ${formatQuoteTime(p.price_at)}`
  if (p.price_as_of) return `Kurs der Bank vom ${formatIsoDate(p.price_as_of)}`
  return null
}

export const DEPOT_KIND_LABELS: Record<string, string> = {
  buy: 'Kauf',
  sell: 'Verkauf',
  in: 'Einbuchung',
  out: 'Ausbuchung',
  dividend: 'Dividende',
  split: 'Split',
  corp_action: 'Kapitalmaßnahme',
  tax: 'Steuer',
}

export function depotKindLabel(kind: string): string {
  return DEPOT_KIND_LABELS[kind] ?? kind
}

/** How often a savings plan buys (#1700). */
export const SAVINGS_PLAN_INTERVAL_LABELS: Record<string, string> = {
  monthly: 'monatlich',
  bimonthly: 'alle zwei Monate',
  quarterly: 'vierteljährlich',
  semiannual: 'halbjährlich',
  annual: 'jährlich',
}
