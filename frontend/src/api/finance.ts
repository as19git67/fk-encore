/**
 * Typed client for the `finance` backend service.
 *
 * All endpoints are gated server-side by `finance.view` or a stricter
 * permission (see finance-service-layout.md §3). The types here mirror
 * the DTOs in finance/*.ts.
 */

import { apiFetch } from './client'

// ----------------------------------------------------------------------
// Bankcontacts
// ----------------------------------------------------------------------

export interface Bankcontact {
  id: number
  name: string
  blz: string
  login: string
  server_url: string
  tan_method: string | null
  credentials_set: boolean
  last_sync_at: string | null
  last_sync_status: string | null
  created_at: string | null
  /**
   * Cached list of TAN methods the bank advertises for this user,
   * populated by the most recent probeTanMethods call. Empty array
   * when the user has never probed this bankcontact — the UI picker
   * shows a "TAN-Verfahren abrufen"-hint in that case.
   */
  available_tan_methods: TanMethodOption[]
  /**
   * UI-configured cron-like sync slots. Empty array when the user
   * hasn't set up any schedule yet. Used by the BankcontactsView
   * overview widget to compute the next sync moment.
   */
  sync_times: SyncSlot[]
}

export interface CreateBankcontactInput {
  name: string
  blz: string
  login: string
  server_url: string
  tan_method?: string
}

export interface UpdateBankcontactInput {
  name?: string
  blz?: string
  login?: string
  server_url?: string
  tan_method?: string | null
}

export async function listBankcontacts(): Promise<{ items: Bankcontact[] }> {
  return apiFetch('/finance/bankcontacts')
}

export async function getBankcontact(id: number): Promise<Bankcontact> {
  return apiFetch(`/finance/bankcontacts/${id}`)
}

export async function createBankcontact(
  input: CreateBankcontactInput,
): Promise<Bankcontact> {
  return apiFetch('/finance/bankcontacts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateBankcontact(
  id: number,
  input: UpdateBankcontactInput,
): Promise<Bankcontact> {
  return apiFetch(`/finance/bankcontacts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ id, ...input }),
  })
}

export interface DeleteBankcontactResponse {
  deleted: true
  /** Number of finance_account rows that lost their bank link (set
   *  to manual) as a side effect of this delete. Transactions are
   *  preserved. */
  accounts_unlinked: number
}

export async function deleteBankcontact(
  id: number,
): Promise<DeleteBankcontactResponse> {
  return apiFetch(`/finance/bankcontacts/${id}`, { method: 'DELETE' })
}

export async function setBankcontactCredentials(
  id: number,
  pin: string,
): Promise<{ credentials_set: true }> {
  return apiFetch(`/finance/bankcontacts/${id}/credentials`, {
    method: 'POST',
    body: JSON.stringify({ id, pin }),
  })
}

// ----------------------------------------------------------------------
// TAN-method probe (first-sync lookup for the UI picker)
// ----------------------------------------------------------------------

export interface TanMethodOption {
  id: number
  name: string
  isDecoupled: boolean
}

export type ProbeTanMethodsResponse =
  | { state: 'ok'; methods: TanMethodOption[] }
  | { state: 'tan-required'; errorCode: string; errorMessage: string }
  | { state: 'error'; errorCode: string; errorMessage: string }

export async function probeTanMethods(
  id: number,
): Promise<ProbeTanMethodsResponse> {
  return apiFetch(`/finance/bankcontacts/${id}/tan-methods`, {
    method: 'POST',
    // Two FinTS round-trips possible (retry on transport error), so
    // allow more than the default 30s.
    timeoutMs: 60_000,
  })
}

// ----------------------------------------------------------------------
// Sync / TAN flow
// ----------------------------------------------------------------------

export interface UnknownBankAccount {
  accountNumber: string
  iban: string | null
  accountKind: string
  currency: string
  label: string
}

export type SyncResponse =
  | {
      state: 'idle'
      /** Total accounts the bank reported. */
      accounts_seen?: number
      /** Accounts matched to a linked finance_account (data written). */
      accounts_matched?: number
      /** Accounts the bank reported that are not linked yet. */
      accounts_unknown?: number
      /** Bank-side account snapshots waiting for link/import in the UI. */
      unknown_accounts?: UnknownBankAccount[]
      /** Rows inserted into finance_transaction (new only; duplicates skipped silently). */
      transactions_inserted?: number
      /** Rows inserted into finance_account_balance. */
      balances_written?: number
      /** True when any per-account fetch hit a mid-flight TAN we skipped. */
      partial?: boolean
    }
  | {
      state: 'tan-required'
      tanReference: string
      challenge: string
      tanMediaName?: string
      /** photoTAN / Flicker-TAN matrix mime type, e.g. "image/png". */
      tanPhotoMime?: string
      /** photoTAN / Flicker-TAN matrix as base64 — UI builds a data URI. */
      tanPhotoBase64?: string
    }
  | { state: 'error'; errorCode: string; errorMessage: string }

export async function triggerSync(bankcontactId: number): Promise<SyncResponse> {
  return apiFetch('/finance/statements', {
    method: 'POST',
    body: JSON.stringify({ bankcontactId }),
  })
}

export async function completeTan(
  tanReference: string,
  tan?: string,
): Promise<SyncResponse> {
  return apiFetch('/finance/tan-sessions/complete', {
    method: 'POST',
    body: JSON.stringify({ tanReference, tan }),
  })
}

// ----------------------------------------------------------------------
// Sync schedule
// ----------------------------------------------------------------------

export interface SyncSlot {
  weekdays: number[]
  time: string
  tz: string
}

export async function getSchedule(id: number): Promise<{
  bankcontact_id: number
  slots: SyncSlot[]
}> {
  return apiFetch(`/finance/bankcontacts/${id}/schedule`)
}

export async function putSchedule(
  id: number,
  slots: SyncSlot[],
): Promise<{ bankcontact_id: number; slots: SyncSlot[] }> {
  return apiFetch(`/finance/bankcontacts/${id}/schedule`, {
    method: 'PUT',
    body: JSON.stringify({ id, slots }),
  })
}

// ----------------------------------------------------------------------
// Accounts
// ----------------------------------------------------------------------

export interface Account {
  id: number
  /** null for manual accounts. */
  bankcontact_id: number | null
  /** null when bankcontact_id is null. */
  bankcontact_name: string | null
  /** lib-fints accountNumber of the linked bank-side account, null
   *  when the account is manual. */
  fints_account_number: string | null
  type_kind: string
  type_label: string
  currency_code: string
  currency_symbol: string
  iban: string | null
  account_number: string
  label: string
  active: boolean
  created_at: string | null
  /** Number of users with an explicit ACL entry (read/write) on this
   *  account. 0 means non-admin users can't see it yet — surfaced so
   *  the admin assignment view can flag accounts that still need to
   *  be wired up after a Finanzkraft import. */
  access_count: number
}

export interface CreateAccountInput {
  /** Optional: omit for a manual account. */
  bankcontact_id?: number
  /** Required iff bankcontact_id is set — lib-fints accountNumber. */
  fints_account_number?: string
  type_kind: string
  currency_code: string
  iban?: string
  account_number: string
  label: string
}

export interface LinkAccountInput {
  bankcontact_id: number
  fints_account_number: string
}

export interface UpdateAccountInput {
  label?: string
  iban?: string | null
  active?: boolean
  type_kind?: string
  currency_code?: string
  account_number?: string
}

export async function listAccounts(): Promise<{ items: Account[] }> {
  return apiFetch('/finance/accounts')
}

export async function getAccount(id: number): Promise<Account> {
  return apiFetch(`/finance/accounts/${id}`)
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  return apiFetch('/finance/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateAccount(
  id: number,
  input: UpdateAccountInput,
): Promise<Account> {
  return apiFetch(`/finance/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ id, ...input }),
  })
}

export interface DeleteAccountResponse {
  deleted: true
  transactions_deleted: number
  balances_deleted: number
}

export async function deleteAccount(
  id: number,
): Promise<DeleteAccountResponse> {
  return apiFetch(`/finance/accounts/${id}`, { method: 'DELETE' })
}

export async function linkAccount(
  id: number,
  input: LinkAccountInput,
): Promise<Account> {
  return apiFetch(`/finance/accounts/${id}/link`, {
    method: 'POST',
    body: JSON.stringify({ id, ...input }),
  })
}

export async function unlinkAccount(id: number): Promise<Account> {
  return apiFetch(`/finance/accounts/${id}/unlink`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

// ----------------------------------------------------------------------
// Account access (ACL) — admin only
// ----------------------------------------------------------------------

export interface AccessEntry {
  user_id: number
  user_email: string
  user_name: string
  level: 'read' | 'write'
}

export async function listAccess(accountId: number): Promise<{
  items: AccessEntry[]
}> {
  return apiFetch(`/finance/admin/access/${accountId}`)
}

export async function putAccess(
  accountId: number,
  entries: Array<{ user_id: number; level: 'read' | 'write' }>,
): Promise<{
  items: AccessEntry[]
  diff: { inserted: number; updated: number; deleted: number }
}> {
  return apiFetch(`/finance/admin/access/${accountId}`, {
    method: 'PUT',
    body: JSON.stringify({ accountId, entries }),
  })
}

// ----------------------------------------------------------------------
// Transactions
// ----------------------------------------------------------------------

export interface TagOnTransaction {
  name: string
  source: 'user' | 'ai'
  confidence: number | null
}

export interface Transaction {
  id: number
  account_id: number
  booking_date: string
  value_date: string | null
  amount: string
  currency_code: string
  purpose: string | null
  counterparty: string | null
  counterparty_iban: string | null
  tags: TagOnTransaction[]
  created_at: string | null
}

export interface ListTransactionsQuery {
  accountId?: number
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export async function listTransactions(
  q: ListTransactionsQuery = {},
): Promise<{ items: Transaction[]; total: number }> {
  const params = new URLSearchParams()
  if (q.accountId !== undefined) params.set('accountId', String(q.accountId))
  if (q.from) params.set('from', q.from)
  if (q.to) params.set('to', q.to)
  if (q.limit !== undefined) params.set('limit', String(q.limit))
  if (q.offset !== undefined) params.set('offset', String(q.offset))
  const qs = params.toString()
  return apiFetch(`/finance/transactions${qs ? '?' + qs : ''}`)
}

export async function getTransaction(id: number): Promise<Transaction> {
  return apiFetch(`/finance/transactions/${id}`)
}

export interface CreateTransactionInput {
  account_id: number
  booking_date: string
  value_date?: string | null
  amount: number | string
  currency_code?: string
  purpose?: string
  counterparty?: string
  counterparty_iban?: string
  tags?: string[]
}

export async function createTransaction(
  input: CreateTransactionInput,
): Promise<Transaction> {
  return apiFetch('/finance/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function promoteAiTag(
  id: number,
  tag: string,
): Promise<{ promoted: boolean; tags: TagOnTransaction[] }> {
  return apiFetch(`/finance/transactions/${id}/tags/promote`, {
    method: 'POST',
    body: JSON.stringify({ id, tag }),
  })
}

export interface BatchTagInput {
  transaction_ids: number[]
  add?: string[]
  remove?: string[]
  replace?: boolean
}

export async function batchTag(input: BatchTagInput): Promise<{
  affected_transactions: number
  added_links: number
  removed_links: number
}> {
  return apiFetch('/finance/transactions/batch-tag', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// ----------------------------------------------------------------------
// Tags
// ----------------------------------------------------------------------

export interface Tag {
  id: number
  name: string
  source: 'user' | 'ai'
  created_at: string | null
}

export async function listTags(
  source: 'user' | 'ai' | 'all' = 'user',
): Promise<{ items: Tag[] }> {
  return apiFetch(`/finance/tags?source=${source}`)
}

export async function suggestTagsBatch(
  q: { accountId?: number; from?: string; to?: string; limit?: number } = {},
): Promise<{ attempted: number; succeeded: number }> {
  return apiFetch('/finance/tags/suggest', {
    method: 'POST',
    body: JSON.stringify(q),
  })
}

// ----------------------------------------------------------------------
// Admin: Finanzkraft import
// ----------------------------------------------------------------------

export interface ImportResponse {
  counts: {
    currencies: number
    bankcontacts: number
    accounts: number
    transactions: number
    tags: number
    tag_links: number
  }
  skipped: {
    currencies: number
    bankcontacts: number
    accounts: number
    transactions: number
    tags: number
    tag_links: number
  }
  errors: Array<{ entity: string; row: number; message: string }>
}

export async function importFinanzkraft(
  exportJson: unknown,
  options: { wipeFirst?: boolean } = {},
): Promise<ImportResponse> {
  return apiFetch('/finance/admin/import', {
    method: 'POST',
    body: JSON.stringify({
      export: exportJson,
      wipe_first: options.wipeFirst === true,
    }),
    // Large imports can take a while — allow up to 5 minutes before
    // the client aborts.
    timeoutMs: 5 * 60_000,
  })
}

// ----------------------------------------------------------------------
// Analysis (Etappe 9)
// ----------------------------------------------------------------------

export interface AnalysisAst {
  tags: string[]
  op: 'AND' | 'OR'
  timespan?: { from: string; to: string }
  amountRange?: { min?: number; max?: number }
}

export interface AnalysisResult {
  ast: AnalysisAst
  total: { sum: string; count: number; avg: string }
  byMonth: Array<{ month: string; sum: string; count: number }>
  topCounterparties: Array<{ name: string; sum: string; count: number }>
}

export async function analysisQuery(params: {
  question: string
  timespanHint?: string
  accountIds?: number[]
}): Promise<AnalysisResult> {
  return apiFetch('/finance/analysis/query', {
    method: 'POST',
    body: JSON.stringify(params),
    // LLM parse can take a few seconds; keep the default timeout
    // (2 min) but extend to 3 to be safe.
    timeoutMs: 3 * 60_000,
  })
}

export async function analysisAggregate(params: {
  ast: AnalysisAst
  accountIds?: number[]
}): Promise<AnalysisResult> {
  return apiFetch('/finance/analysis/aggregate', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}
