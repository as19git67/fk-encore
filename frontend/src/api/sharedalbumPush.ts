import { apiFetch } from './client'

const COOKIE: RequestInit = { credentials: 'include' }

export interface VapidKeyResponse {
  publicKey: string | null
  enabled: boolean
}

export function getGuestVapidKey(token: string) {
  return apiFetch<VapidKeyResponse>(
    `/share/${encodeURIComponent(token)}/guests/push/vapid-key`,
    COOKIE,
  )
}

export interface PushSubscribeRequest {
  endpoint: string
  keys: { p256dh: string; auth: string }
  userAgent?: string
}

export function subscribeGuestPush(token: string, req: PushSubscribeRequest) {
  return apiFetch<{ id: number }>(
    `/share/${encodeURIComponent(token)}/guests/push/subscribe`,
    {
      ...COOKIE,
      method: 'POST',
      body: JSON.stringify(req),
    },
  )
}

export function unsubscribeGuestPush(token: string, endpoint: string) {
  return apiFetch<{ removed: number }>(
    `/share/${encodeURIComponent(token)}/guests/push/unsubscribe`,
    {
      ...COOKIE,
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    },
  )
}
