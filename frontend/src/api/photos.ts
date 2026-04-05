import { API_BASE_URL, apiFetch } from './client'

export type CurationStatus = 'visible' | 'hidden' | 'favorite'

export interface Photo {
  id: number
  user_id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  hash?: string
  taken_at?: string
  created_at: string
  curation_status: CurationStatus
  latitude?: number
  longitude?: number
  location_name?: string
  location_city?: string
  location_country?: string
  ai_quality_score?: number
  ai_quality_details?: Record<string, number>
  auto_crop?: { x: number; y: number }
}

export interface ListPhotosResponse {
  photos: Photo[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export function listPhotos(showHidden: boolean = false) {
  const query = showHidden ? '?showHidden=true' : ''
  return apiFetch<ListPhotosResponse>(`/photos${query}`)
}

export async function uploadPhoto(file: File, signal?: AbortSignal) {
  return apiFetch<Photo>('/photos', {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': file.type,
      'X-File-Name': file.name
    }
  })
}

export function uploadPhotoWithProgress(
  file: File,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number) => void
): Promise<Photo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const token = localStorage.getItem('auth_token')

    xhr.open('POST', `${API_BASE_URL}/photos`)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.setRequestHeader('X-File-Name', file.name)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    if (signal) {
      signal.addEventListener('abort', () => xhr.abort())
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status === 401) {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('auth_user')
        window.location.href = `${import.meta.env.BASE_URL}login`
        reject(new Error('Unauthorized'))
        return
      }
      const body = JSON.parse(xhr.responseText || '{}')
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as Photo)
      } else {
        reject(new Error(body.message || body.code || `Request failed: ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Netzwerkfehler beim Hochladen')))
    xhr.addEventListener('abort', () => reject(new Error('Upload abgebrochen')))

    xhr.send(file)
  })
}

export function deletePhoto(id: number) {
  return apiFetch<DeleteResponse>(`/photos/${id}`, {
    method: 'DELETE'
  })
}

export function getPhotoUrl(filename: string, width?: number) {
  const base = `${API_BASE_URL}/photos/file/${filename}`
  return width ? `${base}?w=${width}` : base
}

export function getPhotosToRefreshMetadata() {
  return apiFetch<{ ids: number[] }>('/photos/refresh-metadata')
}

export function refreshPhotoMetadata(id: number) {
  return apiFetch<{ success: boolean; taken_at?: string }>(`/photos/${id}/refresh-metadata`, {
    method: 'POST'
  })
}

export function updatePhotoDate(id: number, taken_at: string) {
  return apiFetch<{ success: boolean; taken_at: string }>(`/photos/${id}/date`, {
    method: 'PATCH',
    body: JSON.stringify({ taken_at })
  })
}

// ---------- People & Faces ----------

export interface FaceBBox { x: number; y: number; width: number; height: number }

export interface Face {
  id: number
  user_id: number
  photo_id: number
  bbox: FaceBBox
  person_id?: number
  quality?: number
  ignored: boolean
  created_at: string
  photo?: Photo
}

export interface Person {
  id: number
  user_id: number
  name: string
  cover_face_id?: number
  cover_filename?: string
  cover_bbox?: FaceBBox
  created_at: string
  updated_at: string
  faceCount?: number
}

export interface ListPersonsResponse {
  persons: Person[]
  enableLocalFaces: boolean
}

export interface PersonDetails extends Person {
  faces: Face[]
}

export function listPersons() {
  return apiFetch<ListPersonsResponse>('/persons')
}

export function getPersonDetails(id: number) {
  return apiFetch<PersonDetails>(`/persons/${id}`)
}

export function updatePerson(id: number, name: string) {
  return apiFetch<Person>(`/persons/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name })
  })
}

export function mergePersons(sourceIds: number[], targetId: number) {
  return apiFetch<{ success: boolean }>('/persons/merge', {
    method: 'POST',
    body: JSON.stringify({ sourceIds, targetId })
  })
}

export function assignFaceToPerson(faceId: number, personId: number) {
  return apiFetch<{ success: boolean }>(`/faces/${faceId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ personId })
  })
}

export interface ScanQueueServiceStatus {
  service: 'embedding' | 'face_detection' | 'landmark'
  pending: number
  processing: number
  failed: number
  done: number
}

export interface ScanQueueStatus {
  services: ScanQueueServiceStatus[]
}

export function getScanQueueStatus() {
  return apiFetch<ScanQueueStatus>('/photos/scan-queue/status')
}

export function getPhotosNeedingGpsRescan() {
  return apiFetch<{ ids: number[] }>('/photos/needs-gps-rescan')
}

export function rescanPhotoGps(id: number) {
  return apiFetch<{ gpsFound: boolean; geocoded: boolean; scansQueued: boolean }>(
    `/photos/${id}/rescan-gps`, { method: 'POST' }
  )
}

export function rescanPhotos(force: boolean) {
  return apiFetch<{ queued: number }>('/photos/rescan', {
    method: 'POST',
    body: JSON.stringify({ force })
  })
}

export function retryFailedScans() {
  return apiFetch<{ retried: number }>('/photos/scan-queue/retry-failed', {
    method: 'POST'
  })
}

export function cancelPendingScans() {
  return apiFetch<{ cancelled: number }>('/photos/scan-queue/cancel', {
    method: 'POST'
  })
}

export function recomputeAutoCrops() {
  return apiFetch<{ updated: number }>('/photos/recompute-auto-crops', {
    method: 'POST'
  })
}

export function reindexPhoto(id: number) {
  return apiFetch<{ success: boolean }>(`/photos/${id}/reindex`, {
    method: 'POST'
  })
}

export function ignoreFace(faceId: number) {
  return apiFetch<{ success: boolean }>(`/faces/${faceId}/ignore`, {
    method: 'POST'
  })
}

export function ignorePersonFaces(personId: number) {
  return apiFetch<{ success: boolean }>(`/persons/${personId}/ignore`, {
    method: 'POST'
  })
}

export function getPhotoFaces(id: number) {
  return apiFetch<{ faces: Face[] }>(`/photos/${id}/faces`)
}

// ---------- Curation ----------

export function updatePhotoCuration(id: number, status: CurationStatus) {
  return apiFetch<{ success: boolean }>(`/photos/${id}/curation`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  })
}

export function hardDeletePhoto(id: number) {
  return apiFetch<DeleteResponse>(`/photos/${id}/hard`, {
    method: 'DELETE'
  })
}

// ---------- Albums ----------

export interface Album {
  id: number
  user_id: number
  name: string
  description?: string
  cover_photo_id?: number
  cover_filename?: string
  newest_photo_at?: string
  oldest_photo_at?: string
  photo_count: number
  is_shared: boolean
  created_at: string
  updated_at: string
}

export type ActiveView = 'all' | 'favorites' | 'consensus' | 'custom'

export interface ViewConfig {
  hideFilter: 'none' | 'mine' | 'consensus'
  hideConsensusMin?: number
  favFilter: 'all' | 'mine' | 'any' | 'consensus'
  favConsensusMin?: number
}

export interface PhotoCurationStats {
  fav_count: number
  hide_count: number
  member_count: number
}

export interface AlbumUserSettings {
  album_id: number
  user_id: number
  hide_mode: 'mine' | 'all'
  active_view: ActiveView
  view_config?: ViewConfig | null
}

export interface AlbumPhoto extends Photo {
  added_by_user_id?: number
  added_at: string
  curation_stats?: PhotoCurationStats
}

export interface AlbumWithPhotos extends Album {
  photos: AlbumPhoto[]
  settings?: AlbumUserSettings
  role: 'owner' | 'admin' | 'contributor' | 'viewer'
}

export function listAlbums() {
  return apiFetch<{ albums: Album[] }>('/albums')
}

export function getAlbum(id: number) {
  return apiFetch<AlbumWithPhotos>(`/albums/${id}`)
}

export function createAlbum(name: string, description?: string) {
  return apiFetch<Album>('/albums', {
    method: 'POST',
    body: JSON.stringify({ name, description })
  })
}

export function updateAlbum(id: number, patch: { name?: string; description?: string; coverPhotoId?: number | null }) {
  return apiFetch<Album>('/albums', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch })
  })
}

export function deleteAlbum(id: number) {
  return apiFetch<DeleteResponse>(`/albums/${id}`, {
    method: 'DELETE'
  })
}

export function addPhotoToAlbum(albumId: number, photoId: number) {
  return apiFetch<{ success: boolean }>('/albums/photos', {
    method: 'POST',
    body: JSON.stringify({ albumId, photoId })
  })
}

export function getPhotosAlbums(ids: number[]) {
  return apiFetch<{ results: { photoId: number; albumIds: number[] }[] }>(`/photos/albums?ids=${ids.join(',')}`)
}

export function batchUpdateAlbumPhotos(albumIds: number[], photoIds: number[], action: 'add' | 'remove') {
  return apiFetch<{ success: boolean }>('/albums/photos/batch', {
    method: 'POST',
    body: JSON.stringify({ albumIds, photoIds, action })
  })
}

export function shareAlbum(albumId: number, userId: number, accessLevel: 'read' | 'write') {
  return apiFetch<{ success: boolean }>('/albums/share', {
    method: 'POST',
    body: JSON.stringify({ albumId, userId, accessLevel })
  })
}

export interface AlbumShareWithUser {
  album_id: number
  user_id: number
  access_level: 'read' | 'write'
  user_name: string
  user_email: string
}

export function getAlbumShares(albumId: number) {
  return apiFetch<{ shares: AlbumShareWithUser[] }>(`/albums/${albumId}/shares`)
}

export function removeAlbumShare(albumId: number, userId: number) {
  return apiFetch<{ success: boolean }>(`/albums/${albumId}/shares/${userId}`, {
    method: 'DELETE'
  })
}

export function updateAlbumUserSettings(albumId: number, settings: Partial<AlbumUserSettings>) {
  const { album_id, user_id, ...rest } = settings as any
  const req: Record<string, unknown> = {}
  if (rest.hide_mode) req.hideMode = rest.hide_mode
  if (rest.active_view) req.activeView = rest.active_view
  if (rest.view_config !== undefined) req.viewConfig = rest.view_config

  return apiFetch<AlbumUserSettings>(`/albums/${albumId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(req)
  })
}

// ---------- Photo Groups ----------

export interface PhotoGroup {
  id: number
  user_id: number
  cover_photo_id?: number
  reviewed_at?: string
  created_at: string
  member_count: number
  photo_ids: number[]
}

export function findPhotoGroups() {
  return apiFetch<{ groups_created: number; total_photos_grouped: number }>('/photos/find-groups', {
    method: 'POST'
  })
}

export function listPhotoGroups() {
  return apiFetch<{ groups: PhotoGroup[] }>('/photos/groups')
}

export function getNextUnreviewedGroup() {
  return apiFetch<PhotoGroup | null>('/photos/groups/next-unreviewed')
}

export function reviewPhotoGroup(id: number) {
  return apiFetch<{ success: boolean }>(`/photos/groups/${id}/review`, {
    method: 'POST'
  })
}

// ---------- Semantic Search ----------

export interface PhotoSearchResult {
  photoId: number
  score: number
  filename: string
  taken_at?: string
  created_at: string
}

export function searchPhotos(query: string, limit: number = 1000, threshold: number = 0.20) {
  return apiFetch<{ results: PhotoSearchResult[] }>('/photos/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit, threshold })
  })
}

// ---------- Landmarks ----------

export interface LandmarkBBox { x: number; y: number; width: number; height: number }

export interface LandmarkItem {
  id: number
  label: string
  confidence: number
  bbox: LandmarkBBox
}

export interface PhotoLocation {
  name?: string
  city?: string
  country?: string
}

export function getPhotoLandmarks(id: number) {
  return apiFetch<{ landmarks: LandmarkItem[]; location?: PhotoLocation }>(`/photos/${id}/landmarks`)
}

// ---------- Service Health ----------

export type ExternalServiceName = 'insightface' | 'embedding' | 'landmark'

export interface ExternalServiceHealth {
  name: ExternalServiceName
  available: boolean
  lastChecked: string | null
  lastError: string | null
}

export function getExternalServiceHealth() {
  return apiFetch<{ services: ExternalServiceHealth[] }>('/photos/service-health')
}

