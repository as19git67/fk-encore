import { ref, computed, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw } from 'vue-router'
import type { PhotoFilter, HiddenMode, MembershipMode, MediaType } from '../api/photos'
import type { FilterChip } from '../components/layout/listToolbar'
import { useReferenceData } from './useReferenceData'

/**
 * Filter composable with draft/applied semantics and URL query‑string sync.
 *
 * - `draft` is edited in the FilterMenu; changes do NOT re‑trigger queries.
 * - `applied` is the live filter state the view uses. Only written when the
 *   user presses "Anwenden" (apply), "Zurücksetzen" (reset), or removes a chip.
 * - `applied` is mirrored to the URL query string so deep links and browser
 *   back/forward work naturally.
 */

const HIDDEN_MODES: HiddenMode[] = ['exclude', 'include', 'only']
const MEMBERSHIP_MODES: MembershipMode[] = ['include', 'exclude']
const MEDIA_TYPES: MediaType[] = ['photo', 'video', 'raw']

function parseBool(v: unknown): boolean | undefined {
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return undefined
}

function parseNum(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseIntList(v: unknown): number[] | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const arr = v
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  return arr.length ? arr : undefined
}

function parseMediaTypes(v: unknown): MediaType[] | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const arr = v
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is MediaType => (MEDIA_TYPES as string[]).includes(x))
  return arr.length ? arr : undefined
}

export function parseFilterFromQuery(q: Record<string, unknown>): PhotoFilter {
  const f: PhotoFilter = {}
  const hm = q.hiddenMode
  if (typeof hm === 'string' && (HIDDEN_MODES as string[]).includes(hm)) {
    f.hiddenMode = hm as HiddenMode
  }
  const b = (k: keyof PhotoFilter) => {
    const v = parseBool(q[k as string])
    if (v !== undefined) (f as Record<string, unknown>)[k as string] = v
  }
  b('favorite'); b('albumHighlight'); b('groupHighlight'); b('inGroup')
  b('othersFavorited'); b('othersHidden'); b('notInAnyAlbum')
  b('hasGps'); b('hasFaces'); b('hasAssignedPerson')

  const qMin = parseNum(q.qualityMin); if (qMin !== undefined) f.qualityMin = qMin
  const qMax = parseNum(q.qualityMax); if (qMax !== undefined) f.qualityMax = qMax
  const imp  = parseNum(q.importedDaysAgo); if (imp !== undefined) f.importedDaysAgo = imp
  const nearLat = parseNum(q.nearLat)
  const nearLon = parseNum(q.nearLon)
  if (nearLat !== undefined && nearLon !== undefined
    && nearLat >= -90 && nearLat <= 90 && nearLon >= -180 && nearLon <= 180) {
    f.nearLat = nearLat
    f.nearLon = nearLon
    f.nearRadiusKm = Math.min(20_000, Math.max(0.1, parseNum(q.nearRadiusKm) ?? 10))
  }

  const albumIds = parseIntList(q.albumIds);   if (albumIds)  f.albumIds  = albumIds
  const personIds = parseIntList(q.personIds); if (personIds) f.personIds = personIds
  const ownerIds = parseIntList(q.ownerIds);   if (ownerIds)  f.ownerIds  = ownerIds
  const mts = parseMediaTypes(q.mediaTypes);   if (mts)       f.mediaTypes = mts

  const am = q.albumMode
  if (typeof am === 'string' && (MEMBERSHIP_MODES as string[]).includes(am)) {
    f.albumMode = am as MembershipMode
  }
  const pm = q.personMode
  if (typeof pm === 'string' && (MEMBERSHIP_MODES as string[]).includes(pm)) {
    f.personMode = pm as MembershipMode
  }

  if (typeof q.dateFrom === 'string' && q.dateFrom) f.dateFrom = q.dateFrom
  if (typeof q.dateTo === 'string' && q.dateTo) f.dateTo = q.dateTo
  // Track-I "show AI-hidden" toggle. Without serialising this round-
  // trip the route-query watcher (a few lines below) would parse the
  // URL back into `applied`, find showAiHidden missing, and
  // overwrite the freshly-applied filter — racing two source.init()
  // calls in VirtualGallery and leaving empty skeleton cells.
  const showAiHidden = parseBool(q.showAiHidden)
  if (showAiHidden !== undefined) f.showAiHidden = showAiHidden
  return f
}

export function filterToQuery(f: PhotoFilter): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: string | number | boolean | undefined) => {
    if (v === undefined || v === '' || v === false) return
    out[k] = String(v)
  }
  put('hiddenMode', f.hiddenMode && f.hiddenMode !== 'exclude' ? f.hiddenMode : undefined)
  put('favorite', f.favorite)
  put('albumHighlight', f.albumHighlight)
  put('groupHighlight', f.groupHighlight)
  put('inGroup', f.inGroup)
  put('othersFavorited', f.othersFavorited)
  put('othersHidden', f.othersHidden)
  put('notInAnyAlbum', f.notInAnyAlbum)
  if (f.qualityMin !== undefined) out.qualityMin = String(f.qualityMin)
  if (f.qualityMax !== undefined) out.qualityMax = String(f.qualityMax)
  if (f.albumIds?.length) {
    out.albumIds = f.albumIds.join(',')
    if (f.albumMode && f.albumMode !== 'include') out.albumMode = f.albumMode
  }
  if (f.personIds?.length) {
    out.personIds = f.personIds.join(',')
    if (f.personMode && f.personMode !== 'include') out.personMode = f.personMode
  }
  if (f.ownerIds?.length) out.ownerIds = f.ownerIds.join(',')
  if (f.mediaTypes?.length) out.mediaTypes = f.mediaTypes.join(',')
  if (f.hasGps !== undefined) out.hasGps = String(f.hasGps)
  if (f.hasFaces !== undefined) out.hasFaces = String(f.hasFaces)
  if (f.hasAssignedPerson !== undefined) out.hasAssignedPerson = String(f.hasAssignedPerson)
  if (f.dateFrom) out.dateFrom = f.dateFrom
  if (f.dateTo) out.dateTo = f.dateTo
  if (f.importedDaysAgo !== undefined) out.importedDaysAgo = String(f.importedDaysAgo)
  if (f.nearLat !== undefined && f.nearLon !== undefined) {
    out.nearLat = String(f.nearLat)
    out.nearLon = String(f.nearLon)
    out.nearRadiusKm = String(f.nearRadiusKm ?? 10)
  }
  if (f.showAiHidden) out.showAiHidden = 'true'
  return out
}

/**
 * Count the number of active criteria in a filter. Used to badge the filter
 * button ("2 Filter aktiv").
 */
export function countActiveFilters(f: PhotoFilter): number {
  let n = 0
  if (f.hiddenMode && f.hiddenMode !== 'exclude') n++
  if (f.favorite) n++
  if (f.albumHighlight) n++
  if (f.groupHighlight) n++
  if (f.inGroup) n++
  if (f.othersFavorited) n++
  if (f.othersHidden) n++
  if (f.notInAnyAlbum) n++
  if (f.qualityMin !== undefined || f.qualityMax !== undefined) n++
  if (f.albumIds?.length) n++
  if (f.personIds?.length) n++
  if (f.ownerIds?.length) n++
  if (f.mediaTypes?.length) n++
  if (f.hasGps !== undefined) n++
  if (f.hasFaces !== undefined) n++
  if (f.hasAssignedPerson !== undefined) n++
  if (f.dateFrom || f.dateTo) n++
  if (f.importedDaysAgo !== undefined) n++
  if (f.nearLat !== undefined && f.nearLon !== undefined) n++
  if (f.showAiHidden) n++
  return n
}

export interface UseFilterOptions {
  /** Extra query keys to preserve unchanged (e.g. view‑specific state). */
  preserveKeys?: string[]
}

export interface UseFilterReturn {
  /** The currently applied filter (what the view should use to fetch data). */
  applied: Ref<PhotoFilter>
  /** The in‑progress filter (edited in the menu). */
  draft: Ref<PhotoFilter>
  /** Number of active criteria in `applied`. */
  activeCount: Ref<number>
  /** Copy applied into draft (open the menu). */
  openEdit: () => void
  /** Apply the draft and sync to URL. */
  apply: () => void
  /** Clear all filters and sync to URL. */
  reset: () => void
  /** Remove a single criterion from applied (and sync). */
  removeKey: (keys: Array<keyof PhotoFilter>) => void
}

export function useFilter(opts: UseFilterOptions = {}): UseFilterReturn {
  const route = useRoute()
  const router = useRouter()

  const applied = ref<PhotoFilter>(parseFilterFromQuery(route.query as Record<string, unknown>))
  const draft = ref<PhotoFilter>({ ...applied.value })
  const activeCount = computed(() => countActiveFilters(applied.value))

  // Keep `applied` in sync when the URL changes (e.g. browser back/forward,
  // or an external navigation that updates query params).
  //
  // Equality check goes through `filterToQuery` so that a filter the user
  // just applied stays stable across the URL round-trip. Without this,
  // booleans that the URL representation drops when false
  // (`favorite: false`, `showAiHidden: false`, etc.) would parse back as
  // a *missing* key, the JSON-of-the-raw-filter would differ from the
  // freshly-applied one, and `applied` would get clobbered to the parsed
  // version. In VirtualGallery that fires a second `source.init()` while
  // the first is still in flight — the race showed up as permanent
  // skeleton cells the moment the user toggled "KI-ausgeblendete
  // anzeigen" off.
  watch(
    () => route.query,
    (q) => {
      const next = parseFilterFromQuery(q as Record<string, unknown>)
      const nextUrl = JSON.stringify(filterToQuery(next))
      const appliedUrl = JSON.stringify(filterToQuery(applied.value))
      if (nextUrl !== appliedUrl) {
        applied.value = next
      }
    }
  )

  async function syncUrl(f: PhotoFilter) {
    const filterQ = filterToQuery(f)
    // Preserve non‑filter query keys (view‑specific state).
    const preserved: Record<string, unknown> = {}
    for (const key of opts.preserveKeys ?? []) {
      const v = route.query[key]
      if (v !== undefined) preserved[key] = v
    }
    const nextQuery = { ...preserved, ...filterQ } as LocationQueryRaw
    if (JSON.stringify(nextQuery) === JSON.stringify(route.query)) return
    await router.replace({ query: nextQuery })
  }

  function openEdit() {
    draft.value = { ...applied.value }
  }

  function apply() {
    applied.value = { ...draft.value }
    void syncUrl(applied.value)
  }

  function reset() {
    draft.value = {}
    applied.value = {}
    void syncUrl({})
  }

  function removeKey(keys: Array<keyof PhotoFilter>) {
    const next = { ...applied.value }
    for (const k of keys) delete (next as Record<string, unknown>)[k as string]
    applied.value = next
    draft.value = { ...next }
    void syncUrl(next)
  }

  return { applied, draft, activeCount, openEdit, apply, reset, removeKey }
}

/**
 * The applied photo filter as removable chips for the shared `ListToolbar`
 * (issue #1272, stage 3). Lived in `FilterChips.vue` until that component
 * became generic; the mapping is photo-specific and belongs here.
 */
export function usePhotoFilterChips(filter: UseFilterReturn): ComputedRef<FilterChip[]> {
  // Album and person names come from the app-wide cache. The fetch is only
  // triggered when the filter actually names one — otherwise a passive chip
  // row would pull the expensive /albums and /persons endpoints on every
  // gallery load.
  const { albums, persons, fetchAlbums, fetchPersons } = useReferenceData()

  watch(
    () => [
      filter.applied.value.albumIds?.length ?? 0,
      filter.applied.value.personIds?.length ?? 0,
    ] as const,
    ([albumCount, personCount]) => {
      if (albumCount > 0) void fetchAlbums().catch(() => { /* ignore */ })
      if (personCount > 0) void fetchPersons().catch(() => { /* ignore */ })
    },
    { immediate: true },
  )

  return computed<FilterChip[]>(() => {
    const f = filter.applied.value
    const out: FilterChip[] = []
    const add = (label: string, keys: Array<keyof PhotoFilter>) => {
      out.push({ key: keys.join(','), label, remove: () => filter.removeKey(keys) })
    }

    if (f.hiddenMode === 'include') add('Inkl. Ausgeblendet', ['hiddenMode'])
    else if (f.hiddenMode === 'only') add('Nur Ausgeblendet', ['hiddenMode'])
    if (f.favorite) add('Favorit', ['favorite'])
    if (f.albumHighlight) add('Album-Highlight', ['albumHighlight'])
    if (f.groupHighlight) add('Gruppen-Highlight', ['groupHighlight'])
    if (f.inGroup) add('In Gruppe', ['inGroup'])
    if (f.othersFavorited) add('Von anderen favorisiert', ['othersFavorited'])
    if (f.othersHidden) add('Von anderen ausgeblendet', ['othersHidden'])
    if (f.notInAnyAlbum) add('Nicht in Album', ['notInAnyAlbum'])

    if (f.qualityMin !== undefined || f.qualityMax !== undefined) {
      add(`Qualität ${f.qualityMin ?? 0}–${f.qualityMax ?? 100}%`, ['qualityMin', 'qualityMax'])
    }
    if (f.albumIds?.length) {
      const names = f.albumIds.map((id) => albums.value.find((a) => a.id === id)?.name ?? `#${id}`)
      const prefix = f.albumMode === 'exclude' ? 'Nicht in Album' : 'In Album'
      add(`${prefix}: ${names.join(', ')}`, ['albumIds', 'albumMode'])
    }
    if (f.personIds?.length) {
      const names = f.personIds.map((id) => persons.value.find((p) => p.id === id)?.name ?? `#${id}`)
      const prefix = f.personMode === 'exclude' ? 'Ohne Person' : 'Mit Person'
      add(`${prefix}: ${names.join(', ')}`, ['personIds', 'personMode'])
    }
    if (f.ownerIds?.length) {
      add(`Besitzer: ${f.ownerIds.map((id) => `#${id}`).join(', ')}`, ['ownerIds'])
    }
    if (f.mediaTypes?.length) {
      const labels: Record<string, string> = { photo: 'Foto', video: 'Video', raw: 'RAW' }
      add(`Medientyp: ${f.mediaTypes.map((t) => labels[t] ?? t).join(', ')}`, ['mediaTypes'])
    }
    if (f.hasGps !== undefined) add(f.hasGps ? 'Mit GPS' : 'Ohne GPS', ['hasGps'])
    if (f.hasFaces !== undefined) add(f.hasFaces ? 'Mit Gesichtern' : 'Ohne Gesichter', ['hasFaces'])
    if (f.hasAssignedPerson !== undefined) {
      add(
        f.hasAssignedPerson ? 'Mit zugeordneter Person' : 'Ohne zugeordnete Person',
        ['hasAssignedPerson'],
      )
    }
    if (f.dateFrom || f.dateTo) {
      add(`Datum ${f.dateFrom ?? '…'} – ${f.dateTo ?? '…'}`, ['dateFrom', 'dateTo'])
    }
    if (f.importedDaysAgo !== undefined) {
      add(`Letzte ${f.importedDaysAgo} Tage`, ['importedDaysAgo'])
    }
    if (f.nearLat !== undefined && f.nearLon !== undefined) {
      add(`In der Nähe (${f.nearRadiusKm ?? 10} km)`, ['nearLat', 'nearLon', 'nearRadiusKm'])
    }
    if (f.showAiHidden) add('Inkl. KI-ausgeblendete', ['showAiHidden'])
    return out
  })
}
