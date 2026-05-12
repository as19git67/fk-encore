import { computed, type Ref } from 'vue'
import type { Photo } from '../api/photos'
import { formatLocationLabel } from '../utils/dateFormat'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Stop {
  id: number
  lat: number
  lng: number
  photos: Photo[]
  coverPhoto: Photo
  day: string // YYYY-MM-DD
  locationLabel: string
}

export interface OverviewCluster {
  id: number
  lat: number
  lng: number
  stopIds: number[]
  photos: Photo[]
  coverPhoto: Photo
}

export interface DayPath {
  day: string
  color: string
  coordinates: [number, number][]
}

export interface DayTransition {
  fromDay: string
  toDay: string
  color: string
  coordinates: [number, number][]
}

export type LatLngBounds = [[number, number], [number, number]]

/** Photo with guaranteed GPS coordinates */
interface GeoPhoto extends Photo {
  latitude: number
  longitude: number
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Photos within this distance of a cluster centroid join that cluster. */
const CLUSTER_INCLUDE_METERS = 400
/** Two finished day-clusters whose centroids are closer than this get merged. */
const MIN_CLUSTER_SEPARATION_METERS = 600
/** In overview mode, stops whose centroids are closer than this get merged. */
const OVERVIEW_MERGE_METERS = 8000
/** Only draw a connecting line between days when their nearest stops are at
 *  least this far apart. */
const DAY_TRANSITION_MIN_METERS = 25000

const DAY_COLORS = [
  '#4285F4', '#EA4335', '#34A853', '#FBBC05', '#9C27B0',
  '#FF6D00', '#00ACC1', '#C62828', '#2E7D32', '#F06292',
]

// ── Haversine ────────────────────────────────────────────────────────────────

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPhotoDate(photo: Photo): Date {
  return new Date(photo.taken_at || photo.created_at)
}

function getDayKey(photo: Photo): string {
  // Local-date key — using toISOString here would shift the day by one for
  // photos taken in the evening east of UTC.
  const d = getPhotoDate(photo)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function pickCover(photos: Photo[]): Photo {
  let best = photos[0]!
  for (let i = 1; i < photos.length; i++) {
    const p = photos[i]!
    if ((p.ai_quality_score ?? 0) > (best.ai_quality_score ?? 0)) best = p
  }
  return best
}

function buildLocationLabel(photo: Photo): string {
  return formatLocationLabel(photo)
}

function isGeoPhoto(p: Photo): p is GeoPhoto {
  return p.latitude != null && p.longitude != null
}

interface Centroid {
  lat: number
  lng: number
  photos: GeoPhoto[]
}

function mergeCentroidsInPlace(a: Centroid, b: Centroid) {
  const na = a.photos.length
  const nb = b.photos.length
  a.lat = (a.lat * na + b.lat * nb) / (na + nb)
  a.lng = (a.lng * na + b.lng * nb) / (na + nb)
  for (const p of b.photos) a.photos.push(p)
}

/**
 * Greedy single-day clustering: every photo joins its nearest existing
 * cluster if within `CLUSTER_INCLUDE_METERS`, otherwise it seeds a new
 * cluster. A finalisation pass then merges any two clusters whose
 * centroids ended up closer than `MIN_CLUSTER_SEPARATION_METERS`, so the
 * result satisfies the "minimum cluster distance" requirement. Every
 * photo always ends up in exactly one cluster — none is left over.
 */
function clusterDayPhotos(photos: GeoPhoto[]): Centroid[] {
  if (photos.length === 0) return []
  const sorted = [...photos].sort(
    (a, b) => getPhotoDate(a).getTime() - getPhotoDate(b).getTime(),
  )
  const clusters: Centroid[] = []
  for (const p of sorted) {
    let bestIdx = -1
    let bestDist = Infinity
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]!
      const d = haversineDistance(c.lat, c.lng, p.latitude, p.longitude)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestDist <= CLUSTER_INCLUDE_METERS) {
      const c = clusters[bestIdx]!
      const n = c.photos.length + 1
      c.lat = c.lat + (p.latitude - c.lat) / n
      c.lng = c.lng + (p.longitude - c.lng) / n
      c.photos.push(p)
    } else {
      clusters.push({ lat: p.latitude, lng: p.longitude, photos: [p] })
    }
  }

  let changed = true
  while (changed && clusters.length > 1) {
    changed = false
    let bestI = -1
    let bestJ = -1
    let bestDist = Infinity
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!
        const b = clusters[j]!
        const d = haversineDistance(a.lat, a.lng, b.lat, b.lng)
        if (d < bestDist) {
          bestDist = d
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestDist < MIN_CLUSTER_SEPARATION_METERS && bestI >= 0) {
      mergeCentroidsInPlace(clusters[bestI]!, clusters[bestJ]!)
      clusters.splice(bestJ, 1)
      changed = true
    }
  }
  return clusters
}

function computeBounds(points: Array<{ lat: number; lng: number }>): LatLngBounds | null {
  if (points.length === 0) return null
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  const latPad = Math.max((maxLat - minLat) * 0.1, 0.005)
  const lngPad = Math.max((maxLng - minLng) * 0.1, 0.005)
  return [
    [minLat - latPad, minLng - lngPad],
    [maxLat + latPad, maxLng + lngPad],
  ]
}

// ── Composable ───────────────────────────────────────────────────────────────

export function usePhotoStops(photos: Ref<Photo[]>) {
  const geoPhotos = computed<GeoPhoto[]>(() => photos.value.filter(isGeoPhoto))

  const stops = computed<Stop[]>(() => {
    if (geoPhotos.value.length === 0) return []

    const byDay = new Map<string, GeoPhoto[]>()
    for (const p of geoPhotos.value) {
      const k = getDayKey(p)
      let arr = byDay.get(k)
      if (!arr) {
        arr = []
        byDay.set(k, arr)
      }
      arr.push(p)
    }

    const days = [...byDay.keys()].sort()
    const result: Stop[] = []
    let nextId = 0

    for (const day of days) {
      const dayPhotos = byDay.get(day)!
      const dayClusters = clusterDayPhotos(dayPhotos)
      // Order clusters within the day by their earliest photo time so that
      // the day-path polyline traces the chronological movement.
      dayClusters.sort((a, b) => {
        const ta = Math.min(...a.photos.map(p => getPhotoDate(p).getTime()))
        const tb = Math.min(...b.photos.map(p => getPhotoDate(p).getTime()))
        return ta - tb
      })
      for (const c of dayClusters) {
        const cover = pickCover(c.photos)
        const photosByTime = c.photos
          .slice()
          .sort((a, b) => getPhotoDate(a).getTime() - getPhotoDate(b).getTime())
        result.push({
          id: nextId++,
          lat: c.lat,
          lng: c.lng,
          photos: photosByTime,
          coverPhoto: cover,
          day,
          locationLabel: buildLocationLabel(cover),
        })
      }
    }

    return result
  })

  const uniqueDays = computed(() => {
    const days = new Set(stops.value.map((s) => s.day))
    return [...days].sort()
  })

  const dayColorMap = computed(() => {
    const map = new Map<string, string>()
    uniqueDays.value.forEach((day, i) => {
      map.set(day, DAY_COLORS[i % DAY_COLORS.length]!)
    })
    return map
  })

  const stopsByDay = computed<Map<string, Stop[]>>(() => {
    const m = new Map<string, Stop[]>()
    for (const s of stops.value) {
      let arr = m.get(s.day)
      if (!arr) {
        arr = []
        m.set(s.day, arr)
      }
      arr.push(s)
    }
    return m
  })

  const dayPaths = computed<DayPath[]>(() => {
    return uniqueDays.value
      .map(day => ({
        day,
        color: dayColorMap.value.get(day) ?? DAY_COLORS[0]!,
        coordinates: (stopsByDay.value.get(day) ?? []).map<[number, number]>(s => [s.lat, s.lng]),
      }))
      .filter(p => p.coordinates.length >= 2)
  })

  /**
   * Inter-day transitions are drawn only when the closest stops between
   * the two days are at least DAY_TRANSITION_MIN_METERS apart — for short
   * everyday hops within the same town we don't clutter the map with a
   * dashed line.
   */
  const dayTransitions = computed<DayTransition[]>(() => {
    const days = uniqueDays.value
    const transitions: DayTransition[] = []
    for (let i = 1; i < days.length; i++) {
      const prev = days[i - 1]!
      const curr = days[i]!
      const prevStops = stopsByDay.value.get(prev) ?? []
      const currStops = stopsByDay.value.get(curr) ?? []
      if (prevStops.length === 0 || currStops.length === 0) continue
      // Use the last stop of the previous day (latest time) and the first
      // stop of the current day to indicate the actual transition.
      const from = prevStops[prevStops.length - 1]!
      const to = currStops[0]!
      const d = haversineDistance(from.lat, from.lng, to.lat, to.lng)
      if (d < DAY_TRANSITION_MIN_METERS) continue
      transitions.push({
        fromDay: prev,
        toDay: curr,
        color: dayColorMap.value.get(curr) ?? DAY_COLORS[0]!,
        coordinates: [[from.lat, from.lng], [to.lat, to.lng]],
      })
    }
    return transitions
  })

  /**
   * Overview clusters: merge stops (across all days) whose centroids are
   * within OVERVIEW_MERGE_METERS so that the "Ganze Reise" pin map shows
   * one marker per visited region instead of every individual stop. Every
   * stop ends up in exactly one overview cluster.
   */
  const overviewClusters = computed<OverviewCluster[]>(() => {
    if (stops.value.length === 0) return []
    interface WorkingCluster {
      lat: number
      lng: number
      stopIds: number[]
      photos: Photo[]
    }
    const clusters: WorkingCluster[] = stops.value.map(s => ({
      lat: s.lat,
      lng: s.lng,
      stopIds: [s.id],
      photos: [...s.photos],
    }))

    let changed = true
    while (changed && clusters.length > 1) {
      changed = false
      let bestI = -1
      let bestJ = -1
      let bestDist = Infinity
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i]!
          const b = clusters[j]!
          const d = haversineDistance(a.lat, a.lng, b.lat, b.lng)
          if (d < bestDist) {
            bestDist = d
            bestI = i
            bestJ = j
          }
        }
      }
      if (bestDist < OVERVIEW_MERGE_METERS && bestI >= 0) {
        const a = clusters[bestI]!
        const b = clusters[bestJ]!
        const na = a.photos.length
        const nb = b.photos.length
        a.lat = (a.lat * na + b.lat * nb) / (na + nb)
        a.lng = (a.lng * na + b.lng * nb) / (na + nb)
        for (const id of b.stopIds) a.stopIds.push(id)
        for (const p of b.photos) a.photos.push(p)
        clusters.splice(bestJ, 1)
        changed = true
      }
    }

    return clusters.map((c, i) => ({
      id: i,
      lat: c.lat,
      lng: c.lng,
      stopIds: c.stopIds,
      photos: c.photos,
      coverPhoto: pickCover(c.photos),
    }))
  })

  const bounds = computed<LatLngBounds | null>(() => computeBounds(stops.value))

  function boundsForDay(day: string): LatLngBounds | null {
    return computeBounds(stopsByDay.value.get(day) ?? [])
  }

  function boundsForStops(stopIds: number[]): LatLngBounds | null {
    const idSet = new Set(stopIds)
    return computeBounds(stops.value.filter(s => idSet.has(s.id)))
  }

  return {
    stops,
    stopsByDay,
    dayPaths,
    dayTransitions,
    dayColorMap,
    uniqueDays,
    bounds,
    overviewClusters,
    boundsForDay,
    boundsForStops,
  }
}
