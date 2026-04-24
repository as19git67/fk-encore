import { apiFetch } from './client'

export interface GuestSelf {
  id: number
  email: string
  display_name: string
  verified: boolean
  notify_opt_in: boolean
}

interface RegisterResponse {
  verify_required: boolean
  guest_id: number
}

/**
 * Cookie-backed guest endpoints. Always send credentials so the
 * fk_guest_session cookie travels with the request — apiFetch
 * doesn't enable credentials by default (the user app uses bearer
 * tokens), but the guest session is HttpOnly and cookie-only.
 */
const COOKIE: RequestInit = { credentials: 'include' }

export function getGuestSelf(token: string) {
  return apiFetch<{ guest: GuestSelf | null }>(
    `/share/${encodeURIComponent(token)}/guests/me`,
    COOKIE,
  )
}

export function registerGuest(token: string, email: string, displayName: string) {
  return apiFetch<RegisterResponse>(
    `/share/${encodeURIComponent(token)}/guests/register`,
    {
      ...COOKIE,
      method: 'POST',
      body: JSON.stringify({ email, display_name: displayName }),
    },
  )
}

export function logoutGuest(token: string) {
  return apiFetch<{ ok: true }>(
    `/share/${encodeURIComponent(token)}/guests/logout`,
    { ...COOKIE, method: 'POST' },
  )
}

export function setGuestNotifyOptIn(token: string, optIn: boolean) {
  return apiFetch<{ opt_in: boolean }>(
    `/share/${encodeURIComponent(token)}/guests/notify-opt-in`,
    {
      ...COOKIE,
      method: 'POST',
      body: JSON.stringify({ opt_in: optIn }),
    },
  )
}
