import { apiFetch } from './client'

export type LibraryImportMode = 'link' | 'move'

export interface PhotoLibrary {
  id: number
  user_id: number
  name: string
  path: string
  import_mode: LibraryImportMode
  auto_import: boolean
  created_at: string | null
  last_scan_at: string | null
}

export interface CreateLibraryRequest {
  name: string
  path: string
  import_mode?: LibraryImportMode
  auto_import?: boolean
}

export interface UpdateLibraryRequest {
  name?: string
  import_mode?: LibraryImportMode
  auto_import?: boolean
}

export interface ScanReport {
  scanned: number
  imported: number
  skipped_duplicate: number
  skipped_unsupported: number
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
}

export interface AvailablePathsResponse {
  root: string
  directories: AvailableDirectory[]
}

export function listLibraries() {
  return apiFetch<ListLibrariesResponse>('/libraries')
}

export function listAvailablePaths() {
  return apiFetch<AvailablePathsResponse>('/libraries/available-paths')
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
  return apiFetch<ScanReport>(`/libraries/${id}/scan`, {
    method: 'POST',
  })
}

export function reconcileLibrary(id: number) {
  return apiFetch<{ removed: number }>(`/libraries/${id}/reconcile`, {
    method: 'POST',
  })
}
