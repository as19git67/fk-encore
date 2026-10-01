import { API_BASE_URL, apiFetch } from './client'

export async function getBuildInfo(): Promise<{ build: string }> {
  const separator = API_BASE_URL.includes('?') ? '&' : '?'
  // The endpoint's own path is `/api/build-info` — `/api` is part of it
  // (web/static.ts), unlike the service endpoints, which live at the root.
  // So the prefix has to be spelled here on top of `API_BASE_URL`: in
  // production that is empty and the request goes to `/api/build-info`; in
  // development it is `/api`, which the Vite proxy strips, leaving
  // `/api/build-info` again. Without it both asked for `/build-info`, which
  // nothing answers, and the admin page read "Build unbekannt" while the
  // update check never saw a new build.
  const res = await fetch(
    `${API_BASE_URL}/api/build-info${separator}_=${Date.now()}`,
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
