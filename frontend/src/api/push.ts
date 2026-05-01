import { apiFetch } from './client'

export interface VapidKeyResponse {
  publicKey: string | null
  enabled: boolean
}

export function getVapidPublicKey() {
  return apiFetch<VapidKeyResponse>('/push/vapid-public-key')
}

export interface PushSubscribeRequest {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
  userAgent?: string
}

export function subscribePush(req: PushSubscribeRequest) {
  return apiFetch<{ id: number }>('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function unsubscribePush(endpoint: string) {
  return apiFetch<{ removed: number }>('/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  })
}

export type NotificationKind =
  | 'photo_added'
  | 'album_shared'
  | 'photo_favorited'
  | 'photo_commented'
  | 'album_left'
  | 'document_low_confidence'
  | 'document_failed'

export type NotificationPrefs = Partial<Record<NotificationKind, boolean>>

export function getPushPreferences() {
  return apiFetch<{ preferences: NotificationPrefs }>('/push/preferences')
}

export function updatePushPreferences(preferences: NotificationPrefs) {
  return apiFetch<{ preferences: NotificationPrefs }>('/push/preferences', {
    method: 'PUT',
    body: JSON.stringify({ preferences }),
  })
}
