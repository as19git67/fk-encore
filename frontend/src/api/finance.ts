/**
 * Typed client for the `finance` backend service.
 *
 * All endpoints are gated server-side by `finance.view` or a stricter
 * permission (see finance-service-layout.md §3). The types here mirror
 * the DTOs in finance/*.ts.
 */

import { apiFetch, API_BASE_URL } from './client'

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
      /** Matched accounts skipped because they are closed. */
      accounts_closed?: number
      /** Accounts the bank reported that are not linked yet. */
      accounts_unknown?: number
      /** Bank-side account snapshots waiting for link/import in the UI. */
      unknown_accounts?: UnknownBankAccount[]
      /** Rows inserted into finance_transaction (new only; duplicates skipped silently). */
      transactions_inserted?: number
      /** Rows inserted into finance_account_balance. */
      balances_written?: number
      /** Holding rows written/upserted for depot accounts. */
      holdings_written?: number
      /** True when any per-account fetch hit a mid-flight TAN we skipped. */
      partial?: boolean
      /** Per-account bank answers/exceptions when partial=true. Format
       *  "account <num>: <kind>:<code> <text>" — e.g.
       *  "account 12345: statements-error:3010 Keine Buchungen vorhanden". */
      errors?: string[]
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
  /** Non-null timestamp when the account is closed. Closed accounts are
   *  read-only — sync skips them and the manual booking endpoint refuses
   *  inserts. Patch with `closed_at: null` to reopen. */
  closed_at: string | null
  created_at: string | null
  /** Number of users with an explicit ACL entry (read/write) on this
   *  account. 0 means non-admin users can't see it yet — surfaced so
   *  the admin assignment view can flag accounts that still need to
   *  be wired up after a bulk data import. */
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
  /** ISO timestamp → close as of that moment. null → reopen. Omit to
   *  leave the close-state untouched. */
  closed_at?: string | null
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

// closeAccount / reopenAccount removed — both flows are now expressed
// as `updateAccount(id, { closed_at: <iso> | null })`.

// ----------------------------------------------------------------------
// Holdings (depot accounts)
// ----------------------------------------------------------------------

export type CostBasisSource = 'bank' | 'tx-wac' | null

export interface Holding {
  id: number
  account_id: number
  as_of: string
  isin: string | null
  wkn: string | null
  name: string | null
  amount: string | null
  price: string | null
  value: string | null
  currency: string | null
  acquisition_date: string | null
  acquisition_price: string | null
  cost_basis_per_unit: string | null
  cost_basis: string | null
  cost_basis_source: CostBasisSource
  unrealized_gain: string | null
  unrealized_gain_pct: string | null
  /** Sum of realized G/V from past sells, WAC-based (scale 2, signed). null when no sells. */
  realized_gain: string | null
  /** False when some buy/sell txs lacked qty/price/net_amount data. */
  realized_gain_complete: boolean
}

export interface ListHoldingsResponse {
  items: Holding[]
  as_of: string | null
}

export async function listHoldings(
  accountId: number,
  opts: { asOf?: string } = {},
): Promise<ListHoldingsResponse> {
  const params = new URLSearchParams()
  if (opts.asOf) params.set('asOf', opts.asOf)
  const qs = params.toString()
  return apiFetch(`/finance/accounts/${accountId}/holdings${qs ? '?' + qs : ''}`)
}

// Realized G/V per tax year

export interface RealizedYearBucket {
  year: number
  realized: string
  sell_count: number
  /** False if any contributing position had incomplete buy/sell data. */
  complete: boolean
}

export interface RealizedByYearResponse {
  years: RealizedYearBucket[]
  complete: boolean
  currency: string
}

export async function getRealizedByYear(
  accountId: number,
): Promise<RealizedByYearResponse> {
  return apiFetch(`/finance/accounts/${accountId}/realized-by-year`)
}

// Holdings history (Phase 1 of #439 / #428)

export interface HoldingsHistoryPoint {
  as_of: string
  amount: string | null
  price: string | null
  value: string | null
}

export interface HoldingsHistoryPosition {
  key: string
  isin: string | null
  wkn: string | null
  name: string | null
  currency: string | null
  points: HoldingsHistoryPoint[]
}

export interface HoldingsHistoryTotal {
  as_of: string
  total_value: string
  currency: string | null
}

export interface HoldingsHistoryResponse {
  totals: HoldingsHistoryTotal[]
  positions: HoldingsHistoryPosition[]
  from: string | null
  to: string | null
}

export async function getHoldingsHistory(
  accountId: number,
  opts: { from?: string; to?: string } = {},
): Promise<HoldingsHistoryResponse> {
  const params = new URLSearchParams()
  if (opts.from) params.set('from', opts.from)
  if (opts.to) params.set('to', opts.to)
  const qs = params.toString()
  return apiFetch(
    `/finance/accounts/${accountId}/holdings/history${qs ? '?' + qs : ''}`,
  )
}

// Depot transactions (Phase 2 of #439 / #428)

export type DepotTransactionKind =
  | 'buy'
  | 'sell'
  | 'in'
  | 'out'
  | 'dividend'
  | 'split'
  | 'corp_action'

export interface DepotTransaction {
  id: number
  account_id: number
  isin: string | null
  wkn: string | null
  name: string | null
  kind: string
  executed_at: string
  amount: string | null
  price: string | null
  gross_amount: string | null
  fees: string | null
  tax: string | null
  net_amount: string | null
  currency: string | null
  source: string
  linked_transaction_id: number | null
  note: string | null
  created_at: string | null
}

export interface CreateDepotTransactionInput {
  isin?: string | null
  wkn?: string | null
  name?: string | null
  kind: DepotTransactionKind
  executed_at: string
  amount?: number | string | null
  price?: number | string | null
  gross_amount?: number | string | null
  fees?: number | string | null
  tax?: number | string | null
  net_amount?: number | string | null
  currency?: string | null
  note?: string | null
}

export async function listDepotTransactions(
  accountId: number,
  opts: { isin?: string; wkn?: string } = {},
): Promise<{ items: DepotTransaction[] }> {
  const params = new URLSearchParams()
  if (opts.isin) params.set('isin', opts.isin)
  if (opts.wkn) params.set('wkn', opts.wkn)
  const qs = params.toString()
  return apiFetch(
    `/finance/accounts/${accountId}/depot-transactions${qs ? '?' + qs : ''}`,
  )
}

export async function createDepotTransaction(
  accountId: number,
  input: CreateDepotTransactionInput,
): Promise<DepotTransaction> {
  return apiFetch(`/finance/accounts/${accountId}/depot-transactions`, {
    method: 'POST',
    body: JSON.stringify({ id: accountId, ...input }),
  })
}

export async function deleteDepotTransaction(
  txId: number,
): Promise<{ deleted: true }> {
  return apiFetch(`/finance/depot-transactions/${txId}`, { method: 'DELETE' })
}

export interface DeriveDepotTransactionsResponse {
  derived: number
  skipped: number
  duplicates: number
  errors: string[]
}

export async function deriveDepotTransactionsFromGiro(
  accountId: number,
): Promise<DeriveDepotTransactionsResponse> {
  return apiFetch(
    `/finance/accounts/${accountId}/depot-transactions/derive`,
    {
      method: 'POST',
      body: JSON.stringify({ id: accountId }),
    },
  )
}

// ----------------------------------------------------------------------
// Overview (configurable landing page)
// ----------------------------------------------------------------------

export interface OverviewAccount {
  id: number
  label: string
  type_kind: string
  type_label: string
  currency_code: string
  currency_symbol: string
  /** Latest balance (numeric as string) or null when none recorded yet. */
  balance: string | null
  /** ISO timestamp of the latest balance row, null when none. */
  balance_as_of: string | null
  /** Count of recent transactions still without a user-source tag. */
  pending_count: number
}

export interface OverviewSection {
  name: string
  accounts: OverviewAccount[]
}

export interface OverviewResponse {
  user_email: string
  sections: OverviewSection[]
  unassigned: OverviewAccount[]
  /** True when no user config is saved yet — UI surfaces a hint. */
  is_default: boolean
}

export interface SaveOverviewSection {
  name: string
  account_ids: number[]
}

export interface SaveOverviewResponse {
  saved: true
  sections_saved: number
  accounts_saved: number
}

export async function getOverview(): Promise<OverviewResponse> {
  return apiFetch('/finance/overview')
}

export async function saveOverview(
  sections: SaveOverviewSection[],
): Promise<SaveOverviewResponse> {
  return apiFetch('/finance/overview', {
    method: 'PUT',
    body: JSON.stringify({ sections }),
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
  counterparty_bic: string | null
  end_to_end_ref: string | null
  mandate_ref: string | null
  creditor_id: string | null
  bank_ref: string | null
  originator_name: string | null
  recipient_name: string | null
  funds_code: string | null
  transaction_type: string | null
  transaction_code: string | null
  entry_text: string | null
  prima_nota_no: string | null
  original_amount: string | null
  original_currency_code: string | null
  exchange_rate: string | null
  notice: string | null
  tags: TagOnTransaction[]
  created_at: string | null
}

export interface ListTransactionsQuery {
  accountId?: number
  /** Multiple account ids — used by the overview's "Alle Buchungen"
   *  view to pool transactions across all accounts of a section. */
  accountIds?: number[]
  /** Free-text or amount search (matches counterparty/purpose, or
   *  exact |amount| when the value parses as a number). */
  q?: string
  /** Filter by tag names (any-of match across user + ai tags). */
  tags?: string[]
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
  if (q.accountIds && q.accountIds.length > 0) {
    params.set('accountIdsCsv', q.accountIds.join(','))
  }
  if (q.q && q.q.trim().length > 0) params.set('q', q.q.trim())
  if (q.tags && q.tags.length > 0) params.set('tagsCsv', q.tags.join(','))
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
  receipt_document_id?: number
}

export async function createTransaction(
  input: CreateTransactionInput,
): Promise<Transaction> {
  return apiFetch('/finance/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export interface UpdateTransactionInput {
  notice?: string | null
  booking_date?: string
  value_date?: string | null
  amount?: string | number
  counterparty?: string | null
  purpose?: string | null
}

export async function updateTransaction(
  id: number,
  input: UpdateTransactionInput,
): Promise<Transaction> {
  return apiFetch(`/finance/transactions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function deleteTransaction(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/finance/transactions/${id}`, { method: 'DELETE' })
}

export interface BatchNoticeInput {
  transaction_ids: number[]
  notice: string
  mode: 'replace' | 'append'
}

export interface BatchNoticeResponse {
  affected_transactions: number
  skipped_unauthorized: number
}

export async function batchNotice(
  input: BatchNoticeInput,
): Promise<BatchNoticeResponse> {
  return apiFetch('/finance/transactions/batch-notice', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * Fetches the CSV export for `ids` and triggers a browser download.
 * The endpoint streams text/csv with a UTF-8 BOM so Excel opens
 * umlauts correctly; we read it as a Blob, build an object URL, and
 * click a hidden anchor.
 */
export async function downloadTransactionsCsv(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const token = localStorage.getItem('auth_token')
  const url = `${API_BASE_URL}/finance/transactions/export?ids=${ids.join(',')}`
  const resp = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!resp.ok) {
    throw new Error(`Export fehlgeschlagen (${resp.status})`)
  }
  const blob = await resp.blob()
  const disposition = resp.headers.get('Content-Disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  const filename =
    match?.[1] ?? `basket-${new Date().toISOString().slice(0, 10)}.csv`
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}

export interface RecentRecipient {
  counterparty: string
  tags: string[]
}

export async function recentCashRecipients(): Promise<{ items: RecentRecipient[] }> {
  return apiFetch('/finance/transactions/recent-cash-recipients')
}

export async function searchRecipients(q: string): Promise<{ items: RecentRecipient[] }> {
  return apiFetch(`/finance/transactions/recipients?q=${encodeURIComponent(q)}`)
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

export async function rejectAiTag(
  id: number,
  tag: string,
): Promise<{ rejected: boolean; tags: TagOnTransaction[] }> {
  return apiFetch(`/finance/transactions/${id}/tags/reject`, {
    method: 'POST',
    body: JSON.stringify({ id, tag }),
  })
}

export interface BatchTagInput {
  transaction_ids: number[]
  add?: string[]
  remove?: string[]
  replace?: boolean
  promote_ai_tags?: boolean
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
// Admin: data import
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

export async function importFinanceData(
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

export interface RelativeTimespan {
  type: 'this_year' | 'last_year' | 'last_n_years' | 'last_n_months' | 'this_month' | 'last_month'
  n?: number
}

export interface TagGroup {
  tags: string[]
  op: 'AND' | 'OR'
}

export interface AnalysisAst {
  tags: string[]
  op: 'AND' | 'OR'
  timespan?: { from: string; to: string }
  amountRange?: { min?: number; max?: number }
  /** "event" = bounded one-off (a trip); "ongoing" = recurring spending. */
  kind?: 'event' | 'ongoing'
  /** Aggregation granularity for ongoing analyses. */
  interval?: 'month' | 'year'
  /** Relative time reference for saved queries that auto-adjust over time. */
  relativeTimespan?: RelativeTimespan
  /**
   * Grouped tag expressions for complex filters (e.g. "Restaurant AND
   * (TagA OR TagB)"). When present and non-empty, takes precedence over
   * flat `tags`/`op`. UI-driven — the LLM continues producing flat format.
   */
  tagGroups?: TagGroup[]
  /** Logical operator joining the tag groups. Defaults to 'AND'. */
  groupOp?: 'AND' | 'OR'
}

export interface AnalysisResult {
  ast: AnalysisAst
  total: { sum: string; count: number; avg: string }
  byPeriod: Array<{ period: string; sum: string; count: number }>
  byTag: Array<{ tag: string; sum: string; count: number }>
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

export interface AnalysisTransaction {
  id: number
  bookingDate: string
  amount: string
  currency: string
  counterparty: string | null
  purpose: string | null
}

export async function analysisTransactions(params: {
  ast: AnalysisAst
  tag: string
  accountIds?: number[]
  limit?: number
}): Promise<{ transactions: AnalysisTransaction[] }> {
  return apiFetch('/finance/analysis/transactions', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function analysisPeriodTransactions(params: {
  ast: AnalysisAst
  period: string
  accountIds?: number[]
  limit?: number
}): Promise<{ transactions: AnalysisTransaction[] }> {
  return apiFetch('/finance/analysis/period-transactions', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

// ----------------------------------------------------------------------
// Saved Analysis
// ----------------------------------------------------------------------

export interface SavedAnalysisSummary {
  sum: string
  count: number
  avg: string
}

export interface SavedAnalysisItem {
  id: number
  name: string
  question: string | null
  ast: AnalysisAst
  source: 'user' | 'ai'
  summary: SavedAnalysisSummary | null
  seenAt: string | null
  createdAt: string
  updatedAt: string
}

export async function listSavedAnalyses(params?: {
  limit?: number
  before?: string
  source?: 'user' | 'ai' | 'all'
}): Promise<{ items: SavedAnalysisItem[]; hasMore: boolean }> {
  return apiFetch('/finance/saved-analysis/list', {
    method: 'POST',
    body: JSON.stringify(params ?? {}),
  })
}

export async function saveAnalysis(params: {
  name: string
  question?: string
  ast: AnalysisAst
  summary?: SavedAnalysisSummary
}): Promise<SavedAnalysisItem> {
  return apiFetch('/finance/saved-analysis', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function updateSavedAnalysis(params: {
  id: number
  name?: string
  ast?: AnalysisAst
  summary?: SavedAnalysisSummary
}): Promise<SavedAnalysisItem> {
  return apiFetch(`/finance/saved-analysis/${params.id}`, {
    method: 'PUT',
    body: JSON.stringify(params),
  })
}

export async function deleteSavedAnalysis(id: number): Promise<void> {
  return apiFetch(`/finance/saved-analysis/${id}`, {
    method: 'DELETE',
  })
}

export async function markSavedAnalysesSeen(ids: number[]): Promise<void> {
  return apiFetch('/finance/saved-analysis/mark-seen', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

// ----------------------------------------------------------------------
// Tag Queue (admin)
// ----------------------------------------------------------------------

export interface TagQueueServiceStatus {
  pending: number
  processing: number
  failed: number
  done: number
}

export interface TagQueueStatusResponse {
  status: TagQueueServiceStatus
}

export async function getFinanceTagQueueStatus(): Promise<TagQueueStatusResponse> {
  return apiFetch('/finance/tag-queue/status', { method: 'GET' })
}

export async function retryFailedFinanceTagJobs(): Promise<{ requeued: number }> {
  return apiFetch('/finance/tag-queue/retry-failed', { method: 'POST', body: '{}' })
}

export async function cancelPendingFinanceTagJobs(): Promise<{ cancelled: number }> {
  return apiFetch('/finance/tag-queue/cancel', { method: 'POST', body: '{}' })
}

export async function reenqueueAllFinanceTagJobs(): Promise<{ enqueued: number }> {
  return apiFetch('/finance/tag-queue/reenqueue', { method: 'POST', body: '{}' })
}

export interface AnomalyRunResult {
  accounts: number
  transactions_processed: number
  mandates_created: number
  mandates_updated: number
  anomalies_created: number
}

export async function runAnomalyDetection(reset = false): Promise<AnomalyRunResult> {
  return apiFetch('/finance/anomalies/run', {
    method: 'POST',
    body: JSON.stringify({ reset }),
  })
}

export interface DuplicateTransactionInfo {
  id: number
  booking_date: string
  amount: string
  purpose: string | null
}

export interface AnomalyItem {
  id: number
  type: 'amount_change' | 'duplicate' | 'new_mandate' | 'missing_transaction' | string
  score: number
  details: Record<string, unknown>
  created_at: string
  transaction_id: number | null
  mandate_id: number | null
  counterparty: string | null
  message: string
  duplicate_transactions?: DuplicateTransactionInfo[]
}

export interface ListAnomaliesResponse {
  anomalies: AnomalyItem[]
  total: number
}

export async function listAnomalies(): Promise<ListAnomaliesResponse> {
  return apiFetch('/finance/anomalies')
}

export async function acknowledgeAnomaly(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/finance/anomalies/${id}/acknowledge`, { method: 'POST', body: '{}' })
}

export interface MandateHistoryItem {
  id: number
  booking_date: string
  amount: string
  purpose: string | null
}

export interface MandateHistoryResponse {
  mandate_id: number
  counterparty: string | null
  items: MandateHistoryItem[]
}

export async function getMandateHistory(mandateId: number): Promise<MandateHistoryResponse> {
  return apiFetch(`/finance/mandates/${mandateId}/history`)
}

export interface RelatedRecurringResponse {
  /** null when the transaction is not part of any tracked recurring series. */
  mandate_id: number | null
  counterparty: string | null
  items: MandateHistoryItem[]
}

export async function getRelatedRecurringTransactions(
  transactionId: number,
): Promise<RelatedRecurringResponse> {
  return apiFetch(`/finance/transactions/${transactionId}/recurring`)
}

export interface DocumentMatchSuggestion {
  id: number
  transaction_id: number
  document_id: number
  score: number
  amount_score: number
  date_score: number
  text_score: number
  outcome: 'pending' | 'accepted' | 'rejected' | 'ignored'
  title: string | null
  original_filename: string
  sender: string | null
  doc_date: string | null
  summary: string | null
  extracted_text_preview: string | null
  tags: string[]
}
export async function suggestDocumentsForTransactions(transaction_ids: number[]) { const response = await apiFetch<{ items: DocumentMatchSuggestion[] }>('/finance/document-matches/suggest', { method: 'POST', body: JSON.stringify({ transaction_ids }) }); return response.items }
export async function decideDocumentMatch(id: number, outcome: 'accepted' | 'rejected' | 'ignored') { return apiFetch<{ ok: boolean }>(`/finance/document-matches/${id}/decision`, { method: 'POST', body: JSON.stringify({ outcome }) }) }
export async function getTransactionDocumentLinks(transactionId: number) { const response = await apiFetch<{ items: Array<{ document_id: number; title: string | null; original_filename: string }> }>(`/finance/transactions/${transactionId}/documents`); return response.items }
export async function getDocumentTransactionLinks(documentId: number) { const response = await apiFetch<{ items: Array<{ transaction_id: number; booking_date: string; amount: string; counterparty: string | null }> }>(`/finance/documents/${documentId}/transactions`); return response.items }
export async function getDocumentMatchMetrics() { return apiFetch<{ high: Record<string, number>; medium: Record<string, number>; low: Record<string, number> }>('/finance/document-matches/metrics') }

export interface ReceiptEnrichmentItem {
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

export async function getPendingReceiptEnrichments(): Promise<{ items: ReceiptEnrichmentItem[] }> {
  return apiFetch('/finance/receipt-enrichments/pending')
}

export async function dismissReceiptEnrichment(transactionId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/finance/receipt-enrichments/${transactionId}/dismiss`, { method: 'POST', body: '{}' })
}

export async function unlinkTransactionDocument(transaction_id: number, document_id: number) { return apiFetch<{ ok: boolean }>('/finance/document-matches/unlink', { method: 'POST', body: JSON.stringify({ transaction_id, document_id }) }) }
export async function linkDocumentsToTransactions(transaction_ids: number[], document_ids: number[]) { return apiFetch<{ linked: number }>('/finance/document-matches/link', { method: 'POST', body: JSON.stringify({ transaction_ids, document_ids }) }) }
