import { onMounted, onUnmounted } from 'vue'
import { API_BASE_URL } from '../api/client'

export type RealtimeChannel =
  | 'documents'
  | 'photos'
  | 'albums'
  | 'feed'
  | 'system'

export interface RealtimeEvent {
  id: string
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
function buildWsUrl(channels: RealtimeChannel[], token: string): string {
  const apiBase = API_BASE_URL || ''
  // API_BASE_URL is a path prefix ("/api" in dev, "" in prod). The
  // WebSocket URL must be absolute, so we anchor it to `location`.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${proto}//${location.host}${apiBase}/realtime/subscribe`
  const params = new URLSearchParams()
  params.set('channels', channels.join(','))
  params.set('token', token)
  return `${base}?${params.toString()}`
}

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
class RealtimeBus {
  private ws: WebSocket | null = null
  private opts: ConnectOptions | null = null
  private handlers = new Map<HandlerKey, Set<RealtimeHandler>>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private connecting = false

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
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.opts = null
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

  private open(): void {
    if (this.connecting || !this.opts) return
    const token = this.opts.getToken()
    if (!token) {
      // No token yet — give up; caller must reconnect after login.
      return
    }
    this.connecting = true
    const url = buildWsUrl(this.opts.channels, token)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connecting = false
      this.reconnectAttempt = 0
    })
    ws.addEventListener('message', (ev) => this.handleMessage(ev.data))
    ws.addEventListener('close', () => {
      this.connecting = false
      if (this.ws === ws) this.ws = null
      if (!this.intentionalClose) this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // Let `close` handle retries — errors fire before/alongside it.
    })
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let event: RealtimeEvent
    try {
      event = JSON.parse(raw) as RealtimeEvent
    } catch {
      return
    }
    this.dispatch(event)
  }

  private dispatch(event: RealtimeEvent): void {
    const exact = this.handlers.get(`${event.channel}:${event.type}` as HandlerKey)
    const wildcard = this.handlers.get(`${event.channel}:*` as HandlerKey)
    exact?.forEach((h) => safeCall(h, event))
    wildcard?.forEach((h) => safeCall(h, event))
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
