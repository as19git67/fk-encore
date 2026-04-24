/**
 * Web Push opt-in helper.
 *
 * Wraps the browser Push API + `notification` permission flow and the
 * backend subscribe/unsubscribe endpoints. Call `refreshState` on
 * mount to discover the current status; `subscribe`/`unsubscribe`
 * drive the flow from a user gesture (required for the permission
 * prompt).
 *
 * Both the user-app and the public share-page reuse the same browser
 * primitives but talk to different backend endpoints. The factory
 * `createPushNotifications` takes the API surface as config; the
 * default `usePushNotifications` binds to the user-app endpoints,
 * `useGuestPushNotifications` (separate file) binds to the guest
 * endpoints.
 */

import { ref, computed } from 'vue'
import { getVapidPublicKey, subscribePush, unsubscribePush } from '../api/push'

export type PushStatus =
  | 'unsupported'
  | 'disabled-server' // backend has no VAPID keys configured
  | 'denied'          // user denied the notification permission
  | 'unsubscribed'    // supported + allowed, not yet subscribed
  | 'subscribed'      // fully active

export interface PushApi {
  fetchVapidKey(): Promise<{ publicKey: string | null; enabled: boolean }>
  subscribe(req: {
    endpoint: string
    keys: { p256dh: string; auth: string }
    userAgent?: string
  }): Promise<unknown>
  unsubscribe(endpoint: string): Promise<unknown>
}

// The SPA is mounted under `/app/` by the Encore static handler
// (web/static.ts), so the service-worker file is only reachable
// there. A bare `/push-sw.js` falls through to Encore's API router
// and returns "endpoint not found".
const SW_URL = '/app/push-sw.js'

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const buffer = new ArrayBuffer(rawData.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < rawData.length; i++) {
    view[i] = rawData.charCodeAt(i)
  }
  return buffer
}

function browserSupports(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

async function extractKey(
  sub: PushSubscription,
  name: 'p256dh' | 'auth',
): Promise<string> {
  const raw = sub.getKey(name)
  if (!raw) throw new Error(`missing push key: ${name}`)
  const bytes = new Uint8Array(raw)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPushNotifications(api: PushApi) {
  const status = ref<PushStatus>('unsubscribed')
  const busy = ref(false)
  const error = ref<string | null>(null)

  const canToggle = computed(
    () =>
      status.value !== 'unsupported' &&
      status.value !== 'disabled-server' &&
      status.value !== 'denied',
  )

  async function registerSw(): Promise<ServiceWorkerRegistration> {
    return await navigator.serviceWorker.register(SW_URL)
  }

  async function refreshState(): Promise<void> {
    error.value = null
    if (!browserSupports()) {
      status.value = 'unsupported'
      return
    }
    try {
      const info = await api.fetchVapidKey()
      if (!info.enabled || !info.publicKey) {
        status.value = 'disabled-server'
        return
      }
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Status unbekannt'
      status.value = 'disabled-server'
      return
    }
    if (Notification.permission === 'denied') {
      status.value = 'denied'
      return
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL)
      const sub = (await reg?.pushManager.getSubscription()) ?? null
      status.value = sub ? 'subscribed' : 'unsubscribed'
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Status unbekannt'
      status.value = 'unsubscribed'
    }
  }

  async function subscribe(): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      if (!browserSupports()) {
        throw new Error('Push wird von diesem Browser nicht unterstützt.')
      }
      const info = await api.fetchVapidKey()
      if (!info.enabled || !info.publicKey) {
        status.value = 'disabled-server'
        throw new Error('Push ist auf dem Server nicht konfiguriert.')
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        status.value = permission === 'denied' ? 'denied' : 'unsubscribed'
        if (permission === 'denied') {
          throw new Error('Benachrichtigungen wurden vom Browser abgelehnt.')
        }
        return
      }
      const reg = await registerSw()
      const existing = await reg.pushManager.getSubscription()
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(info.publicKey),
        }))

      const [p256dh, authKey] = await Promise.all([
        extractKey(sub, 'p256dh'),
        extractKey(sub, 'auth'),
      ])
      await api.subscribe({
        endpoint: sub.endpoint,
        keys: { p256dh, auth: authKey },
        userAgent: navigator.userAgent,
      })
      status.value = 'subscribed'
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Aktivierung fehlgeschlagen'
    } finally {
      busy.value = false
    }
  }

  async function unsubscribe(): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL)
      const sub = (await reg?.pushManager.getSubscription()) ?? null
      if (sub) {
        await api.unsubscribe(sub.endpoint).catch(() => undefined)
        await sub.unsubscribe()
      }
      status.value = 'unsubscribed'
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Deaktivierung fehlgeschlagen'
    } finally {
      busy.value = false
    }
  }

  return {
    status,
    busy,
    error,
    canToggle,
    refreshState,
    subscribe,
    unsubscribe,
  }
}

export function usePushNotifications() {
  return createPushNotifications({
    fetchVapidKey: () => getVapidPublicKey(),
    subscribe: (req) => subscribePush(req),
    unsubscribe: (endpoint) => unsubscribePush(endpoint),
  })
}
