/**
 * The assistant's API (documentation/plans/ki-assistent.md, stages 2 and 3).
 *
 * A question is a POST with the full bearer token; the answer arrives over a
 * WebSocket that only watches the turn. The client picks the turn id, opens
 * the stream first, then posts, so the stream sees every event — and if the
 * socket fails, the POST still returns the whole answer.
 */

import { API_BASE_URL, apiFetch, ensureFreshToken } from './client'

export type BlockKind =
  | 'accounts' | 'transactions' | 'analysis' | 'debits' | 'categories'
  | 'documents' | 'document' | 'photos' | 'recaps' | 'albums'
  | 'meters' | 'readings' | 'consumption' | 'trip_plans'
  | 'positions' | 'depot_transactions' | 'quotes' | 'news' | 'comments' | 'activity' | 'businesses' | 'business_assets' | 'euer' | 'table' | 'proposal'

/** Rows a tool returned, for display beside the answer. */
export interface ResultBlock {
  kind: BlockKind
  tool: string
  rows: Record<string, unknown>[]
  total?: number
  /** A list page showing the same set, e.g. `/dokumente?q=…`. */
  route?: string
  /** A line under the title: the account and its balance of a booking list. */
  subtitle?: string
}

export interface ConversationSummary {
  id: number
  title: string | null
  created_at: string
  updated_at: string
}

export interface ConversationMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  blocks: ResultBlock[]
  created_at: string
}

/** An object handed to the assistant: a document, photo or booking (#1534). */
export interface ContextRef {
  type: 'document' | 'photo' | 'transaction'
  id: number
}

/** One object of a conversation's working set, as the chip shows it. */
export interface ContextItem extends ContextRef {
  label: string
  visible: boolean
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[]
  context: ContextItem[]
}

export interface AskResponse {
  answer: string
  blocks: ResultBlock[]
  message_id: number
  rounds: number
}

/** One event of a running turn, as the stream sends it. */
export interface StreamEvent {
  type: 'token' | 'retract' | 'tool_start' | 'tool_result' | 'done' | 'error' | 'cancelled'
  text?: string
  tool?: string
  arguments?: Record<string, unknown>
  row_count?: number
  block?: ResultBlock
  error?: string
  answer?: string
  blocks?: ResultBlock[]
  message?: string
}

export function listConversations(): Promise<{ conversations: ConversationSummary[] }> {
  return apiFetch('/assistant/conversations')
}

export function createConversation(title?: string, context?: ContextRef[]): Promise<ConversationSummary> {
  const body: { title?: string; context?: ContextRef[] } = {}
  if (title) body.title = title
  if (context?.length) body.context = context
  return apiFetch('/assistant/conversations', { method: 'POST', body: JSON.stringify(body) })
}

export function setConversationContext(id: number, context: ContextRef[]): Promise<{ context: ContextItem[] }> {
  return apiFetch(`/assistant/conversations/${id}/context`, { method: 'PUT', body: JSON.stringify({ context }) })
}

export function getConversation(id: number): Promise<ConversationDetail> {
  return apiFetch(`/assistant/conversations/${id}`)
}

export function deleteConversation(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/assistant/conversations/${id}`, { method: 'DELETE' })
}

/** A write action the assistant proposed; it runs only when the user says so (#1529). */
export interface Proposal {
  proposal_id: number
  tool: string
  summary: string
  count: number | null
  status: 'pending' | 'executing' | 'executed' | 'discarded'
  result_summary: string | null
  result_route: string | null
  /** An API path to download the result from, e.g. a report's PDF. */
  result_download: string | null
  error: string | null
  /** A letter the user can change before it goes out (#1534). */
  letter: LetterDraft | null
  /** A text document the proposal would file: title and Markdown. */
  text_document: { title: string; markdown: string } | null
}

export type LetterDestination = 'document' | 'collection'

export interface LetterDraft {
  sender: string
  recipient: string
  subject: string
  body: string
  attachments: { id: number; title: string }[]
  destinations: LetterDestination[]
  /** What the model left as `[[…]]` for the user to fill in. */
  gaps: string[]
}

/** What the user changed on a proposal's card. */
export interface ProposalEdits {
  sender?: string
  recipient?: string
  subject?: string
  body?: string
  destinations?: LetterDestination[]
  attachment_ids?: number[]
}

export function executeProposal(id: number, edits?: ProposalEdits): Promise<Proposal> {
  // The endpoint reads `edits` from the body, so Encore parses the body on
  // every call: an empty one fails with "EOF while parsing a value". A card
  // without edits sends an empty object.
  return apiFetch(`/assistant/proposals/${id}/execute`, {
    method: 'POST',
    body: JSON.stringify(edits ? { edits } : {}),
  })
}

/** Downloads a file the API serves behind the user's token, under the name it suggests. */
export async function downloadResult(path: string): Promise<void> {
  const token = localStorage.getItem('auth_token')
  const resp = await fetch(`${API_BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    cache: 'no-store',
  })
  if (!resp.ok) throw new Error(`Download fehlgeschlagen (${resp.status})`)
  const blob = await resp.blob()
  const match = /filename="([^"]+)"/.exec(resp.headers.get('Content-Disposition') ?? '')
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = match?.[1] ?? 'ergebnis.pdf'
  anchor.click()
  URL.revokeObjectURL(url)
}

export function discardProposal(id: number): Promise<Proposal> {
  return apiFetch(`/assistant/proposals/${id}/discard`, { method: 'POST' })
}

/** Several model rounds and tool calls; give it longer than a list load. */
const ASK_TIMEOUT_MS = 5 * 60_000

export function ask(conversationId: number, message: string, turnId?: string): Promise<AskResponse> {
  return apiFetch(`/assistant/conversations/${conversationId}/ask`, {
    method: 'POST',
    body: JSON.stringify({ message, turnId }),
    timeoutMs: ASK_TIMEOUT_MS,
  })
}

/**
 * Lets the assistant write text for the document editor: `instruction` says
 * what, `text` (optional) is the document so far. Nothing is stored; the
 * Markdown comes back for the editor to insert.
 */
export function composeText(payload: { instruction: string; title?: string; text?: string }): Promise<{ markdown: string }> {
  return apiFetch('/assistant/compose', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: ASK_TIMEOUT_MS,
  })
}

/**
 * Stops a running answer. The waiting `ask` then fails with `canceled`;
 * `cancelled: false` means the answer was already finished.
 */
export function cancelTurn(turnId: string): Promise<{ cancelled: boolean }> {
  return apiFetch(`/assistant/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST' })
}

/** A turn id the server accepts: 8 to 64 letters, digits, '-' or '_'. */
export function newTurnId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `t-${random}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}

export interface TurnStream {
  /** Resolves once the socket is open (or failed to open). */
  ready: Promise<boolean>
  close: () => void
}

/**
 * Follows one turn. Each WebSocket frame is one JSON event; the server
 * closes the socket after `done` or `error`. Failure to connect is not an
 * error for the caller — the POST still delivers the answer.
 */
export function followTurn(turnId: string, onEvent: (event: StreamEvent) => void): TurnStream {
  let socket: WebSocket | null = null
  let closed = false
  const ready = (async () => {
    try {
      await ensureFreshToken()
    } catch {
      return false
    }
    if (closed || typeof WebSocket === 'undefined') return false
    const token = localStorage.getItem('auth_token') ?? ''
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}${API_BASE_URL}/assistant/turns/${encodeURIComponent(turnId)}/stream?token=${encodeURIComponent(token)}`
    return await new Promise<boolean>((resolve) => {
      try {
        socket = new WebSocket(url)
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => resolve(false), 3000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
      socket.addEventListener('message', (msg) => {
        if (typeof msg.data !== 'string') return
        try {
          onEvent(JSON.parse(msg.data) as StreamEvent)
        } catch {
          // a frame that is not JSON is not ours
        }
      })
    })
  })()
  return {
    ready,
    close() {
      closed = true
      try { socket?.close() } catch { /* already closed */ }
    },
  }
}

// ── Ausfüllhilfe (tax worksheet), straight from the Steuer page ──────────

export interface TaxWorksheetDocument {
  id: number
  title: string
  date: string | null
  from: string | null
  confidence: number | null
}

export interface TaxWorksheetSection {
  slug: string
  name: string
  group: string
  documents: TaxWorksheetDocument[]
}

export interface TaxWorksheetTag {
  tag: string
  count: number
  /** EUR, negative = paid. */
  sum: number
}

/** Amounts in EUR. */
export interface TaxWorksheetBusiness {
  id: number
  name: string
  kind: string
  tax_section: string
  income: number
  expenses: number
  afa: number
  result: number
  bookings: number
  hints: string[]
  exempt: boolean | null
}

export interface TaxWorksheetDepot {
  year: number
  realized: string
  sell_count: number
  realized_complete: boolean
  income: string
  dividend_count: number
  fees: string
  taxes: string
}

export type TaxValueStatus = 'read' | 'rejected' | 'confirmed' | 'corrected'

/** One document's part of a form value (amounts in cents). */
export interface TaxFormContribution {
  value_id: number
  document_id: number
  document_title: string
  evidence_kind: string
  evidence_kind_name: string
  field_label: string
  /** What the document adds to the form value (half of a shared value). */
  cents: number
  /** The value as stored on the evidence. */
  value_cents: number
  printed: string | null
  quote: string | null
  page: number | null
  status: TaxValueStatus
  note: string | null
}

/** One field of the form for one owner (amounts in cents). */
export interface TaxFormValue {
  key: string
  anlage: string
  anlage_name: string
  label: string
  owner: string
  owner_label: string
  line: number | null
  kennzahl: string | null
  /** "Zeile 5 · Kz 110", "Zeile 13 (ohne Kennzahl)", "Kennzahl prüfen". */
  place: string
  checked: boolean
  source: string | null
  form_note: string | null
  prefilled: boolean
  cents: number
  contributions: TaxFormContribution[]
  notes: string[]
  /** Contributions not confirmed or corrected yet. */
  open: number
  /** The same field and owner last year, in cents; null when there was none. */
  previous_cents: number | null
}

/** A field with a value last year and none this year. */
export interface TaxFormMissing {
  key: string
  anlage_name: string
  label: string
  owner_label: string
  place: string
  previous_cents: number
  previous_documents: { document_id: number; document_title: string }[]
}

export interface TaxFormSkipped {
  value_id: number
  document_id: number
  document_title: string
  evidence_kind_name: string
  field_label: string
  form_label: string | null
  value_cents: number
  printed: string | null
  quote: string | null
  status: TaxValueStatus
  reason: string
  note: string | null
}

/** The documents' values by Anlage, line and Kennzahl. */
export interface TaxWorksheetForm {
  year: number
  catalogue_year: number
  exact: boolean
  joint: boolean
  values: TaxFormValue[]
  skipped: TaxFormSkipped[]
  documents_read: number
  documents_unread: number
  /** Last year, when it had values: the fields missing this year. */
  previous: { year: number; missing: TaxFormMissing[] } | null
}

export interface TaxWorksheet {
  year: number
  /** Null when the values could not be loaded. */
  form: TaxWorksheetForm | null
  businesses: TaxWorksheetBusiness[]
  sections: TaxWorksheetSection[]
  documentCount: number
  tags: TaxWorksheetTag[]
  bookingCount: number
  bookingTotal: number
  depot: TaxWorksheetDepot | null
  hints: string[]
}

export function getTaxWorksheet(year: number, personId?: number | null): Promise<TaxWorksheet> {
  const query = new URLSearchParams({ year: String(year) })
  if (personId != null) query.set('person_id', String(personId))
  return apiFetch(`/assistant/tax-worksheet?${query}`)
}

export interface TaxWorksheetPdfResult {
  document_id: number
  route: string
  sections: number
  bookings: number
}

export function storeTaxWorksheetPdf(year: number, personId?: number | null): Promise<TaxWorksheetPdfResult> {
  return apiFetch('/assistant/tax-worksheet/pdf', {
    method: 'POST',
    body: JSON.stringify(personId != null ? { year, person_id: personId } : { year }),
  })
}
