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

/** One mode of the measurement: how often the estimate is off by more than a quarter. */
export interface RoutingMeasureMode {
  mode: 'foot' | 'bike' | 'car' | 'transit' | 'ship'
  pairs: number
  answered: number
  offByQuarter: number
  /** Median of |router − estimate| / router, in percent. */
  medianDeviationPct: number | null
  /** Median of router − estimate, in minutes; positive when the estimate is optimistic. */
  medianDifferenceMinutes: number | null
}

export interface RoutingMeasureWorst {
  mode: RoutingMeasureMode['mode']
  from: string
  to: string
  planTitle: string | null
  estimateMinutes: number
  routerMinutes: number
}

/** The estimate next to the router over the caller's planned days (§24). */
export interface RoutingMeasure {
  pairs: number
  modes: RoutingMeasureMode[]
  worst: RoutingMeasureWorst[]
  /** The estimate is off by more than a quarter on at least a quarter of the answered hops. */
  worthwhile: boolean
}

export function measureRouting() {
  return apiFetch<RoutingMeasure>('/trip-planner/routing/measure', { method: 'POST' })
}
