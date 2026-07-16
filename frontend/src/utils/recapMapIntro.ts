import type { RecapKind } from '../api/recaps'

export interface LatLon {
  lat: number
  lon: number
}

/** Data the player needs to render the animated trip map intro. */
export interface RecapMapIntroData {
  /** Home location; null for older recaps built before home was persisted. */
  from: LatLon | null
  /** Trip destination (cluster centroid). */
  to: LatLon
  /** Destination label shown on the map (usually the city). */
  label?: string
}

/**
 * Derive the map-intro data from a recap's seed. Only trip recaps with a
 * persisted centroid get an intro; everything else returns null and the
 * player starts directly with the photos.
 */
export function tripMapIntroFromSeed(
  kind: RecapKind,
  seed: Record<string, unknown> | null | undefined
): RecapMapIntroData | null {
  if (kind !== 'trip' || !seed) return null
  const toLat = seed.centroid_lat
  const toLon = seed.centroid_lon
  if (typeof toLat !== 'number' || typeof toLon !== 'number') return null

  const from =
    typeof seed.home_lat === 'number' && typeof seed.home_lon === 'number'
      ? { lat: seed.home_lat, lon: seed.home_lon }
      : null

  return {
    from,
    to: { lat: toLat, lon: toLon },
    label: typeof seed.location_city === 'string' ? seed.location_city : undefined,
  }
}
