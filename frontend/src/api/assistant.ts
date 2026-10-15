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
  | 'meters' | 'readings' | 'consumption' | 'trip_plans' | 'table'

/** Rows a tool returned, for display beside the answer. */
export interface ResultBlock {
  kind: BlockKind
  tool: string
  rows: Record<string, unknown>[]
  total?: number
  /** A list page showing the same set, e.g. `/dokumente?q=…`. */
  route?: string
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

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[]
}

export interface AskResponse {
  answer: string
  blocks: ResultBlock[]
  message_id: number
  rounds: number
}

/** One event of a running turn, as the stream sends it. */
export interface StreamEvent {
  type: 'token' | 'tool_start' | 'tool_result' | 'done' | 'error'
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

export function createConversation(title?: string): Promise<ConversationSummary> {
  return apiFetch('/assistant/conversations', { method: 'POST', body: JSON.stringify(title ? { title } : {}) })
}

export function getConversation(id: number): Promise<ConversationDetail> {
  return apiFetch(`/assistant/conversations/${id}`)
}

export function deleteConversation(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/assistant/conversations/${id}`, { method: 'DELETE' })
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
