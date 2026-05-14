import { apiFetch } from './client'

export type LibraryImportMode = 'link' | 'move'

export interface ActiveLibraryScan {
  status: 'pending' | 'processing' | 'failed'
  reconcile: boolean
  scanned: number | null
  error_msg: string | null
}

export interface PhotoLibrary {
  id: number
  user_id: number
  name: string
  path: string
  import_mode: LibraryImportMode
  auto_import: boolean
  auto_albums: boolean
  /** 1..5 = auto-favourite photos whose XMP:Rating is at least this value. 0 = disabled. */
  favorite_rating_threshold: number
  created_at: string | null
  last_scan_at: string | null
  active_scan: ActiveLibraryScan | null
}

export interface CreateLibraryRequest {
  name: string
  path: string
  import_mode?: LibraryImportMode
  auto_import?: boolean
  auto_albums?: boolean
  favorite_rating_threshold?: number
}

export interface UpdateLibraryRequest {
  name?: string
  import_mode?: LibraryImportMode
  auto_import?: boolean
  auto_albums?: boolean
  favorite_rating_threshold?: number
}

export interface ScanReport {
  scanned: number
  imported: number
  skipped_duplicate: number
  skipped_unsupported: number
  skipped_empty: number
  errors: number
}

export interface ListLibrariesResponse {
  libraries: PhotoLibrary[]
}

export interface AvailableDirectory {
  name: string
  rel_path: string
  abs_path: string
  already_registered: boolean
  mounted: boolean
}

export interface AvailablePathsResponse {
  root: string
  root_mounted: boolean
  sub: string
  abs_path: string
  current_registered: boolean
  current_mounted: boolean
  directories: AvailableDirectory[]
}

export function listLibraries() {
  return apiFetch<ListLibrariesResponse>('/libraries')
}

export function listAvailablePaths(sub: string = '') {
  const qs = sub ? `?sub=${encodeURIComponent(sub)}` : ''
  return apiFetch<AvailablePathsResponse>(`/libraries/available-paths${qs}`)
}

export function getLibrary(id: number) {
  return apiFetch<PhotoLibrary>(`/libraries/${id}`)
}

export function createLibrary(req: CreateLibraryRequest) {
  return apiFetch<PhotoLibrary>('/libraries', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function updateLibrary(id: number, req: UpdateLibraryRequest) {
  return apiFetch<PhotoLibrary>(`/libraries/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ id, ...req }),
  })
}

export function deleteLibrary(id: number) {
  return apiFetch<{ success: boolean }>(`/libraries/${id}`, {
    method: 'DELETE',
  })
}

export function scanLibrary(id: number) {
  return apiFetch<{ queued: boolean }>(`/libraries/${id}/scan`, {
    method: 'POST',
  })
}

export function reconcileLibrary(id: number) {
  return apiFetch<{ queued: boolean }>(`/libraries/${id}/reconcile`, {
    method: 'POST',
  })
}
