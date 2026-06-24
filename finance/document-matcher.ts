export interface MatchTransaction { amount: number; bookingDate: string; counterparty?: string | null; purpose?: string | null }
export interface MatchDocument { amount?: number | null; documentDate?: string | null; sender?: string | null; text?: string | null }
export interface MatchScore { total: number; amount: number; date: number; text: number }

function tokens(value: string | null | undefined): Set<string> {
  return new Set((value ?? '').toLocaleLowerCase('de-DE').split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 3))
}

export function scoreDocumentMatch(transaction: MatchTransaction, document: MatchDocument): MatchScore {
  const transactionAmount = Math.abs(transaction.amount)
  const documentAmount = document.amount == null ? null : Math.abs(document.amount)
  const amount = documentAmount == null ? 0 : documentAmount === transactionAmount ? 1 : Math.max(0, 1 - Math.abs(documentAmount - transactionAmount) / Math.max(1, transactionAmount))
  const date = document.documentDate ? Math.max(0, 1 - Math.abs(Date.parse(transaction.bookingDate) - Date.parse(document.documentDate)) / (1000 * 60 * 60 * 24 * 14)) : 0
  const txTokens = new Set([...tokens(transaction.counterparty), ...tokens(transaction.purpose)])
  const docTokens = new Set([...tokens(document.sender), ...tokens(document.text)])
  const overlap = [...txTokens].filter(token => docTokens.has(token)).length
  const text = txTokens.size ? overlap / txTokens.size : 0
  return { amount, date, text, total: amount * 0.5 + date * 0.25 + text * 0.25 }
}
