import { api, APIError } from 'encore.dev/api'
import { getAuthData } from '~encore/auth'
import { and, eq, inArray } from 'drizzle-orm'
import db from '../db/database'
import { financeAccount, financeAccountAccess, financeDocumentMatchSuggestion, financeTransaction } from '../db/schema'
import { decideSuggestion, createSuggestionsForTransaction } from './document-match.service'
import { requirePermission } from '../user/auth-handler'

async function readableTransactionIds(userId: number, ids: number[]) {
  const auth = getAuthData()!
  if (auth.permissions.includes('finance.admin')) return ids
  const rows = await db.select({ id: financeTransaction.id }).from(financeTransaction).innerJoin(financeAccountAccess, and(eq(financeAccountAccess.account_id, financeTransaction.account_id), eq(financeAccountAccess.user_id, userId))).where(inArray(financeTransaction.id, ids))
  return rows.map(row => row.id)
}

export const suggestDocuments = api({ expose: true, method: 'POST', path: '/finance/document-matches/suggest', auth: true }, async ({ transaction_ids }: { transaction_ids: number[] }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const ids = await readableTransactionIds(Number(auth.userID), transaction_ids)
  if (ids.length !== transaction_ids.length) throw APIError.permissionDenied('Keine Berechtigung für eine oder mehrere Buchungen')
  return Promise.all(ids.map(createSuggestionsForTransaction))
})

export const decideDocumentSuggestion = api({ expose: true, method: 'POST', path: '/finance/document-matches/:id/decision', auth: true }, async ({ id, outcome }: { id: number; outcome: 'accepted' | 'rejected' | 'ignored' }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  await decideSuggestion(id, outcome)
  return { ok: true }
})

export const documentMatchMetrics = api({ expose: true, method: 'GET', path: '/finance/document-matches/metrics', auth: true }, async () => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const rows = await db.select({ outcome: financeDocumentMatchSuggestion.outcome, score: financeDocumentMatchSuggestion.score }).from(financeDocumentMatchSuggestion)
  const buckets = { high: { accepted: 0, rejected: 0, ignored: 0, pending: 0 }, medium: { accepted: 0, rejected: 0, ignored: 0, pending: 0 }, low: { accepted: 0, rejected: 0, ignored: 0, pending: 0 } }
  for (const row of rows) { const bucket = row.score >= .8 ? buckets.high : row.score >= .6 ? buckets.medium : buckets.low; bucket[row.outcome as keyof typeof bucket]++ }
  return buckets
})

export const transactionDocumentLinks = api({ expose: true, method: 'GET', path: '/finance/transactions/:transactionId/documents', auth: true }, async ({ transactionId }: { transactionId: number }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const ids = await readableTransactionIds(Number(auth.userID), [transactionId])
  if (!ids.length) throw APIError.permissionDenied('Keine Berechtigung für diese Buchung')
  const rows = await db.execute<{ document_id: number; title: string | null; original_filename: string }>(`SELECT d.id AS document_id, d.title, d.original_filename FROM finance_transaction_document l JOIN documents d ON d.id = l.document_id WHERE l.transaction_id = ${transactionId}`)
  return rows.rows
})

export const documentTransactionLinks = api({ expose: true, method: 'GET', path: '/finance/documents/:documentId/transactions', auth: true }, async ({ documentId }: { documentId: number }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const rows = await db.execute<{ transaction_id: number; booking_date: string; amount: string; counterparty: string | null }>(`SELECT t.id AS transaction_id, t.booking_date, t.amount, t.counterparty FROM finance_transaction_document l JOIN finance_transaction t ON t.id = l.transaction_id WHERE l.document_id = ${documentId}`)
  const allowed = await readableTransactionIds(Number(auth.userID), rows.rows.map(row => row.transaction_id))
  return rows.rows.filter(row => allowed.includes(row.transaction_id))
})
