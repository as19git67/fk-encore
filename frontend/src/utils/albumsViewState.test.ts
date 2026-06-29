import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  albumMenuTarget,
  ALBUMS_STATE_STORAGE_KEY,
  LAST_FOCUSED_ALBUM_KEY,
  albumsStateToQuery,
  albumsViewQueryFromStorage,
  defaultAlbumsState,
  hasAnyAlbumsFilterQueryParam,
  loadAlbumsStateFromStorage,
  parseAlbumsStateFromQuery,
  readRememberedAlbumId,
  rememberFocusedAlbumId,
  saveAlbumsStateToStorage,
  sanitizeAlbumFilter,
  sanitizeAlbumSort,
} from './albumsViewState'

// jsdom-style localStorage stub — vitest's default node environment doesn't
// ship one, and we want this util to work both in the browser and in tests
// without forcing a jsdom dep.
function installLocalStorageStub() {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  }
  vi.stubGlobal('localStorage', stub)
  return stub
}

describe('albumsViewState', () => {
  describe('albumMenuTarget', () => {
    it('returns to the list when already in the album list or details', () => {
      expect(albumMenuTarget('fotos-albums', 7)).toEqual({ name: 'fotos-albums' })
      expect(albumMenuTarget('fotos-album-detail', 7)).toEqual({ name: 'fotos-albums' })
    })

    it('resumes the remembered album from another photo view', () => {
      expect(albumMenuTarget('fotos-gallery', 7)).toEqual({ name: 'fotos-album-detail', params: { id: 7 } })
      expect(albumMenuTarget('fotos-gallery', null)).toEqual({ name: 'fotos-albums' })
    })
  })

  beforeEach(() => {
    installLocalStorageStub()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sanitizeAlbumFilter', () => {
    it('returns defaults for empty input', () => {
      const f = sanitizeAlbumFilter(undefined)
      expect(f.owner).toBe('all')
      expect(f.display).toBe('all')
      expect(f.emptyMode).toBe('any')
      expect(f.sharedByMe).toBe(false)
      expect(f.sharedWithMe).toBe(false)
      expect(f.dateFrom).toBeUndefined()
      expect(f.dateTo).toBeUndefined()
    })

    it('preserves valid values', () => {
      const f = sanitizeAlbumFilter({
        owner: 'mine',
        display: 'grid',
        emptyMode: 'exclude',
        sharedByMe: true,
        sharedWithMe: true,
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
      })
      expect(f.owner).toBe('mine')
      expect(f.display).toBe('grid')
      expect(f.emptyMode).toBe('exclude')
      expect(f.sharedByMe).toBe(true)
      expect(f.sharedWithMe).toBe(true)
      expect(f.dateFrom).toBe('2024-01-01')
      expect(f.dateTo).toBe('2024-12-31')
    })

    it('drops unknown enum values', () => {
      const f = sanitizeAlbumFilter({
        owner: 'bogus' as never,
        display: 'foo' as never,
        emptyMode: 'bar' as never,
      })
      expect(f.owner).toBe('all')
      expect(f.display).toBe('all')
      expect(f.emptyMode).toBe('any')
    })
  })

  describe('sanitizeAlbumSort', () => {
    it('returns the default for empty input', () => {
      const s = sanitizeAlbumSort(undefined)
      expect(s.field).toBe('newest_photo_at')
      expect(s.direction).toBe('desc')
    })

    it('preserves valid sort fields', () => {
      const s = sanitizeAlbumSort({ field: 'name', direction: 'asc' })
      expect(s.field).toBe('name')
      expect(s.direction).toBe('asc')
    })

    it('rejects unknown sort fields', () => {
      const s = sanitizeAlbumSort({ field: 'mystery', direction: 'asc' })
      expect(s.field).toBe('newest_photo_at')
    })
  })

  describe('hasAnyAlbumsFilterQueryParam', () => {
    it('returns false for an empty query', () => {
      expect(hasAnyAlbumsFilterQueryParam({})).toBe(false)
    })

    it('returns false for unrelated params', () => {
      expect(hasAnyAlbumsFilterQueryParam({ utm_source: 'x' })).toBe(false)
    })

    it('returns true when any filter key is present', () => {
      expect(hasAnyAlbumsFilterQueryParam({ owner: 'mine' })).toBe(true)
      expect(hasAnyAlbumsFilterQueryParam({ q: 'urlaub' })).toBe(true)
      expect(hasAnyAlbumsFilterQueryParam({ sortBy: 'name' })).toBe(true)
    })

    it('treats empty strings as absent', () => {
      expect(hasAnyAlbumsFilterQueryParam({ owner: '' })).toBe(false)
    })
  })

  describe('parseAlbumsStateFromQuery / albumsStateToQuery', () => {
    it('round-trips a non-default state', () => {
      const state = {
        filter: {
          owner: 'mine' as const,
          display: 'grid' as const,
          emptyMode: 'exclude' as const,
          sharedByMe: true,
          sharedWithMe: false,
          dateFrom: '2024-01-01',
          dateTo: '2024-12-31',
        },
        sort: { field: 'name', direction: 'asc' as const },
        searchQuery: 'urlaub',
      }
      const query = albumsStateToQuery(state)
      const parsed = parseAlbumsStateFromQuery(query)
      expect(parsed).toEqual(state)
    })

    it('omits default-valued keys from the query', () => {
      const query = albumsStateToQuery(defaultAlbumsState())
      expect(query).toEqual({})
    })
  })

  describe('storage round-trip', () => {
    it('returns defaults when nothing stored', () => {
      const s = loadAlbumsStateFromStorage()
      expect(s).toEqual(defaultAlbumsState())
    })

    it('round-trips a saved state', () => {
      const state = {
        filter: {
          owner: 'shared' as const,
          display: 'all' as const,
          emptyMode: 'only' as const,
          sharedByMe: false,
          sharedWithMe: true,
          dateFrom: undefined,
          dateTo: undefined,
        },
        sort: { field: 'photo_count', direction: 'asc' as const },
        searchQuery: 'foo',
      }
      saveAlbumsStateToStorage(state)
      const loaded = loadAlbumsStateFromStorage()
      expect(loaded).toEqual(state)
    })

    it('falls back to defaults on malformed JSON', () => {
      localStorage.setItem(ALBUMS_STATE_STORAGE_KEY, '{not json')
      expect(loadAlbumsStateFromStorage()).toEqual(defaultAlbumsState())
    })
  })

  describe('rememberFocusedAlbumId / readRememberedAlbumId', () => {
    it('reads back what was stored', () => {
      rememberFocusedAlbumId(42)
      expect(readRememberedAlbumId()).toBe(42)
    })

    it('returns null when absent', () => {
      expect(readRememberedAlbumId()).toBeNull()
    })

    it('ignores non-finite ids', () => {
      rememberFocusedAlbumId(Number.NaN)
      expect(localStorage.getItem(LAST_FOCUSED_ALBUM_KEY)).toBeNull()
    })

    it('returns null for a corrupted stored value', () => {
      localStorage.setItem(LAST_FOCUSED_ALBUM_KEY, 'not-a-number')
      expect(readRememberedAlbumId()).toBeNull()
    })
  })

  describe('albumsViewQueryFromStorage', () => {
    it('returns the query that the list view would render with', () => {
      saveAlbumsStateToStorage({
        filter: {
          owner: 'mine',
          display: 'all',
          emptyMode: 'any',
          sharedByMe: false,
          sharedWithMe: false,
        },
        sort: { field: 'name', direction: 'asc' },
        searchQuery: '',
      })
      expect(albumsViewQueryFromStorage()).toEqual({
        owner: 'mine',
        sortBy: 'name',
        sortDir: 'asc',
      })
    })

    it('returns an empty query when nothing is persisted', () => {
      expect(albumsViewQueryFromStorage()).toEqual({})
    })
  })
})
