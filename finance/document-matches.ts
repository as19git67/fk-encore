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
