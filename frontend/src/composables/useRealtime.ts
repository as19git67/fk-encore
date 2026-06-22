import { onMounted, onUnmounted } from 'vue'
import { API_BASE_URL, ensureFreshToken } from '../api/client'

export type RealtimeChannel =
  | 'documents'
  | 'photos'
  | 'albums'
  | 'feed'
  | 'scan-queue'
  | 'system'

export interface RealtimeEvent {
  id: string
  /**
   * Monotonically increasing cursor from the server's outbox. `0` on
   * transport-level events (heartbeat, session.ready, …) that are
   * never persisted. Clients advance `lastSeq` on every non-zero
   * seq and pass it back on reconnect to resume missed events.
   */
  seq: number
  userId: string
  channel: RealtimeChannel
  type: string
  resourceId: string
  timestamp: string
  payload: Record<string, unknown>
  version: number
}

export type RealtimeHandler = (event: RealtimeEvent) => void

type HandlerKey = `${RealtimeChannel}:${string}`

interface ConnectOptions {
  channels: RealtimeChannel[]
  /**
   * Token provider. Called on every (re)connect so a refreshed token
   * is picked up automatically.
   */
  getToken: () => string | null
}

/**
 * Build the WebSocket URL from `API_BASE_URL`. Works for both the
 * Vite proxy (dev) and the production deployment where the frontend
 * is served by the same origin as the API.
 */
function buildWsUrl(
  channels: RealtimeChannel[],
  token: string,
  lastSeq: number | null,
): string {
  const apiBase = API_BASE_URL || ''
  // API_BASE_URL is a path prefix ("/api" in dev, "" in prod). The
  // WebSocket URL must be absolute, so we anchor it to `location`.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${proto}//${location.host}${apiBase}/realtime/subscribe`
  const params = new URLSearchParams()
  params.set('channels', channels.join(','))
  params.set('token', token)
  if (lastSeq !== null && lastSeq > 0) {
    params.set('lastEventId', String(lastSeq))
  }
  return `${base}?${params.toString()}`
}

const LAST_SEQ_STORAGE_KEY = 'realtime.lastSeq'

function loadStoredSeq(): number {
  try {
    const raw = localStorage.getItem(LAST_SEQ_STORAGE_KEY)
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function persistSeq(seq: number): void {
  try {
    if (seq > 0) localStorage.setItem(LAST_SEQ_STORAGE_KEY, String(seq))
    else localStorage.removeItem(LAST_SEQ_STORAGE_KEY)
  } catch {
    // localStorage may be unavailable (private mode, storage quota) —
    // resume simply won't work until the user returns.
  }
}

/**
 * Size of the deduplication set. Must be larger than the server's
 * REPLAY_LIMIT (500) so we can always tell replayed events apart from
 * live ones during the overlap window of a reconnect.
 */
const DEDUP_CAPACITY = 1_000

/**
 * Singleton WebSocket-backed event bus. One connection serves every
 * feature — components register handlers by (channel, type) and the
 * bus dispatches incoming events to them.
 *
 * Reconnection strategy:
 *   - Exponential backoff capped at 30 s
 *   - `connect()` is idempotent: calling it again while connected is
 *     a no-op; passing new channels closes and reconnects.
 *   - `disconnect()` stops the reconnect loop.
 */
/**
 * If no message (including the server's `system/heartbeat`) arrives
 * within this window, the socket is considered dead and we force a
 * reconnect. The server ticks every 25 s, so 60 s leaves headroom for
 * one skipped heartbeat plus network jitter.
 */
const HEARTBEAT_TIMEOUT_MS = 60_000

class RealtimeBus {
  private ws: WebSocket | null = null
  private opts: ConnectOptions | null = null
  private handlers = new Map<HandlerKey, Set<RealtimeHandler>>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private connecting = false
  private lastSeq: number = loadStoredSeq()
  /**
   * Insertion-ordered set of recent event IDs. After DEDUP_CAPACITY
   * entries the oldest is evicted — a replay that overlaps with live
   * events stays filtered as long as the overlap fits inside this
   * window (REPLAY_LIMIT = 500, so 1000 is 2× safety).
   */
  private seenIds = new Set<string>()

  connect(options: ConnectOptions): void {
    const sameChannels =
      this.opts &&
      this.opts.channels.length === options.channels.length &&
      this.opts.channels.every((c, i) => c === options.channels[i])
    this.opts = options
    if (this.ws && this.ws.readyState === WebSocket.OPEN && sameChannels) {
      return
    }
    if (this.ws) {
      this.intentionalClose = true
      this.ws.close()
      this.ws = null
    }
    this.intentionalClose = false
    this.open()
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.opts = null
    // Reset the resume cursor so a different user logging in on the
    // same browser doesn't try to replay events that were emitted for
    // someone else's user_id (the server filters by user_id so it's
    // only wasted handshake work, but resetting keeps the model
    // clean).
    this.resetCursor()
  }

  /** Register a handler. Use `type = "*"` to receive every event of a channel. */
  on(channel: RealtimeChannel, type: string, handler: RealtimeHandler): void {
    const key = `${channel}:${type}` as HandlerKey
    let set = this.handlers.get(key)
    if (!set) {
      set = new Set()
      this.handlers.set(key, set)
    }
    set.add(handler)
  }

  off(channel: RealtimeChannel, type: string, handler: RealtimeHandler): void {
    const key = `${channel}:${type}` as HandlerKey
    const set = this.handlers.get(key)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) this.handlers.delete(key)
  }

  /** Current connection state, for UI indicators. */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private async open(): Promise<void> {
    if (this.connecting || !this.opts) return
    // Set connecting=true before the await so concurrent calls from
    // scheduleReconnect and connect() don't both open a socket.
    this.connecting = true

    // Proactively refresh the access token before each (re)connect.
    // Without this, a reconnect after token expiry reuses the stale
    // token from localStorage and gets an immediate 401, causing the
    // exponential-backoff loop to run with the wrong token until the
    // user navigates (which triggers the HTTP 401 → login redirect).
    try {
      await ensureFreshToken()
    } catch {
      // If the refresh itself fails unexpectedly, proceed — the WS
      // will close with 401 and we'll retry via scheduleReconnect.
    }

    // Re-check intentional-close and opts after the await in case
    // disconnect() was called while the refresh was in flight.
    if (!this.opts || this.intentionalClose) {
      this.connecting = false
      return
    }

    const token = this.opts.getToken()
    if (!token) {
      // No token yet — give up; caller must reconnect after login.
      this.connecting = false
      return
    }

    const url = buildWsUrl(this.opts.channels, token, this.lastSeq)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connecting = false
      this.reconnectAttempt = 0
      this.resetHeartbeat()
    })
    ws.addEventListener('message', (ev) => {
      this.resetHeartbeat()
      this.handleMessage(ev.data)
    })
    ws.addEventListener('close', () => {
      this.connecting = false
      this.clearHeartbeat()
      if (this.ws === ws) this.ws = null
      if (!this.intentionalClose) this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // Let `close` handle retries — errors fire before/alongside it.
    })
  }

  /**
   * Arm the watchdog. If no message arrives before the timeout the
   * socket is torn down; `close` fires and `scheduleReconnect` takes
   * over. Any incoming traffic (live event or heartbeat) re-arms it.
   */
  private resetHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.warn('[realtime] heartbeat timeout, forcing reconnect')
        this.ws.close()
      }
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let event: RealtimeEvent
    try {
      event = JSON.parse(raw) as RealtimeEvent
    } catch {
      return
    }
    // Drop duplicates that arrive via both replay and live delivery
    // during the overlap window of a reconnect.
    if (event.id && this.seenIds.has(event.id)) return
    if (event.id) this.rememberId(event.id)

    // A truncated replay means we missed more than REPLAY_LIMIT
    // events — the resume cursor is stale. Reset local state so the
    // next reconnect starts fresh and the UI can reload.
    if (event.channel === 'system' && event.type === 'resume.truncated') {
      this.resetCursor()
    }

    if (event.seq > this.lastSeq) {
      this.lastSeq = event.seq
      persistSeq(this.lastSeq)
    }
    this.dispatch(event)
  }

  private dispatch(event: RealtimeEvent): void {
    const exact = this.handlers.get(`${event.channel}:${event.type}` as HandlerKey)
    const wildcard = this.handlers.get(`${event.channel}:*` as HandlerKey)
    exact?.forEach((h) => safeCall(h, event))
    wildcard?.forEach((h) => safeCall(h, event))
  }

  private rememberId(id: string): void {
    this.seenIds.add(id)
    if (this.seenIds.size > DEDUP_CAPACITY) {
      const oldest = this.seenIds.values().next().value
      if (oldest !== undefined) this.seenIds.delete(oldest)
    }
  }

  private resetCursor(): void {
    this.lastSeq = 0
    this.seenIds.clear()
    persistSeq(0)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }
}

function safeCall(h: RealtimeHandler, ev: RealtimeEvent): void {
  try {
    h(ev)
  } catch (err) {
    console.error('[realtime] handler threw:', err)
  }
}

export const realtimeBus = new RealtimeBus()

/**
 * Register a handler for the lifetime of a component. Cleans itself
 * up automatically — consumers never have to call `off()`.
 *
 * Example:
 *   useRealtimeEvent('documents', 'status.changed', (ev) => { … })
 */
export function useRealtimeEvent(
  channel: RealtimeChannel,
  type: string,
  handler: RealtimeHandler,
): void {
  onMounted(() => realtimeBus.on(channel, type, handler))
  onUnmounted(() => realtimeBus.off(channel, type, handler))
}
