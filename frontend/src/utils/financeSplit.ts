/**
 * Helpers for splitting a transaction into several parts.
 *
 * Two rules drive this module:
 *
 * 1. **Amounts are entered without a sign.** The user types the magnitude
 *    ("18,90"); whether the part is an expense or an income is inherited
 *    from the transaction that is being split. Typing a minus for every
 *    row of an expense split is pure noise and easy to get wrong.
 * 2. **The separators follow the UI locale.** In `de-DE` the comma is the
 *    decimal separator and the dot groups thousands, so `1.234,50` and
 *    `1234,50` both mean 1234.50. Group separators are dropped on input —
 *    they carry no value — while the decimal separator splits off the
 *    fractional digits.
 */

export interface AmountSeparators {
  decimal: string
  group: string
}

/**
 * Resolves the decimal and group separator of a locale via Intl, with a
 * de-DE fallback for environments whose ICU data lacks the locale.
 */
export function amountSeparators(locale: string): AmountSeparators {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
    const decimal = parts.find(part => part.type === 'decimal')?.value
    const group = parts.find(part => part.type === 'group')?.value
    if (decimal) return { decimal, group: group ?? '' }
  } catch {
    // fall through to the default below
  }
  return { decimal: ',', group: '.' }
}

/**
 * Parses user input into a non-negative number.
 *
 * Everything that is not a digit or the locale's decimal separator is
 * removed: group separators, currency symbols, spaces and any sign the
 * user may have typed anyway. Only the first decimal separator counts —
 * later ones are dropped so a stray keypress cannot silently change the
 * magnitude. Returns `null` when the input holds no digits at all.
 */
export function parseLocalizedAmount(raw: string, locale = 'de-DE'): number | null {
  const { decimal } = amountSeparators(locale)
  let integer = ''
  let fraction = ''
  let seenDecimal = false
  for (const char of raw) {
    if (char >= '0' && char <= '9') {
      if (seenDecimal) fraction += char
      else integer += char
      continue
    }
    if (char === decimal && !seenDecimal) seenDecimal = true
  }
  if (!integer && !fraction) return null
  const value = Number(`${integer || '0'}.${fraction || '0'}`)
  return Number.isFinite(value) ? value : null
}

/**
 * Formats a magnitude for display inside the amount input: always two
 * fractional digits, no grouping (grouping while typing fights the
 * caret), locale-correct decimal separator.
 */
export function formatAmountForInput(value: number, locale = 'de-DE'): string {
  const { decimal } = amountSeparators(locale)
  return Math.abs(roundCents(value)).toFixed(2).replace('.', decimal)
}

/** Rounds to whole cents, avoiding the usual binary-float drift. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** The unsigned magnitude a user edits for a given stored split amount. */
export function splitMagnitude(amount: number | string): number {
  const value = Number(amount)
  return Number.isFinite(value) ? Math.abs(roundCents(value)) : 0
}

/**
 * Applies the sign of the transaction being split to an entered
 * magnitude: parts of an expense are expenses, parts of an income are
 * income.
 */
export function applySplitSign(magnitude: number, transactionAmount: number | string): number {
  const signed = roundCents(Math.abs(magnitude))
  return Number(transactionAmount) < 0 ? -signed : signed
}

/**
 * Remaining magnitude that still has to be distributed: positive when
 * parts are missing, negative when the rows overshoot the transaction.
 */
export function splitDifference(transactionAmount: number | string, magnitudes: number[]): number {
  const total = Math.abs(roundCents(Number(transactionAmount) || 0))
  const assigned = magnitudes.reduce((sum, value) => sum + Math.abs(roundCents(value || 0)), 0)
  return roundCents(total - assigned)
}

/** A split is saveable once the parts add up to the transaction amount. */
export function isSplitBalanced(transactionAmount: number | string, magnitudes: number[]): boolean {
  return Math.abs(splitDifference(transactionAmount, magnitudes)) < 0.005
}

/**
 * Initial two-row suggestion: half of the transaction each, with the
 * rounding remainder on the second row so the split starts balanced.
 */
export function defaultSplitMagnitudes(transactionAmount: number | string): [number, number] {
  const total = Math.abs(roundCents(Number(transactionAmount) || 0))
  const first = roundCents(total / 2)
  return [first, roundCents(total - first)]
}
