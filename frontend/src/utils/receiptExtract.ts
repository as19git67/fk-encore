/**
 * Pure-TS receipt field extraction from OCR text.
 * Runs identically in browser (on-device OCR) and on the server.
 *
 * Mirrors the server-side helpers in documents/documents.ts so that
 * on-device results match the backend as closely as possible.
 */

const VALUE_PATTERN = String.raw`([0-9]{1,3}(?:[. ][0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:[.,][0-9]{2}))`

const LABELLED_AMOUNT = new RegExp(
  String.raw`(?:gesamt(?:betrag|summe)?|summe|total|zu\s+zahlen|betrag|endsumme|karten(?:zahlung)?|ec-cash)\D{0,40}${VALUE_PATTERN}`,
  'iu',
)

function parseGermanAmount(raw: string): number | null {
  const normalized = raw.replace(/[. ](?=\d{3}(?:\D|$))/g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function extractReceiptAmount(text: string | null | undefined): number | null {
  const source = text ?? ''
  const match = source.match(LABELLED_AMOUNT)
  if (match?.[1]) return parseGermanAmount(match[1])

  const allAmounts = [...source.matchAll(new RegExp(VALUE_PATTERN, 'gu'))]
    .map((m) => m[1])
    .filter((v): v is string => Boolean(v))
    .map(parseGermanAmount)
    .filter((v): v is number => v != null && v > 0)
  return allAmounts.length > 0 ? allAmounts[allAmounts.length - 1]! : null
}

/**
 * Extract a date from German receipt OCR text.
 * Looks for dd.mm.yyyy or dd.mm.yy patterns (the dominant format on
 * German receipts / Kassenbons).
 */
const DATE_PATTERN = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})/g

export function extractReceiptDate(text: string | null | undefined): string | null {
  const source = text ?? ''
  const matches = [...source.matchAll(DATE_PATTERN)]
  if (matches.length === 0) return null

  const now = new Date()
  const currentYear = now.getFullYear()
  let best: { iso: string; dist: number } | null = null

  for (const m of matches) {
    const day = parseInt(m[1]!, 10)
    const month = parseInt(m[2]!, 10)
    let year = parseInt(m[3]!, 10)
    if (year < 100) year += 2000
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    if (year < 2010 || year > currentYear + 1) continue
    const d = new Date(year, month - 1, day)
    if (d.getDate() !== day || d.getMonth() !== month - 1) continue
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const dist = Math.abs(now.getTime() - d.getTime())
    if (!best || dist < best.dist) best = { iso, dist }
  }
  return best?.iso ?? null
}
