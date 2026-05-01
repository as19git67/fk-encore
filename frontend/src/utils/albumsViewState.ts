import type { SortState } from '../composables/useSort'

// Filter / sort / search state that the albums list renders from. Extracted
// into a pure module so AlbumDetailView can hand the same query params back
// to the router when navigating to the list — without that, leaving an album
// would briefly drop the user onto an unfiltered list before the list view
// re-applied state from localStorage on its own mount.

export type AlbumOwnerFilter = 'all' | 'mine' | 'shared'
export type AlbumDisplayFilter = 'all' | 'grid' | 'map'
export type AlbumEmptyFilter = 'any' | 'only' | 'exclude'

export interface AlbumFilter {
  owner: AlbumOwnerFilter
  display: AlbumDisplayFilter
  dateFrom?: string  // ISO YYYY-MM-DD
  dateTo?: string
  emptyMode: AlbumEmptyFilter
  sharedByMe: boolean
  sharedWithMe: boolean
}

export const EMPTY_ALBUM_FILTER: AlbumFilter = {
  owner: 'all',
  display: 'all',
  emptyMode: 'any',
  sharedByMe: false,
  sharedWithMe: false,
}

export const DEFAULT_ALBUM_SORT: SortState = { field: 'newest_photo_at', direction: 'desc' }

export const ALBUM_SORT_FIELD_VALUES: ReadonlyArray<string> = [
  'newest_photo_at',
  'name',
  'created_at',
  'photo_count',
]

export interface AlbumsPersistedState {
  filter: AlbumFilter
  sort: SortState
  searchQuery: string
}

export const ALBUMS_STATE_STORAGE_KEY = 'albums_view_state'
export const LAST_FOCUSED_ALBUM_KEY = 'albums_last_focused_album_id'

const FILTER_QUERY_KEYS = [
  'q', 'owner', 'display', 'emptyMode', 'sharedByMe', 'sharedWithMe',
  'dateFrom', 'dateTo', 'sortBy', 'sortDir',
] as const

export function defaultAlbumsState(): AlbumsPersistedState {
  return {
    filter: { ...EMPTY_ALBUM_FILTER },
    sort: { ...DEFAULT_ALBUM_SORT },
    searchQuery: '',
  }
}

export function sanitizeAlbumFilter(raw: Partial<AlbumFilter> | undefined): AlbumFilter {
  const f = raw ?? {}
  const validOwners: AlbumOwnerFilter[] = ['all', 'mine', 'shared']
  const validDisplays: AlbumDisplayFilter[] = ['all', 'grid', 'map']
  const validEmpties: AlbumEmptyFilter[] = ['any', 'only', 'exclude']
  return {
    owner: validOwners.includes(f.owner as AlbumOwnerFilter) ? (f.owner as AlbumOwnerFilter) : 'all',
    display: validDisplays.includes(f.display as AlbumDisplayFilter) ? (f.display as AlbumDisplayFilter) : 'all',
    emptyMode: validEmpties.includes(f.emptyMode as AlbumEmptyFilter) ? (f.emptyMode as AlbumEmptyFilter) : 'any',
    sharedByMe: f.sharedByMe === true,
    sharedWithMe: f.sharedWithMe === true,
    dateFrom: typeof f.dateFrom === 'string' && f.dateFrom ? f.dateFrom : undefined,
    dateTo: typeof f.dateTo === 'string' && f.dateTo ? f.dateTo : undefined,
  }
}

export function sanitizeAlbumSort(raw: Partial<SortState> | undefined): SortState {
  const f = raw ?? {}
  return {
    field: typeof f.field === 'string' && ALBUM_SORT_FIELD_VALUES.includes(f.field) ? f.field : DEFAULT_ALBUM_SORT.field,
    direction: f.direction === 'asc' || f.direction === 'desc' ? f.direction : DEFAULT_ALBUM_SORT.direction,
  }
}

export function loadAlbumsStateFromStorage(): AlbumsPersistedState {
  try {
    const raw = localStorage.getItem(ALBUMS_STATE_STORAGE_KEY)
    if (!raw) return defaultAlbumsState()
    const parsed = JSON.parse(raw) as Partial<AlbumsPersistedState>
    return {
      filter: sanitizeAlbumFilter(parsed?.filter),
      sort: sanitizeAlbumSort(parsed?.sort),
      searchQuery: typeof parsed?.searchQuery === 'string' ? parsed.searchQuery : '',
    }
  } catch {
    return defaultAlbumsState()
  }
}

export function saveAlbumsStateToStorage(state: AlbumsPersistedState): void {
  try {
    localStorage.setItem(ALBUMS_STATE_STORAGE_KEY, JSON.stringify(state))
  } catch { /* storage unavailable */ }
}

export function hasAnyAlbumsFilterQueryParam(q: Record<string, unknown>): boolean {
  return FILTER_QUERY_KEYS.some(k => typeof q[k] === 'string' && (q[k] as string).length > 0)
}

export function parseAlbumsStateFromQuery(q: Record<string, unknown>): AlbumsPersistedState {
  const filter = sanitizeAlbumFilter({
    owner: q.owner as AlbumOwnerFilter,
    display: q.display as AlbumDisplayFilter,
    emptyMode: q.emptyMode as AlbumEmptyFilter,
    sharedByMe: q.sharedByMe === '1',
    sharedWithMe: q.sharedWithMe === '1',
    dateFrom: typeof q.dateFrom === 'string' ? q.dateFrom : undefined,
    dateTo: typeof q.dateTo === 'string' ? q.dateTo : undefined,
  })
  const sort = sanitizeAlbumSort({
    field: typeof q.sortBy === 'string' ? q.sortBy : undefined,
    direction: (q.sortDir === 'asc' || q.sortDir === 'desc') ? q.sortDir : undefined,
  })
  const searchQuery = typeof q.q === 'string' ? q.q : ''
  return { filter, sort, searchQuery }
}

export function albumsStateToQuery(state: AlbumsPersistedState): Record<string, string> {
  const out: Record<string, string> = {}
  const { filter, sort, searchQuery } = state
  if (searchQuery) out.q = searchQuery
  if (filter.owner !== 'all') out.owner = filter.owner
  if (filter.display !== 'all') out.display = filter.display
  if (filter.emptyMode !== 'any') out.emptyMode = filter.emptyMode
  if (filter.sharedByMe) out.sharedByMe = '1'
  if (filter.sharedWithMe) out.sharedWithMe = '1'
  if (filter.dateFrom) out.dateFrom = filter.dateFrom
  if (filter.dateTo) out.dateTo = filter.dateTo
  if (sort.field !== DEFAULT_ALBUM_SORT.field) out.sortBy = sort.field
  if (sort.direction !== DEFAULT_ALBUM_SORT.direction) out.sortDir = sort.direction
  return out
}

export function rememberFocusedAlbumId(id: number): void {
  if (!Number.isFinite(id)) return
  try { localStorage.setItem(LAST_FOCUSED_ALBUM_KEY, String(id)) } catch { /* ignore */ }
}

export function readRememberedAlbumId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_FOCUSED_ALBUM_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  } catch { return null }
}

/**
 * Builds the URL query that the albums list would render with right now,
 * using the persisted filter/sort/search. Used by callers that navigate TO
 * the list (e.g. the back arrow in AlbumDetailView) so the URL reflects the
 * user's last filters from the start, instead of relying on AlbumsView's
 * mount-time URL rewrite which can flash an unfiltered list.
 */
export function albumsViewQueryFromStorage(): Record<string, string> {
  return albumsStateToQuery(loadAlbumsStateFromStorage())
}
