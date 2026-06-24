import { api, APIError } from 'encore.dev/api'
import { getAuthData } from '~encore/auth'
import { and, eq, inArray } from 'drizzle-orm'
import db from '../db/database'
import { financeAccount, financeAccountAccess, financeDocumentMatchSuggestion, financeTransaction } from '../db/schema'
import { decideSuggestion, createSuggestionsForTransaction } from './document-match.service'
import { requirePermission } from '../user/auth-handler'
import { loadVisibleDocument } from '../documents/visibility'

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
  await Promise.all(ids.map(createSuggestionsForTransaction))
  const rows = await db.select().from(financeDocumentMatchSuggestion).where(inArray(financeDocumentMatchSuggestion.transaction_id, ids))
  const visible = await Promise.all(rows.map(async row => { try { await loadVisibleDocument(Number(auth.userID), row.document_id); return row } catch { return null } }))
  return visible.filter((row): row is NonNullable<typeof row> => row !== null)
})

export const decideDocumentSuggestion = api({ expose: true, method: 'POST', path: '/finance/document-matches/:id/decision', auth: true }, async ({ id, outcome }: { id: number; outcome: 'accepted' | 'rejected' | 'ignored' }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const [suggestion] = await db.select().from(financeDocumentMatchSuggestion).where(eq(financeDocumentMatchSuggestion.id, id)).limit(1)
  if (!suggestion || !(await readableTransactionIds(Number(auth.userID), [suggestion.transaction_id])).length) throw APIError.notFound('suggestion not found')
  await loadVisibleDocument(Number(auth.userID), suggestion.document_id)
  const updated = await decideSuggestion(id, outcome)
  return { ok: updated }
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
  try {
    const rows = await db.execute<{ document_id: number; title: string | null; original_filename: string }>(`SELECT d.id AS document_id, d.title, d.original_filename FROM finance_transaction_document l JOIN documents d ON d.id = l.document_id WHERE l.transaction_id = ${transactionId}`)
    const visible = await Promise.all(rows.rows.map(async row => { try { await loadVisibleDocument(Number(auth.userID), row.document_id); return row } catch { return null } }))
    return visible.filter((row): row is NonNullable<typeof row> => row !== null)
  } catch (err: any) {
    if (err?.code === '42P01' || err?.cause?.code === '42P01') return []
    throw err
  }
})

export const documentTransactionLinks = api({ expose: true, method: 'GET', path: '/finance/documents/:documentId/transactions', auth: true }, async ({ documentId }: { documentId: number }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  let rows
  try { rows = await db.execute<{ transaction_id: number; booking_date: string; amount: string; counterparty: string | null }>(`SELECT t.id AS transaction_id, t.booking_date, t.amount, t.counterparty FROM finance_transaction_document l JOIN finance_transaction t ON t.id = l.transaction_id WHERE l.document_id = ${documentId}`) } catch (err: any) { if (err?.code === '42P01' || err?.cause?.code === '42P01') return []; throw err }
  const allowed = await readableTransactionIds(Number(auth.userID), rows.rows.map(row => row.transaction_id))
  return rows.rows.filter(row => allowed.includes(row.transaction_id))
})

export const linkDocuments = api({ expose: true, method: 'POST', path: '/finance/document-matches/link', auth: true }, async ({ transaction_ids, document_ids }: { transaction_ids: number[]; document_ids: number[] }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const allowed = await readableTransactionIds(Number(auth.userID), transaction_ids)
  if (allowed.length !== transaction_ids.length) throw APIError.permissionDenied('Keine Berechtigung für eine oder mehrere Buchungen')
  await Promise.all(document_ids.map(id => loadVisibleDocument(Number(auth.userID), id)))
  for (const transaction_id of allowed) for (const document_id of document_ids) await db.execute(`INSERT INTO finance_transaction_document (transaction_id, document_id) VALUES (${transaction_id}, ${document_id}) ON CONFLICT DO NOTHING`)
  return { linked: allowed.length * document_ids.length }
})

export const unlinkDocument = api({ expose: true, method: 'POST', path: '/finance/document-matches/unlink', auth: true }, async ({ transaction_id, document_id }: { transaction_id: number; document_id: number }) => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  if (!(await readableTransactionIds(Number(auth.userID), [transaction_id])).length) throw APIError.permissionDenied('Keine Berechtigung für diese Buchung')
  await db.execute(`DELETE FROM finance_transaction_document WHERE transaction_id = ${transaction_id} AND document_id = ${document_id}`)
  return { ok: true }
})

export const expireDocumentSuggestions = api({ expose: true, method: 'POST', path: '/finance/document-matches/expire', auth: true }, async () => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.admin')
  const { markExpiredSuggestionsIgnored } = await import('./document-match.service')
  await markExpiredSuggestionsIgnored()
  return { ok: true }
})
