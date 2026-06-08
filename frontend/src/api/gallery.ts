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
import type { PhotoFilter } from './photos'

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
  // AI auto-pick (Track I). When `ai_confidence` is set the group has
  // been scored and `ai_picked` tells you whether this photo is in the
  // pick list. Reviewed groups still set these to surface the marker.
  ai_picked?: boolean
  ai_confidence?: 'high' | 'medium' | 'low'
}

/** One cell in the grid. Pre-enriched server-side; no client computation. */
export interface GalleryGridEntry {
  id: number
  filename: string
  curation: GalleryCuration
  auto_crop?: { x: number; y: number }
  group?: GalleryGridGroup
  /**
   * Comments on this photo within the current album. Only set when the grid
   * is album-scoped (comments are album-bound); absent in the global gallery.
   * Drives the album-only "has comments" badge.
   */
  comment_count?: number
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
  /** Optional filter — same shape as the legacy /photos/index filter. */
  filter?: PhotoFilter
  /**
   * Restrict the result set (and ordering) to this list of photo IDs in
   * the order given. Used by natural-language search to preserve the
   * search engine's relevance ranking. Filters still apply on top.
   */
  photoIds?: number[]
}

function buildFilterParams(filter: PhotoFilter | undefined, sp: URLSearchParams) {
  if (!filter) return
  const add = (k: string, v: string | number | boolean) => sp.set(k, String(v))
  if (filter.hiddenMode) add('hiddenMode', filter.hiddenMode)
  if (filter.favorite) add('favorite', true)
  if (filter.albumHighlight) add('albumHighlight', true)
  if (filter.groupHighlight) add('groupHighlight', true)
  if (filter.inGroup) add('inGroup', true)
  if (filter.othersFavorited) add('othersFavorited', true)
  if (filter.othersHidden) add('othersHidden', true)
  if (filter.qualityMin !== undefined) add('qualityMin', filter.qualityMin)
  if (filter.qualityMax !== undefined) add('qualityMax', filter.qualityMax)
  if (filter.notInAnyAlbum) add('notInAnyAlbum', true)
  if (filter.albumIds && filter.albumIds.length) add('albumIds', filter.albumIds.join(','))
  if (filter.albumMode) add('albumMode', filter.albumMode)
  if (filter.personIds && filter.personIds.length) add('personIds', filter.personIds.join(','))
  if (filter.personMode) add('personMode', filter.personMode)
  if (filter.mediaTypes && filter.mediaTypes.length) add('mediaTypes', filter.mediaTypes.join(','))
  if (filter.hasGps !== undefined) add('hasGps', filter.hasGps)
  if (filter.hasFaces !== undefined) add('hasFaces', filter.hasFaces)
  if (filter.hasAssignedPerson !== undefined) add('hasAssignedPerson', filter.hasAssignedPerson)
  if (filter.dateFrom) add('dateFrom', filter.dateFrom)
  if (filter.dateTo) add('dateTo', filter.dateTo)
  if (filter.importedDaysAgo !== undefined) add('importedDaysAgo', filter.importedDaysAgo)
  if (filter.sizeMin !== undefined) add('sizeMin', filter.sizeMin)
  if (filter.sizeMax !== undefined) add('sizeMax', filter.sizeMax)
  if (filter.showAiHidden) add('showAiHidden', true)
  if (filter.albumScopeId !== undefined) add('albumScopeId', filter.albumScopeId)
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
  buildFilterParams(query.filter, sp)
  if (query.photoIds && query.photoIds.length > 0) {
    sp.set('photoIds', query.photoIds.join(','))
  }
  return apiFetch<GalleryGridResponse>(`/gallery/grid?${sp.toString()}`, {
    signal: options?.signal,
  })
}

export interface GalleryIdsQuery {
  sortBy?: GallerySortField
  sortDir?: GallerySortDir
  filter?: PhotoFilter
  photoIds?: number[]
}

export function getGalleryIds(
  query: GalleryIdsQuery,
  options?: { signal?: AbortSignal },
): Promise<{ ids: number[] }> {
  const sp = new URLSearchParams()
  if (query.sortBy) sp.set('sortBy', query.sortBy)
  if (query.sortDir) sp.set('sortDir', query.sortDir)
  buildFilterParams(query.filter, sp)
  if (query.photoIds && query.photoIds.length > 0) {
    sp.set('photoIds', query.photoIds.join(','))
  }
  return apiFetch<{ ids: number[] }>(`/gallery/ids?${sp.toString()}`, {
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
