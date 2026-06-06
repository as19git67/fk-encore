import type { Album } from '../api/photos'

export interface UploadAlbum {
  id: number
  name: string
}

// Albums the user may add photos to: owned or shared with write access.
const WRITABLE_LEVELS = new Set(['owner', 'write', 'write_share'])

export function writableAlbums(albums: Album[]): UploadAlbum[] {
  return albums
    .filter((a) => WRITABLE_LEVELS.has(a.my_access_level ?? ''))
    .map((a) => ({ id: a.id, name: a.name }))
}

/** Case-insensitive substring filter over album names (for the dialog search). */
export function filterAlbums(albums: UploadAlbum[], query: string): UploadAlbum[] {
  const q = query.trim().toLowerCase()
  if (!q) return albums
  return albums.filter((a) => a.name.toLowerCase().includes(q))
}

const LAST_SELECTION_KEY = 'feed_upload_last_albums'

export function loadLastAlbumSelection(): number[] {
  try {
    const raw = localStorage.getItem(LAST_SELECTION_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

export function saveLastAlbumSelection(ids: number[]): void {
  try {
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(ids))
  } catch {
    // localStorage may be unavailable (private mode) — pre-selection simply
    // won't persist; not worth failing the upload over.
  }
}

/**
 * Dialog pre-selection: last time's choice, intersected with the albums
 * currently available (a since-deleted album must not stay checked).
 */
export function initialAlbumSelection(available: UploadAlbum[]): number[] {
  const ids = new Set(available.map((a) => a.id))
  return loadLastAlbumSelection().filter((id) => ids.has(id))
}
