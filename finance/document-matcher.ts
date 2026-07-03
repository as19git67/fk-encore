export interface MatchTransaction { amount: number; bookingDate: string; counterparty?: string | null; purpose?: string | null }
export interface MatchDocument { amount?: number | null; documentDate?: string | null; sender?: string | null; text?: string | null }
export interface MatchScore { total: number; amount: number; date: number; text: number }

export const DOCUMENT_MATCH_WINDOW_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

function dateOnlyTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function documentMatchDateRange(
  value: string | null | undefined,
  windowDays = DOCUMENT_MATCH_WINDOW_DAYS,
): { from: string; to: string } | null {
  const timestamp = dateOnlyTimestamp(value)
  if (timestamp === null) return null
  const offset = windowDays * DAY_MS
  return {
    from: new Date(timestamp - offset).toISOString().slice(0, 10),
    to: new Date(timestamp + offset).toISOString().slice(0, 10),
  }
}

export function isWithinDocumentMatchWindow(
  transactionDate: string | null | undefined,
  documentDate: string | null | undefined,
  windowDays = DOCUMENT_MATCH_WINDOW_DAYS,
): boolean {
  const transactionTimestamp = dateOnlyTimestamp(transactionDate)
  const documentTimestamp = dateOnlyTimestamp(documentDate)
  if (transactionTimestamp === null || documentTimestamp === null) return false
  return Math.abs(transactionTimestamp - documentTimestamp) <= windowDays * DAY_MS
}

function tokens(value: string | null | undefined): Set<string> {
  return new Set((value ?? '').toLocaleLowerCase('de-DE').split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 3))
}


/** Extract a German invoice total only when it is explicitly labelled. */
export function extractDocumentAmount(text: string | null | undefined): number | null {
  const match = (text ?? '').match(/(?:\bgesamt(?:betrag|summe)\b|\brechnungsbetrag\b|\bbruttoumsatz\b|\bzu\s+zahlen\b|\bsumme\b|\btotal\b)\D{0,24}([0-9]{1,3}(?:[. ][0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:[.,][0-9]{2}))/iu)
  if (!match) return null
  const normalized = match[1].replace(/[. ](?=\d{3}(?:\D|$))/g, '').replace(',', '.')
  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : null
}

/** Prefer the receipt pipeline's structured amount over reparsing OCR text. */
export function resolveDocumentMatchAmount(
  structuredAmount: string | number | null | undefined,
  text: string | null | undefined,
): number | null {
  if (structuredAmount !== null && structuredAmount !== undefined) {
    const amount = Number(structuredAmount)
    if (Number.isFinite(amount) && amount > 0) return amount
  }
  return extractDocumentAmount(text)
}

export function scoreDocumentMatch(transaction: MatchTransaction, document: MatchDocument): MatchScore {
  const transactionAmount = Math.abs(transaction.amount)
  const documentAmount = document.amount == null ? null : Math.abs(document.amount)
  const amountDifference = documentAmount == null ? null : Math.abs(documentAmount - transactionAmount)
  const amount = documentAmount == null
    ? 0
    : amountDifference! <= 0.01
      ? 1
      : Math.max(0, 1 - amountDifference! / Math.max(1, transactionAmount))
  const date = document.documentDate ? Math.max(0, 1 - Math.abs(Date.parse(transaction.bookingDate) - Date.parse(document.documentDate)) / (1000 * 60 * 60 * 24 * 14)) : 0
  const txTokens = new Set([...tokens(transaction.counterparty), ...tokens(transaction.purpose)])
  const docTokens = new Set([...tokens(document.sender), ...tokens(document.text)])
  const overlap = [...txTokens].filter(token => docTokens.has(token)).length
  const text = txTokens.size ? overlap / txTokens.size : 0
  return { amount, date, text, total: amount * 0.5 + date * 0.25 + text * 0.25 }
}
