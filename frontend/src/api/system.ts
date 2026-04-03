import { API_BASE_URL } from './client'

export async function getBuildInfo(): Promise<{ build: string }> {
  const res = await fetch(`${API_BASE_URL}/api/build-info`)
  if (!res.ok) return { build: 'unbekannt' }
  return res.json()
}
