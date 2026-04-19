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
 * Groups an array of photos by year and month (or quality tiers).
 * The `index` on each PhotoItem refers to the position in `allPhotos`.
 */
export function usePhotoGrouping(
  photos: Ref<Photo[]>,
  options?: {
    hiddenByStack?: Ref<Set<number>>
    photoToGroup?: Ref<Map<number, PhotoGroup>>
    searchResultIds?: Ref<number[] | null>
    sortBy?: Ref<'date' | 'quality'>
  }
) {
  const groupedPhotos = computed<YearGroup[]>(() => {
    const allPhotos = photos.value
    const ids = options?.searchResultIds?.value ?? null
    const hiddenSet = options?.hiddenByStack?.value ?? new Set<number>()
    const groupMap = options?.photoToGroup?.value ?? new Map<number, PhotoGroup>()
    const sort = options?.sortBy?.value ?? 'date'

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

    if (sort === 'quality') {
      const tiers = [
        { label: 'Gut (≥ 65 %)', test: (s: number) => s >= 0.65 },
        { label: 'Mittel (40–64 %)', test: (s: number) => s >= 0.40 && s < 0.65 },
        { label: 'Schlecht (< 40 %)', test: (s: number) => s < 0.40 },
      ]
      const unscored: Photo[] = []
      const buckets: Photo[][] = [[], [], []]

      basePhotos.forEach(photo => {
        if (ids === null && hiddenSet.has(photo.id)) return
        const s = photo.ai_quality_score
        if (s === undefined || s === null) { unscored.push(photo); return }
        for (let i = 0; i < tiers.length; i++) {
          if (tiers[i]!.test(s)) { buckets[i]!.push(photo); return }
        }
      })

      const groups: YearGroup[] = []
      tiers.forEach((tier, i) => {
        const tierPhotos = (buckets[i] ?? []).sort((a, b) => (b.ai_quality_score ?? 0) - (a.ai_quality_score ?? 0))
        if (tierPhotos.length === 0) return
        const sectionId = `quality-${i}`
        groups.push({
          year: tier.label,
          sectionId,
          months: [{
            month: '',
            sectionId,
            photos: tierPhotos.map(photo => ({ photo, index: idxOf(photo) })),
          }],
        })
      })
      if (unscored.length > 0) {
        groups.push({
          year: 'Nicht bewertet',
          sectionId: 'quality-unscored',
          months: [{
            month: '',
            sectionId: 'quality-unscored',
            photos: unscored.map(photo => ({ photo, index: idxOf(photo) })),
          }],
        })
      }
      return groups
    }

    // ── Date grouping (default) ──
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
