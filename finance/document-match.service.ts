import { eq } from 'drizzle-orm'
import db from '../db/database'
import { documents, financeDocumentMatchSuggestion, financeTransaction, financeTransactionDocument } from '../db/schema'
import { scoreDocumentMatch, type MatchScore } from './document-matcher'

export type MatchOutcome = 'pending' | 'accepted' | 'rejected' | 'ignored'

export async function createSuggestionsForTransaction(transactionId: number) {
  const [transaction] = await db.select().from(financeTransaction).where(eq(financeTransaction.id, transactionId)).limit(1)
  if (!transaction) return []
  const candidates = await db.select().from(documents).where(eq(documents.status, 'ready')).limit(200)
  const suggestions = candidates.map(document => ({ document, score: scoreDocumentMatch({ amount: Number(transaction.amount), bookingDate: transaction.booking_date, counterparty: transaction.counterparty, purpose: transaction.purpose }, { documentDate: document.doc_date, sender: document.sender, text: document.extracted_text }) })).filter(candidate => candidate.score.total >= 0.45)
  for (const { document, score } of suggestions) {
    await db.insert(financeDocumentMatchSuggestion).values({ transaction_id: transactionId, document_id: document.id, score: score.total, amount_score: score.amount, date_score: score.date, text_score: score.text }).onConflictDoNothing()
  }
  return suggestions
}

export async function decideSuggestion(id: number, outcome: Exclude<MatchOutcome, 'pending'>) {
  const [suggestion] = await db.select().from(financeDocumentMatchSuggestion).where(eq(financeDocumentMatchSuggestion.id, id)).limit(1)
  if (!suggestion) return false
  await db.transaction(async (tx) => {
    await tx.update(financeDocumentMatchSuggestion).set({ outcome, decided_at: new Date().toISOString() }).where(eq(financeDocumentMatchSuggestion.id, id))
    if (outcome === 'accepted') await tx.insert(financeTransactionDocument).values({ transaction_id: suggestion.transaction_id, document_id: suggestion.document_id }).onConflictDoNothing()
  })
  return true
}

export function explainMatchScore(score: MatchScore) { return { amount: Math.round(score.amount * 100), date: Math.round(score.date * 100), text: Math.round(score.text * 100), total: Math.round(score.total * 100) } }
