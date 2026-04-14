import { computed, ref } from 'vue'
import { searchPhotosNatural, type ParsedQuery } from '../api/photos'

/**
 * Shared search state & logic for natural-language photo search.
 *
 * The backend parses a free-form German query ("Kirchen in München
 * von 2004 bis 2017") into structured filters (location, date range) plus
 * a semantic CLIP search. Components that consume this composable:
 *   - bind `searchQuery` to an <input>
 *   - call `executeSearch()` on submit
 *   - feed `searchResultIds` into usePhotoGrouping's searchResultIds option
 *   - render `parsed` as chips for transparency
 */
export function useNaturalSearch() {
  const searchQuery = ref('')
  const searchResultIds = ref<number[] | null>(null)
  const parsed = ref<ParsedQuery | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function executeSearch() {
    const q = searchQuery.value.trim()
    if (!q) { clearSearch(); return }
    loading.value = true
    error.value = ''
    try {
      const resp = await searchPhotosNatural(q)
      searchResultIds.value = resp.results.map(r => r.photoId)
      parsed.value = resp.parsed
    } catch {
      error.value = 'Suche fehlgeschlagen. Ist der Embedding-Service erreichbar?'
      searchResultIds.value = null
      parsed.value = null
    } finally {
      loading.value = false
    }
  }

  function clearSearch() {
    searchQuery.value = ''
    searchResultIds.value = null
    parsed.value = null
    error.value = ''
  }

  // Helpers for rendering parsed chips in a readable German format.
  const locationChip = computed(() => parsed.value?.location || null)

  const dateChip = computed<string | null>(() => {
    const p = parsed.value
    if (!p?.fromDate) return null
    const from = new Date(p.fromDate)
    const to = p.toDate ? new Date(p.toDate) : null
    const fy = from.getFullYear()
    const ty = to?.getFullYear()
    // Full-year range (Jan 1 → Dec 31) => render as "2004" or "2004–2017"
    const fromIsYearStart = from.getMonth() === 0 && from.getDate() === 1
    const toIsYearEnd = to && to.getMonth() === 11 && to.getDate() === 31
    if (fromIsYearStart && toIsYearEnd) {
      return fy === ty ? String(fy) : `${fy}–${ty}`
    }
    const fmt = (d: Date) =>
      d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
    if (!to) return fmt(from)
    const sameDay = from.toDateString() === to.toDateString()
    return sameDay ? fmt(from) : `${fmt(from)} – ${fmt(to)}`
  })

  const semanticChip = computed<string | null>(() => {
    const s = parsed.value?.semanticQuery?.trim()
    if (!s) return null
    // Only show if it actually differs from the raw query, otherwise the
    // chip is noise.
    return s.toLowerCase() === searchQuery.value.trim().toLowerCase() ? null : s
  })

  const hasParsedChips = computed(
    () => !!(locationChip.value || dateChip.value || semanticChip.value)
  )

  return {
    searchQuery,
    searchResultIds,
    parsed,
    loading,
    error,
    executeSearch,
    clearSearch,
    locationChip,
    dateChip,
    semanticChip,
    hasParsedChips,
  }
}
