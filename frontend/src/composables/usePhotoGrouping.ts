import type { Ref } from 'vue'
import { computed } from 'vue'
import type { Photo, PhotoGroup } from '../api/photos'

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

    const basePhotos = ids !== null
      ? ids.map(id => allPhotos.find(p => p.id === id)).filter((p): p is Photo => p !== undefined)
      : allPhotos

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
            photos: tierPhotos.map(photo => ({ photo, index: allPhotos.indexOf(photo) })),
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
            photos: unscored.map(photo => ({ photo, index: allPhotos.indexOf(photo) })),
          }],
        })
      }
      return groups
    }

    // ── Date grouping (default) ──
    const groups: YearGroup[] = []
    basePhotos.forEach(photo => {
      if (ids === null && hiddenSet.has(photo.id)) return

      const date = new Date(photo.taken_at || photo.created_at)
      const year = date.getFullYear().toString()
      const month = date.toLocaleString('de-DE', { month: 'long' })
      const yearSectionId = `year-${year}`
      const monthSectionId = `month-${year}-${month}`

      let yearGroup = groups.find(g => g.year === year)
      if (!yearGroup) {
        yearGroup = { year, sectionId: yearSectionId, months: [] }
        groups.push(yearGroup)
      }

      let monthGroup = yearGroup.months.find(m => m.month === month)
      if (!monthGroup) {
        monthGroup = { month, sectionId: monthSectionId, photos: [] }
        yearGroup.months.push(monthGroup)
      }

      const stackGroup = ids === null ? groupMap.get(photo.id) : undefined
      const group = stackGroup && !stackGroup.reviewed_at ? stackGroup : undefined
      monthGroup.photos.push({ photo, index: allPhotos.indexOf(photo), group })
    })
    return groups
  })

  return { groupedPhotos }
}
