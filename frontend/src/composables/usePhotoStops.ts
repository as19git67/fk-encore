import { computed, type Ref } from 'vue'
import type { Photo } from '../api/photos'

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

/** Photo with guaranteed GPS coordinates */
interface GeoPhoto extends Photo {
  latitude: number
  longitude: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const CLUSTER_DISTANCE_METERS = 100

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
  return getPhotoDate(photo).toISOString().slice(0, 10)
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
  const parts: string[] = []
  if (photo.location_name) parts.push(photo.location_name)
  if (photo.location_city) parts.push(photo.location_city)
  if (photo.location_country && !parts.length) parts.push(photo.location_country)
  return parts.join(', ') || ''
}

function isGeoPhoto(p: Photo): p is GeoPhoto {
  return p.latitude != null && p.longitude != null
}

// ── Composable ───────────────────────────────────────────────────────────────

export function usePhotoStops(photos: Ref<Photo[]>) {
  const geoPhotos = computed<GeoPhoto[]>(() => photos.value.filter(isGeoPhoto))

  const photosWithoutGps = computed(() =>
    photos.value.filter((p) => !isGeoPhoto(p))
  )

  const stops = computed<Stop[]>(() => {
    const sorted = [...geoPhotos.value].sort(
      (a, b) => getPhotoDate(a).getTime() - getPhotoDate(b).getTime()
    )
    if (sorted.length === 0) return []

    const first = sorted[0]!
    const result: Stop[] = []
    let currentPhotos: GeoPhoto[] = [first]
    let centroidLat = first.latitude
    let centroidLng = first.longitude

    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i]!
      const dist = haversineDistance(centroidLat, centroidLng, p.latitude, p.longitude)

      if (dist <= CLUSTER_DISTANCE_METERS) {
        currentPhotos.push(p)
        // Update centroid as running average
        const n = currentPhotos.length
        centroidLat = centroidLat + (p.latitude - centroidLat) / n
        centroidLng = centroidLng + (p.longitude - centroidLng) / n
      } else {
        // Finalize current stop
        const cover = pickCover(currentPhotos)
        result.push({
          id: result.length,
          lat: centroidLat,
          lng: centroidLng,
          photos: currentPhotos,
          coverPhoto: cover,
          day: getDayKey(currentPhotos[0]!),
          locationLabel: buildLocationLabel(cover),
        })
        // Start new stop
        currentPhotos = [p]
        centroidLat = p.latitude
        centroidLng = p.longitude
      }
    }

    // Finalize last stop
    const cover = pickCover(currentPhotos)
    result.push({
      id: result.length,
      lat: centroidLat,
      lng: centroidLng,
      photos: currentPhotos,
      coverPhoto: cover,
      day: getDayKey(currentPhotos[0]!),
      locationLabel: buildLocationLabel(cover),
    })

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

  const dayPaths = computed<DayPath[]>(() => {
    const pathsByDay = new Map<string, [number, number][]>()

    for (const stop of stops.value) {
      if (!pathsByDay.has(stop.day)) pathsByDay.set(stop.day, [])
      pathsByDay.get(stop.day)!.push([stop.lat, stop.lng])
    }

    return [...pathsByDay.entries()].map(([day, coordinates]) => ({
      day,
      color: dayColorMap.value.get(day) ?? DAY_COLORS[0]!,
      coordinates,
    }))
  })

  const dayTransitions = computed<DayTransition[]>(() => {
    const transitions: DayTransition[] = []
    const stopsArr = stops.value

    for (let i = 1; i < stopsArr.length; i++) {
      const prev = stopsArr[i - 1]!
      const curr = stopsArr[i]!
      if (prev.day !== curr.day) {
        transitions.push({
          fromDay: prev.day,
          toDay: curr.day,
          color: dayColorMap.value.get(curr.day) ?? DAY_COLORS[0]!,
          coordinates: [[prev.lat, prev.lng], [curr.lat, curr.lng]],
        })
      }
    }

    return transitions
  })

  const bounds = computed<[[number, number], [number, number]] | null>(() => {
    if (stops.value.length === 0) return null

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
    for (const stop of stops.value) {
      if (stop.lat < minLat) minLat = stop.lat
      if (stop.lat > maxLat) maxLat = stop.lat
      if (stop.lng < minLng) minLng = stop.lng
      if (stop.lng > maxLng) maxLng = stop.lng
    }

    // Add small padding
    const latPad = Math.max((maxLat - minLat) * 0.1, 0.005)
    const lngPad = Math.max((maxLng - minLng) * 0.1, 0.005)

    return [
      [minLat - latPad, minLng - lngPad],
      [maxLat + latPad, maxLng + lngPad],
    ]
  })

  return {
    stops,
    photosWithoutGps,
    dayPaths,
    dayTransitions,
    dayColorMap,
    uniqueDays,
    bounds,
  }
}
