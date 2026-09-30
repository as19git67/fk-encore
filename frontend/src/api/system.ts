import { API_BASE_URL, apiFetch } from './client'

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

/** The router (Valhalla) as the trip planner sees it (§24). */
export interface RoutingStatus {
  reachable: boolean
  /** Why not, when not reachable: the error as the app saw it. */
  reason: string | null
  version: string | null
  hasTiles: boolean
  /** ISO, when Valhalla says when its tiles were built. */
  tilesBuiltAt: string | null
  /** ISO, the newest ready region's import time. */
  newestRegionAt: string | null
  /** A region came after the tiles: routable only after a restart of the routing container. */
  tilesBehindRegion: boolean
}

export function getRoutingStatus() {
  return apiFetch<RoutingStatus>('/trip-planner/routing/status')
}
