import { API_BASE_URL } from './client'

export async function getBuildInfo(): Promise<{ build: string }> {
  const separator = API_BASE_URL.includes('?') ? '&' : '?'
  const res = await fetch(
    `${API_BASE_URL}/api/build-info${separator}_=${Date.now()}`,
    { cache: 'no-store' },
  )
  if (!res.ok) return { build: 'unbekannt' }
  return res.json()
}
