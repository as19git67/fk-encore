import type { Ref } from 'vue'
import { computed } from 'vue'
import type { Photo, PhotoGroup } from '../api/photos'

// Pre-computed once. Avoids 45k Intl.DateTimeFormat calls on every timeline
// (re)grouping pass — see usePhotoGrouping for the date-grouping hot path.
const MONTH_NAMES_DE: readonly string[] = (() => {
  const fmt = new Intl.DateTimeFormat('de-DE', { month: 'long' })
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2020, i, 1)))
})()

export interface PhotoItem {
  photo: Photo
  index: number
  group?: PhotoGroup
}

export interface MonthGroup {
  month: string
  sectionId: string
  photos: PhotoItem[]
}

export interface YearGroup {
  year: string
  sectionId: string
  months: MonthGroup[]
}

/**
 * Groups an array of photos by year and month.
 * The `index` on each PhotoItem refers to the position in `allPhotos`.
 */
export function usePhotoGrouping(
  photos: Ref<Photo[]>,
  options?: {
    hiddenByStack?: Ref<Set<number>>
    photoToGroup?: Ref<Map<number, PhotoGroup>>
    searchResultIds?: Ref<number[] | null>
  }
) {
  const groupedPhotos = computed<YearGroup[]>(() => {
    const allPhotos = photos.value
    const ids = options?.searchResultIds?.value ?? null
    const hiddenSet = options?.hiddenByStack?.value ?? new Set<number>()
    const groupMap = options?.photoToGroup?.value ?? new Map<number, PhotoGroup>()

    // Pre-build id → index map once. Avoids O(n²) `allPhotos.indexOf(photo)`
    // inside the per-photo loops below.
    const indexById = new Map<number, number>()
    for (let i = 0; i < allPhotos.length; i++) indexById.set(allPhotos[i]!.id, i)
    const idxOf = (p: Photo) => indexById.get(p.id) ?? -1

    let basePhotos: Photo[]
    if (ids !== null) {
      const byId = new Map<number, Photo>()
      for (const p of allPhotos) byId.set(p.id, p)
      basePhotos = ids
        .map(id => byId.get(id))
        .filter((p): p is Photo => p !== undefined)
    } else {
      basePhotos = allPhotos
    }

    // ── Date grouping ──
    // With 45k photos the previous implementation was an O(n × y × m) hot path:
    //   - `date.toLocaleString('de-DE', { month: 'long' })` per photo → ~45k
    //     Intl calls (Intl is expensive, tens of ms cumulative)
    //   - `groups.find(…)` / `yearGroup.months.find(…)` per photo → linear
    //     scans over growing arrays
    // The timeline render blocked the main thread for several seconds.
    //
    // Rewrite: look up year/month groups via Map (O(1)) and resolve the
    // localized month name from a cached 12-entry table (Intl runs 12 times,
    // not 45k).
    const groups: YearGroup[] = []
    const yearIndex = new Map<string, YearGroup>()
    const monthIndex = new Map<string, MonthGroup>()

    basePhotos.forEach(photo => {
      if (ids === null && hiddenSet.has(photo.id)) return

      const date = new Date(photo.taken_at || photo.created_at)
      const year = date.getFullYear().toString()
      const monthNum = date.getMonth()
      const month = MONTH_NAMES_DE[monthNum]!
      const monthKey = `${year}-${monthNum}`

      let yearGroup = yearIndex.get(year)
      if (!yearGroup) {
        yearGroup = { year, sectionId: `year-${year}`, months: [] }
        yearIndex.set(year, yearGroup)
        groups.push(yearGroup)
      }

      let monthGroup = monthIndex.get(monthKey)
      if (!monthGroup) {
        monthGroup = { month, sectionId: `month-${year}-${month}`, photos: [] }
        monthIndex.set(monthKey, monthGroup)
        yearGroup.months.push(monthGroup)
      }

      const stackGroup = ids === null ? groupMap.get(photo.id) : undefined
      const group = stackGroup && !stackGroup.reviewed_at ? stackGroup : undefined
      monthGroup.photos.push({ photo, index: idxOf(photo), group })
    })
    return groups
  })

  return { groupedPhotos }
}
