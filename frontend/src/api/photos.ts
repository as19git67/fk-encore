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
  location_short?: string
  ai_quality_score?: number
  ai_quality_details?: Record<string, number>
  auto_crop?: { x: number; y: number }
  description?: string
  /** IPTC Keywords / XMP dc:subject — tags imported from the file. Read-only in the UI. */
  keywords?: string[]
}

export interface ListPhotosResponse {
  photos: Photo[]
}

/**
 * Lightweight photo entry for the gallery index. Heavy fields
 * (location_*, ai_quality_*, description, hash, GPS) are omitted and must be
 * fetched on demand via getPhotoDetailsBatch.
 *
 * The shape is structurally compatible with `Photo` (just with several
 * optional fields undefined), so an index entry can be widened to `Photo`
 * without conversion — frontend code that reads e.g. `photo.location_name`
 * will simply see `undefined` until the details are hydrated.
 */
export interface PhotoIndexEntry {
  id: number
  user_id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  taken_at?: string
  created_at: string
  curation_status: CurationStatus
  auto_crop?: { x: number; y: number }
}

export interface ListPhotoIndexResponse {
  photos: PhotoIndexEntry[]
}

export interface PhotoDetailsBatchResponse {
  photos: Photo[]
}

export interface DeleteResponse {
  success: boolean
  message: string
}

export type HiddenMode = 'exclude' | 'include' | 'only'
export type MembershipMode = 'include' | 'exclude'
export type MediaType = 'photo' | 'video' | 'raw'

export interface PhotoFilter {
  hiddenMode?: HiddenMode
  favorite?: boolean
  albumHighlight?: boolean
  groupHighlight?: boolean
  inGroup?: boolean
  othersFavorited?: boolean
  othersHidden?: boolean
  qualityMin?: number
  qualityMax?: number
  notInAnyAlbum?: boolean
  albumIds?: number[]
  albumMode?: MembershipMode
  personIds?: number[]
  personMode?: MembershipMode
  mediaTypes?: MediaType[]
  hasGps?: boolean
  hasFaces?: boolean
  hasAssignedPerson?: boolean
  dateFrom?: string
  dateTo?: string
  importedDaysAgo?: number
  sizeMin?: number
  sizeMax?: number
  ownerIds?: number[]
  // AI auto-pick visibility (Track I). false (default) → AI-hidden
  // photos are excluded from the grid; true → they are shown alongside
  // the AI picks. Maps to the backend `aiHiddenMode=include` query.
  showAiHidden?: boolean
  // Album-detail grid scope. When set, the gallery grid shows that
  // album's photos (with an access check) instead of the caller's own
  // library — so a shared album also renders for non-owner viewers.
  albumScopeId?: number
}

function buildPhotoFilterQuery(filter: PhotoFilter | boolean | undefined): string {
  // Backwards-compat: legacy callers still pass a boolean `showHidden`.
  const f: PhotoFilter =
    typeof filter === 'boolean'
      ? { hiddenMode: filter ? 'include' : 'exclude' }
      : filter ?? {}

  const params = new URLSearchParams()
  const add = (k: string, v: string | number | boolean) => params.set(k, String(v))

  if (f.hiddenMode) add('hiddenMode', f.hiddenMode)
  if (f.favorite) add('favorite', true)
  if (f.albumHighlight) add('albumHighlight', true)
  if (f.groupHighlight) add('groupHighlight', true)
  if (f.inGroup) add('inGroup', true)
  if (f.othersFavorited) add('othersFavorited', true)
  if (f.othersHidden) add('othersHidden', true)
  if (f.qualityMin !== undefined) add('qualityMin', f.qualityMin)
  if (f.qualityMax !== undefined) add('qualityMax', f.qualityMax)
  if (f.notInAnyAlbum) add('notInAnyAlbum', true)
  if (f.albumIds && f.albumIds.length) add('albumIds', f.albumIds.join(','))
  if (f.albumMode) add('albumMode', f.albumMode)
  if (f.personIds && f.personIds.length) add('personIds', f.personIds.join(','))
  if (f.personMode) add('personMode', f.personMode)
  if (f.mediaTypes && f.mediaTypes.length) add('mediaTypes', f.mediaTypes.join(','))
  if (f.hasGps !== undefined) add('hasGps', f.hasGps)
  if (f.hasFaces !== undefined) add('hasFaces', f.hasFaces)
  if (f.hasAssignedPerson !== undefined) add('hasAssignedPerson', f.hasAssignedPerson)
  if (f.dateFrom) add('dateFrom', f.dateFrom)
  if (f.dateTo) add('dateTo', f.dateTo)
  if (f.importedDaysAgo !== undefined) add('importedDaysAgo', f.importedDaysAgo)
  if (f.sizeMin !== undefined) add('sizeMin', f.sizeMin)
  if (f.sizeMax !== undefined) add('sizeMax', f.sizeMax)
  if (f.ownerIds && f.ownerIds.length) add('ownerIds', f.ownerIds.join(','))
  if (f.showAiHidden) add('showAiHidden', true)

  const s = params.toString()
  return s ? `?${s}` : ''
}

export function listPhotos(filter?: PhotoFilter | boolean) {
  return apiFetch<ListPhotosResponse>(`/photos${buildPhotoFilterQuery(filter)}`)
}

/**
 * Lightweight gallery index – returns just enough per photo to render the
 * grid (id, filename, dates, curation_status, auto_crop). Use this for the
 * initial gallery load, then call `getPhotoDetailsBatch` to hydrate the
 * heavy fields (location, GPS, AI quality, description) on demand.
 */
export function listPhotoIndex(filter?: PhotoFilter | boolean) {
  return apiFetch<ListPhotoIndexResponse>(`/photos/index${buildPhotoFilterQuery(filter)}`)
}

/**
 * Batch fetch full details (heavy fields) for a list of photo IDs.
 *
 * `signal` lets callers (e.g. the hydration loop) abort the request when the
 * user navigates away or starts a new run — without it, hanging requests
 * keep their (potentially multi-MB) response buffers alive in the browser.
 *
 * `timeoutMs` caps how long a single batch can hang. With 100 photos worth
 * of JSONB fields the response can be large, but if the server hasn't
 * answered in 60 s it's almost certainly overloaded — keep retrying past
 * that just piles up dead requests in memory.
 */
export function getPhotoDetailsBatch(ids: number[], signal?: AbortSignal) {
  if (ids.length === 0) {
    return Promise.resolve<PhotoDetailsBatchResponse>({ photos: [] })
  }
  return apiFetch<PhotoDetailsBatchResponse>(`/photos/details?ids=${ids.join(',')}`, {
    signal,
    timeoutMs: 60_000,
  })
}

/**
 * Compute the SHA-256 hash of a file using the Web Crypto API.
 * Returns a lowercase hex string. Requires a secure context (HTTPS or
 * localhost); returns `null` if Web Crypto is unavailable.
 */
export async function computeFileHash(file: File | Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  try {
    const buffer = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const bytes = new Uint8Array(digest)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i]!.toString(16).padStart(2, '0')
    }
    return hex
  } catch {
    return null
  }
}

/**
 * Check whether a photo with the given SHA-256 hash already exists for the
 * current user. Used to skip uploads of duplicate photos, which avoids
 * transferring the file over the network (saves time + mobile data).
 */
export function checkPhotoHash(hash: string) {
  return apiFetch<{ exists: boolean; photoId?: number }>(`/photos/check-hash/${hash}`)
}

export async function uploadPhoto(file: File, signal?: AbortSignal) {
  return apiFetch<Photo>('/photos', {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': file.type,
      'X-File-Name': encodeURIComponent(file.name)
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
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
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

export function updatePhotoDescription(id: number, description: string | null) {
  return apiFetch<{ success: boolean; description: string | null }>(`/photos/${id}/description`, {
    method: 'PATCH',
    body: JSON.stringify({ description })
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
  /** Assigned person's name, resolved server-side (undefined when unassigned). */
  person_name?: string
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
  oldest_photo_at?: string
  newest_photo_at?: string
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

export async function getPersonDetails(id: number) {
  const details = await apiFetch<PersonDetails>(`/persons/${id}`)
  const photoIds = Array.from(new Set(details.faces.map(f => f.photo?.id).filter((pid): pid is number => typeof pid === 'number')))
  if (photoIds.length === 0) return details

  const hydrated = await getPhotoDetailsBatch(photoIds)
  const byId = new Map(hydrated.photos.map(p => [p.id, p]))
  return {
    ...details,
    faces: details.faces.map(face => {
      const fullPhoto = face.photo ? byId.get(face.photo.id) : undefined
      return fullPhoto ? { ...face, photo: { ...face.photo, ...fullPhoto } } : face
    }),
  }
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
  service:
    | 'embedding'
    | 'face_detection'
    | 'face_assignment'
    | 'landmark'        // retired in Epic #383, kept for legacy queue rows
    | 'quality'
    | 'geocoding'
    | 'thumbnail'
    | 'poi_detection'
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

export interface FailedJobGroup {
  /** The shared error message, or "(no message)" when null in the DB. */
  errorMsg: string
  /** Number of failed jobs carrying this exact message. */
  count: number
  /** Up to 10 representative photo ids (most-recently-failed first). */
  samplePhotoIds: number[]
  /** ISO timestamp of the most recent failure in this group. */
  lastFailedAt: string | null
}

/**
 * Failed scan-queue jobs for one service, grouped by error message.
 * `service` is one of the ScanQueueServiceStatus['service'] values.
 */
export function getScanQueueFailures(service: string) {
  return apiFetch<{ groups: FailedJobGroup[] }>(
    `/photos/scan-queue/failures?service=${encodeURIComponent(service)}`,
  )
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

// Targeted POI recovery (#558): re-run poi_detection only for photos that have
// GPS + a finished embedding but no POI matches yet.
export function redetectMissingPois() {
  return apiFetch<{ queued: number }>('/photos/poi-redetect', {
    method: 'POST'
  })
}

// One-shot POI recovery: re-run poi_detection for every GPS photo with a
// finished embedding but no POI match — also catches race victims that
// redetectMissingPois() skips. Heavier (re-scores legitimately empty photos).
export function redetectEmptyPois() {
  return apiFetch<{ queued: number }>('/photos/poi-redetect-empty', {
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

export function recomputeTransformSuggestions(opts: { force?: boolean } = {}) {
  return apiFetch<{ updated: number; failed: number; skipped: number; total: number }>(
    '/photos/recompute-transform-suggestions',
    {
      method: 'POST',
      body: JSON.stringify({ force: opts.force ?? false }),
      // 60 min ceiling. The backend keeps running past a client abort
      // anyway (no AbortSignal plumbed in), and the default skip-logic
      // makes re-runs cheap — but a fresh large library can still
      // legitimately take more than 10 minutes.
      timeoutMs: 60 * 60 * 1000,
    },
  )
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
