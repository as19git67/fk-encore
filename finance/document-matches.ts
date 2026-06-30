import { api, APIError } from 'encore.dev/api'
import { getAuthData } from '~encore/auth'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import db from '../db/database'
import { documents, financeAccountAccess, financeDocumentMatchSuggestion, financeTransaction } from '../db/schema'
import { decideSuggestion, createSuggestionsForTransaction, computeReceiptEnrichment } from './document-match.service'
import { extractDocumentAmount, isWithinDocumentMatchWindow } from './document-matcher'
import { requirePermission } from '../user/auth-handler'
import { loadVisibleDocument } from '../documents/visibility'

interface SuggestDocumentsParams { transaction_ids: number[] }
interface DecideSuggestionParams { id: number; outcome: 'accepted' | 'rejected' | 'ignored' }
interface ManualLinkParams { transaction_ids: number[]; document_ids: number[] }
interface ManualUnlinkParams { transaction_id: number; document_id: number }
interface DocumentSuggestionDTO {
  id: number
  transaction_id: number
  document_id: number
  score: number
  amount_score: number
  date_score: number
  text_score: number
  outcome: string
  title: string | null
  original_filename: string
  sender: string | null
  doc_date: string | null
  summary: string | null
  extracted_text_preview: string | null
}
interface MatchMetricBucket { accepted: number; rejected: number; ignored: number; pending: number }
interface MatchMetricsResponse { high: MatchMetricBucket; medium: MatchMetricBucket; low: MatchMetricBucket }
interface LinkResponse { linked: number }
interface OkResponse { ok: boolean }
interface TransactionDocumentLinkDTO { document_id: number; title: string | null; original_filename: string }
interface DocumentTransactionLinkDTO { transaction_id: number; booking_date: string; amount: string; counterparty: string | null }
interface DocumentSuggestionsResponse { items: DocumentSuggestionDTO[] }
interface TransactionDocumentLinksResponse { items: TransactionDocumentLinkDTO[] }
interface DocumentTransactionLinksResponse { items: DocumentTransactionLinkDTO[] }

function textPreview(value: string | null | undefined, maxLength = 420): string | null {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength).trim()}…`
}

async function readableTransactionIds(userId: number, ids: number[]) {
  const auth = getAuthData()!
  if (auth.permissions.includes('finance.admin')) return ids
  const rows = await db.select({ id: financeTransaction.id }).from(financeTransaction).innerJoin(financeAccountAccess, and(eq(financeAccountAccess.account_id, financeTransaction.account_id), eq(financeAccountAccess.user_id, userId))).where(inArray(financeTransaction.id, ids))
  return rows.map(row => row.id)
}

export const suggestDocuments = api({ expose: true, method: 'POST', path: '/finance/document-matches/suggest', auth: true }, async ({ transaction_ids }: SuggestDocumentsParams): Promise<DocumentSuggestionsResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const ids = await readableTransactionIds(Number(auth.userID), transaction_ids)
  if (ids.length !== transaction_ids.length) throw APIError.permissionDenied('Keine Berechtigung für eine oder mehrere Buchungen')
  await Promise.all(ids.map(createSuggestionsForTransaction))
  const rows = await db.select().from(financeDocumentMatchSuggestion).where(inArray(financeDocumentMatchSuggestion.transaction_id, ids))
  const transactionRows = await db
    .select({ id: financeTransaction.id, booking_date: financeTransaction.booking_date })
    .from(financeTransaction)
    .where(inArray(financeTransaction.id, ids))
  const bookingDateById = new Map(transactionRows.map(row => [Number(row.id), row.booking_date]))
  const visible = await Promise.all(rows.map(async row => {
    try {
      const document = await loadVisibleDocument(Number(auth.userID), row.document_id)
      return { row, document }
    } catch {
      return null
    }
  }))
  return { items: visible
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .filter(({ row, document }) => isWithinDocumentMatchWindow(
      bookingDateById.get(Number(row.transaction_id)),
      document.doc_date,
    ))
    .map(({ row, document }) => ({
    id: Number(row.id), transaction_id: Number(row.transaction_id), document_id: Number(row.document_id),
    score: Number(row.score), amount_score: Number(row.amount_score), date_score: Number(row.date_score),
    text_score: Number(row.text_score), outcome: String(row.outcome),
    title: document.title,
    original_filename: document.original_filename,
    sender: document.sender,
    doc_date: document.doc_date,
    summary: document.summary,
    extracted_text_preview: textPreview(document.summary ?? document.extracted_text),
    })) }
})

export const decideDocumentSuggestion = api({ expose: true, method: 'POST', path: '/finance/document-matches/:id/decision', auth: true }, async ({ id, outcome }: DecideSuggestionParams): Promise<OkResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const [suggestion] = await db.select().from(financeDocumentMatchSuggestion).where(eq(financeDocumentMatchSuggestion.id, id)).limit(1)
  if (!suggestion || !(await readableTransactionIds(Number(auth.userID), [suggestion.transaction_id])).length) throw APIError.notFound('suggestion not found')
  await loadVisibleDocument(Number(auth.userID), suggestion.document_id)
  const updated = await decideSuggestion(id, outcome)
  return { ok: updated }
})

export const documentMatchMetrics = api({ expose: true, method: 'GET', path: '/finance/document-matches/metrics', auth: true }, async (): Promise<MatchMetricsResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const rows = await db.select({ outcome: financeDocumentMatchSuggestion.outcome, score: financeDocumentMatchSuggestion.score }).from(financeDocumentMatchSuggestion)
  const buckets = { high: { accepted: 0, rejected: 0, ignored: 0, pending: 0 }, medium: { accepted: 0, rejected: 0, ignored: 0, pending: 0 }, low: { accepted: 0, rejected: 0, ignored: 0, pending: 0 } }
  for (const row of rows) { const bucket = row.score >= .8 ? buckets.high : row.score >= .6 ? buckets.medium : buckets.low; bucket[row.outcome as keyof typeof bucket]++ }
  return buckets
})

export const transactionDocumentLinks = api({ expose: true, method: 'GET', path: '/finance/transactions/:transactionId/documents', auth: true }, async ({ transactionId }: { transactionId: number }): Promise<TransactionDocumentLinksResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const ids = await readableTransactionIds(Number(auth.userID), [transactionId])
  if (!ids.length) throw APIError.permissionDenied('Keine Berechtigung für diese Buchung')
  try {
    const rows = await db.execute<{ document_id: number; title: string | null; original_filename: string }>(`SELECT d.id AS document_id, d.title, d.original_filename FROM finance_transaction_document l JOIN documents d ON d.id = l.document_id WHERE l.transaction_id = ${transactionId}`)
    const visible = await Promise.all(rows.rows.map(async row => { try { await loadVisibleDocument(Number(auth.userID), row.document_id); return row } catch { return null } }))
    return { items: visible.filter((row): row is NonNullable<typeof row> => row !== null) }
  } catch (err: any) {
    if (err?.code === '42P01' || err?.cause?.code === '42P01') return { items: [] }
    throw err
  }
})

export const documentTransactionLinks = api({ expose: true, method: 'GET', path: '/finance/documents/:documentId/transactions', auth: true }, async ({ documentId }: { documentId: number }): Promise<DocumentTransactionLinksResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  await loadVisibleDocument(Number(auth.userID), documentId)
  let rows
  try { rows = await db.execute<{ transaction_id: number; booking_date: string; amount: string; counterparty: string | null }>(`SELECT t.id AS transaction_id, t.booking_date, t.amount, t.counterparty FROM finance_transaction_document l JOIN finance_transaction t ON t.id = l.transaction_id WHERE l.document_id = ${documentId}`) } catch (err: any) { if (err?.code === '42P01' || err?.cause?.code === '42P01') return { items: [] }; throw err }
  const allowed = await readableTransactionIds(Number(auth.userID), rows.rows.map(row => row.transaction_id))
  return { items: rows.rows.filter(row => allowed.includes(row.transaction_id)) }
})

export const linkDocuments = api({ expose: true, method: 'POST', path: '/finance/document-matches/link', auth: true }, async ({ transaction_ids, document_ids }: ManualLinkParams): Promise<LinkResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  const allowed = await readableTransactionIds(Number(auth.userID), transaction_ids)
  if (allowed.length !== transaction_ids.length) throw APIError.permissionDenied('Keine Berechtigung für eine oder mehrere Buchungen')
  await Promise.all(document_ids.map(id => loadVisibleDocument(Number(auth.userID), id)))
  for (const transaction_id of allowed) for (const document_id of document_ids) await db.execute(`INSERT INTO finance_transaction_document (transaction_id, document_id) VALUES (${transaction_id}, ${document_id}) ON CONFLICT DO NOTHING`)
  return { linked: allowed.length * document_ids.length }
})

export const unlinkDocument = api({ expose: true, method: 'POST', path: '/finance/document-matches/unlink', auth: true }, async ({ transaction_id, document_id }: ManualUnlinkParams): Promise<OkResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.view')
  if (!(await readableTransactionIds(Number(auth.userID), [transaction_id])).length) throw APIError.permissionDenied('Keine Berechtigung für diese Buchung')
  await loadVisibleDocument(Number(auth.userID), document_id)
  await db.execute(`DELETE FROM finance_transaction_document WHERE transaction_id = ${transaction_id} AND document_id = ${document_id}`)
  return { ok: true }
})

interface ReceiptEnrichmentItem {
  transaction_id: number
  booking_date: string
  amount: string
  counterparty: string | null
  document_id: number
  doc_sender: string | null
  doc_date: string | null
  doc_amount: number | null
  doc_status: string
}

export const pendingReceiptEnrichments = api(
  { expose: true, method: 'GET', path: '/finance/receipt-enrichments/pending', auth: true },
  async (): Promise<{ items: ReceiptEnrichmentItem[] }> => {
    const auth = getAuthData()!
    requirePermission(auth, 'finance.view')
    const rows = await db
      .select({
        transaction_id: financeTransaction.id,
        booking_date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
        counterparty: financeTransaction.counterparty,
        document_id: documents.id,
        doc_sender: documents.sender,
        doc_date: documents.doc_date,
        doc_text: documents.extracted_text,
        doc_status: documents.status,
      })
      .from(financeTransaction)
      .innerJoin(documents, eq(documents.id, financeTransaction.receipt_document_id))
      .where(isNotNull(financeTransaction.receipt_document_id))
      .limit(100)
    const readableIds = await readableTransactionIds(Number(auth.userID), rows.map(r => r.transaction_id))
    const readableSet = new Set(readableIds)
    const items = rows
      .filter(r => readableSet.has(r.transaction_id))
      .map(r => {
        const docAmount = extractDocumentAmount(r.doc_text)
        const diff = computeReceiptEnrichment(r, { sender: r.doc_sender, doc_date: r.doc_date, amount: docAmount })
        return {
          item: {
            transaction_id: r.transaction_id,
            booking_date: r.booking_date,
            amount: r.amount,
            counterparty: r.counterparty,
            document_id: r.document_id,
            doc_sender: r.doc_sender,
            doc_date: r.doc_date,
            doc_amount: docAmount,
            doc_status: r.doc_status,
          },
          // Still-processing receipts are shown so the user sees progress;
          // ready ones only when they actually carry something to review.
          show: r.doc_status !== 'ready' || Object.keys(diff).length > 0,
        }
      })
      .filter(r => r.show)
      .map(r => r.item)
    return { items }
  },
)

/**
 * Stop offering enrichment suggestions for a transaction by clearing its
 * `receipt_document_id` pointer. The actual document attachment
 * (finance_transaction_document) is left untouched — the receipt stays
 * linked, only the "needs review" flag goes away.
 */
export const dismissReceiptEnrichment = api(
  { expose: true, method: 'POST', path: '/finance/receipt-enrichments/:transactionId/dismiss', auth: true },
  async ({ transactionId }: { transactionId: number }): Promise<OkResponse> => {
    const auth = getAuthData()!
    requirePermission(auth, 'finance.view')
    if (!(await readableTransactionIds(Number(auth.userID), [transactionId])).length) {
      throw APIError.permissionDenied('Keine Berechtigung für diese Buchung')
    }
    await db.update(financeTransaction).set({ receipt_document_id: null }).where(eq(financeTransaction.id, transactionId))
    return { ok: true }
  },
)

export const expireDocumentSuggestions = api({ expose: true, method: 'POST', path: '/finance/document-matches/expire', auth: true }, async (): Promise<OkResponse> => {
  const auth = getAuthData()!; requirePermission(auth, 'finance.admin')
  const { markExpiredSuggestionsIgnored } = await import('./document-match.service')
  await markExpiredSuggestionsIgnored()
  return { ok: true }
})
