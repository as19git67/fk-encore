import { and, eq, lte, isNotNull } from 'drizzle-orm'
import db from '../db/database'
import { documents, financeDocumentMatchSuggestion, financeTransaction, financeTransactionDocument } from '../db/schema'
import { extractDocumentAmount, scoreDocumentMatch, type MatchScore } from './document-matcher'
import { realtime } from '~encore/clients'

export type MatchOutcome = 'pending' | 'accepted' | 'rejected' | 'ignored'

export async function createSuggestionsForTransaction(transactionId: number) {
  const [transaction] = await db.select().from(financeTransaction).where(eq(financeTransaction.id, transactionId)).limit(1)
  if (!transaction) return []
  const candidates = await db.select().from(documents).where(eq(documents.status, 'ready')).limit(200)
  const suggestions = candidates.map(document => ({ document, score: scoreDocumentMatch({ amount: Number(transaction.amount), bookingDate: transaction.booking_date, counterparty: transaction.counterparty, purpose: transaction.purpose }, { amount: extractDocumentAmount(document.extracted_text), documentDate: document.doc_date, sender: document.sender, text: document.extracted_text }) })).filter(candidate => candidate.score.total >= 0.45)
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

/** Pending suggestions older than 30 days count as ignored for quality metrics. */
export async function markExpiredSuggestionsIgnored(now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  return db.update(financeDocumentMatchSuggestion).set({ outcome: 'ignored', decided_at: now.toISOString() }).where(and(eq(financeDocumentMatchSuggestion.outcome, 'pending'), lte(financeDocumentMatchSuggestion.created_at, cutoff)))
}

/**
 * After a receipt document finishes classification, check if it's linked
 * to a transaction via `receipt_document_id`. If so, compare the enriched
 * fields (sender, date, amount) with the transaction and notify the user
 * if there are differences worth reviewing.
 */
export async function checkReceiptEnrichment(documentId: number): Promise<void> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc || doc.status !== 'ready') return

  const linkedTxs = await db
    .select({ id: financeTransaction.id, counterparty: financeTransaction.counterparty, amount: financeTransaction.amount, booking_date: financeTransaction.booking_date })
    .from(financeTransaction)
    .where(eq(financeTransaction.receipt_document_id, documentId))

  if (linkedTxs.length === 0) return

  for (const tx of linkedTxs) {
    const enriched: Record<string, string> = {}
    if (doc.sender?.trim() && !tx.counterparty?.trim()) {
      enriched.sender = doc.sender.trim()
    }
    if (doc.doc_date && doc.doc_date !== tx.booking_date?.slice(0, 10)) {
      enriched.doc_date = doc.doc_date
    }
    const docAmount = extractDocumentAmount(doc.extracted_text)
    if (docAmount != null && Math.abs(docAmount - Math.abs(Number(tx.amount))) > 0.01) {
      enriched.amount = String(docAmount)
    }
    if (Object.keys(enriched).length === 0) return

    try {
      await realtime.publishEvent({
        userIds: [String(doc.user_id)],
        channel: 'finance',
        type: 'receipt.enriched',
        resourceId: String(tx.id),
        payload: { transaction_id: tx.id, document_id: documentId, enriched },
      })
    } catch (err) {
      console.warn(`[finance] receipt enrichment notify failed for tx=${tx.id}: ${(err as Error).message}`)
    }
  }
}

export async function createSuggestionsForDocument(documentId: number) {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!document || document.status !== 'ready') return []
  const transactions = await db.select().from(financeTransaction).limit(500)
  const matches = transactions.map(transaction => ({ transaction, score: scoreDocumentMatch({ amount: Number(transaction.amount), bookingDate: transaction.booking_date, counterparty: transaction.counterparty, purpose: transaction.purpose }, { amount: extractDocumentAmount(document.extracted_text), documentDate: document.doc_date, sender: document.sender, text: document.extracted_text }) })).filter(match => match.score.total >= .45)
  for (const { transaction, score } of matches) await db.insert(financeDocumentMatchSuggestion).values({ transaction_id: transaction.id, document_id: documentId, score: score.total, amount_score: score.amount, date_score: score.date, text_score: score.text }).onConflictDoNothing()
  return matches
}
