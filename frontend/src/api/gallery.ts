/**
 * Client for the virtualized gallery grid endpoint.
 *
 * The gallery is *windowed*: the server returns `total` (the row count for
 * the current filter+sort) plus a dense slice `photos[]` starting at the
 * given `offset` in the global ordering. The frontend never holds the full
 * library in memory — it builds a sparse array of length `total` and only
 * fills the slots that the user has scrolled near.
 */
import { apiFetch } from './client'

export type GallerySortField =
  | 'taken_at'
  | 'created_at'
  | 'ai_quality_score'
  | 'filename'
  | 'size'

export type GallerySortDir = 'asc' | 'desc'

export type GalleryCuration = 'visible' | 'hidden' | 'favorite'

export interface GalleryGridGroup {
  id: number
  /** True when this photo is the cover_photo_id of the group. */
  is_cover: boolean
  /** Total photos in the group. */
  member_count: number
  /** True when the user has reviewed the group. */
  reviewed: boolean
}

/** One cell in the grid. Pre-enriched server-side; no client computation. */
export interface GalleryGridEntry {
  id: number
  filename: string
  curation: GalleryCuration
  auto_crop?: { x: number; y: number }
  group?: GalleryGridGroup
}

export interface GalleryGridResponse {
  total: number
  offset: number
  photos: GalleryGridEntry[]
}

export interface GalleryGridQuery {
  limit: number
  offset?: number
  /** When `offset` is undefined, the server centers the window on this photo. */
  aroundPhotoId?: number
  sortBy?: GallerySortField
  sortDir?: GallerySortDir
}

export function getGalleryGrid(
  query: GalleryGridQuery,
  options?: { signal?: AbortSignal },
): Promise<GalleryGridResponse> {
  const sp = new URLSearchParams()
  sp.set('limit', String(query.limit))
  if (query.offset !== undefined) sp.set('offset', String(query.offset))
  if (query.aroundPhotoId !== undefined) sp.set('aroundPhotoId', String(query.aroundPhotoId))
  if (query.sortBy) sp.set('sortBy', query.sortBy)
  if (query.sortDir) sp.set('sortDir', query.sortDir)
  return apiFetch<GalleryGridResponse>(`/gallery/grid?${sp.toString()}`, {
    signal: options?.signal,
  })
}

/**
 * Build the URL for a thumbnail of a given photo at a given width. Mirrors
 * `/photos/file/<filename>?w=<width>` used by the legacy gallery; kept as
 * a small wrapper here so the new gallery does not import from the legacy
 * `api/photos.ts` (greenfield).
 */
export function getThumbUrl(filename: string, width: number): string {
  const apiBase = import.meta.env.PROD ? '' : '/api'
  return `${apiBase}/photos/file/${filename}?w=${width}`
}
