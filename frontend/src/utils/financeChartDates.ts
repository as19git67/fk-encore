/**
 * Compact x-axis labels for the depot value charts (issue #887).
 *
 * The raw `as_of` values are ISO dates (`YYYY-MM-DD`). Printed verbatim
 * they eat most of the width of a phone-sized chart, so we drop what the
 * series doesn't need:
 *
 *   • one calendar year only      → `19.07.`  (day + month)
 *   • more than one year, but
 *     several points per month    → `19.07.25`
 *   • one point per month or less → `07/25`   (month + short year)
 *
 * The full date stays available in the tooltip title, so nothing is lost.
 */

export type CompactDateStyle = 'day-month' | 'day-month-year' | 'month-year'

/** Pick the densest style that still keeps the series unambiguous. */
export function pickCompactDateStyle(isoDates: string[]): CompactDateStyle {
  const valid = isoDates.filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
  if (valid.length === 0) return 'day-month'

  const years = new Set(valid.map((d) => d.slice(0, 4)))
  if (years.size <= 1) return 'day-month'

  const months = new Set(valid.map((d) => d.slice(0, 7)))
  // At most one point per month: the day carries no information the
  // month doesn't already give, so drop it and keep the label short.
  if (months.size >= valid.length) return 'month-year'
  return 'day-month-year'
}

/** Format a single ISO date in the given style; passes through anything
 *  that isn't an ISO date so odd server values stay visible. */
export function formatCompactDate(
  iso: string,
  style: CompactDateStyle,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match as unknown as [string, string, string, string]
  switch (style) {
    case 'month-year':
      return `${month}/${year.slice(2)}`
    case 'day-month-year':
      return `${day}.${month}.${year.slice(2)}`
    default:
      return `${day}.${month}.`
  }
}

/** Convenience: format a whole series with one consistent style. */
export function compactDateLabels(isoDates: string[]): string[] {
  const style = pickCompactDateStyle(isoDates)
  return isoDates.map((iso) => formatCompactDate(iso, style))
}

/** Full date for tooltips — `19.07.2026`, or the raw value if unparsable. */
export function fullDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match as unknown as [string, string, string, string]
  return `${day}.${month}.${year}`
}
