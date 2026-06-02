import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { usePhotoStops } from './usePhotoStops'
import type { Photo } from '../api/photos'

// Munich-ish reference point; meter→degree conversion for building fixtures.
const BASE_LAT = 48.137
const BASE_LNG = 11.575
const LAT_METERS_PER_DEG = 111_000
const LNG_METERS_PER_DEG = 111_000 * Math.cos((BASE_LAT * Math.PI) / 180)

function photoAt(id: number, eastMeters: number, northMeters: number, hour: number): Photo {
  const hh = String(hour).padStart(2, '0')
  return {
    id,
    filename: `p${id}.jpg`,
    latitude: BASE_LAT + northMeters / LAT_METERS_PER_DEG,
    longitude: BASE_LNG + eastMeters / LNG_METERS_PER_DEG,
    taken_at: `2026-05-20T${hh}:30:00`,
    created_at: `2026-05-20T${hh}:30:00`,
  } as unknown as Photo
}

describe('usePhotoStops — adaptive day clustering (#375)', () => {
  it('splits a single city day into one stop per landmark area', () => {
    // Four landmark spots ~500 m apart, three tightly-grouped photos each —
    // a whole day spent wandering one city. The fixed 400 m radius would
    // collapse these into a single pin; adaptive radii keep them apart.
    const photos: Photo[] = []
    let id = 1
    for (let spot = 0; spot < 4; spot++) {
      for (let k = 0; k < 3; k++) {
        photos.push(photoAt(id, spot * 500 + k * 20, k * 10, 9 + spot))
        id++
      }
    }

    const { stops } = usePhotoStops(ref(photos))
    expect(stops.value.length).toBe(4)
  })

  it('keeps a day spent at a single spot as one stop', () => {
    // Twelve photos all within a ~50 m patch must not shatter into many
    // single-photo stops once the radii scale down.
    const photos: Photo[] = []
    for (let k = 0; k < 12; k++) {
      photos.push(photoAt(k + 1, (k % 4) * 15, Math.floor(k / 4) * 15, 9 + k))
    }

    const { stops } = usePhotoStops(ref(photos))
    expect(stops.value.length).toBe(1)
  })

  it('keeps far-apart photos on a wide-ranging day separate', () => {
    // Two photo groups 8 km apart — a day that covers real distance still
    // yields one stop per visited area.
    const photos: Photo[] = [
      photoAt(1, 0, 0, 9),
      photoAt(2, 30, 20, 10),
      photoAt(3, 8000, 0, 14),
      photoAt(4, 8030, 20, 15),
    ]

    const { stops } = usePhotoStops(ref(photos))
    expect(stops.value.length).toBe(2)
  })
})

describe('usePhotoStops — zoom-driven cluster radius (map ↔ timeline sync)', () => {
  // Three spots 1 km apart, two photos ~10 m apart at each.
  function threeSpots(): Photo[] {
    const photos: Photo[] = []
    let id = 1
    for (let spot = 0; spot < 3; spot++) {
      photos.push(photoAt(id++, spot * 1000, 0, 9 + spot))
      photos.push(photoAt(id++, spot * 1000 + 10, 0, 9 + spot))
    }
    return photos
  }

  it('merges everything into one stop at a large (zoomed-out) radius', () => {
    const { stops } = usePhotoStops(ref(threeSpots()), ref(5000))
    expect(stops.value.length).toBe(1)
  })

  it('splits into one stop per spot at a small (zoomed-in) radius', () => {
    const { stops } = usePhotoStops(ref(threeSpots()), ref(300))
    expect(stops.value.length).toBe(3)
  })

  it('recomputes reactively when the radius changes (single source of truth)', () => {
    const radius = ref<number | null>(5000)
    const { stops } = usePhotoStops(ref(threeSpots()), radius)
    expect(stops.value.length).toBe(1) // zoomed out → merged
    radius.value = 300 // user zooms in
    expect(stops.value.length).toBe(3) // splits — pins & timeline both follow
  })

  it('floors the radius so extreme zoom-in does not shatter a tight burst', () => {
    // One spot, three photos within ~20 m. A near-zero radius would split them
    // into three single-photo stops without the floor.
    const burst = [photoAt(1, 0, 0, 9), photoAt(2, 10, 0, 10), photoAt(3, 20, 0, 11)]
    const { stops } = usePhotoStops(ref(burst), ref(1))
    expect(stops.value.length).toBe(1)
  })

  it('falls back to the day-span heuristic when no radius is supplied (null)', () => {
    const photos = threeSpots()
    const withNull = usePhotoStops(ref(photos), ref(null))
    const without = usePhotoStops(ref(photos))
    expect(withNull.stops.value.length).toBe(without.stops.value.length)
  })
})
