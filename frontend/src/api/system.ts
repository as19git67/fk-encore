import { API_BASE_URL } from './client'

export async function getBuildInfo(): Promise<{ build: string }> {
  const separator = API_BASE_URL.includes('?') ? '&' : '?'
  // `API_BASE_URL` already carries the `/api` prefix in development (it is
  // empty in production, where the app is served from the same origin as the
  // API). Spelling `/api` again here asked for `/api/api/build-info`, which
  // nothing answers — in dev the version check quietly never resolved.
  const res = await fetch(
    `${API_BASE_URL}/build-info${separator}_=${Date.now()}`,
    { cache: 'no-store' },
  )
  if (!res.ok) return { build: 'unbekannt' }
  return res.json()
}
