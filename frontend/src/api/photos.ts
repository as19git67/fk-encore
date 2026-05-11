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
  // AI auto-pick visibility (Track I). false (default) → AI-hidden
  // photos are excluded from the grid; true → they are shown alongside
  // the AI picks. Maps to the backend `aiHiddenMode=include` query.
  showAiHidden?: boolean
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
  return apiFetch<{ exists: boolean }>(`/photos/check-hash/${hash}`)
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

export interface ScanQueueServiceProgress {
  scanned: number
  imported: number
  skipped: number
  errors: number
}

export interface ScanQueueServiceStatus {
  service:
    | 'embedding'
    | 'face_detection'
    | 'face_assignment'
    | 'landmark'
    | 'quality'
    | 'geocoding'
    | 'library_scan'
  pending: number
  processing: number
  failed: number
  done: number
  /** Live counters for an in-flight library_scan job (only set while processing). */
  progress?: ScanQueueServiceProgress
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

export interface BatchDeleteSkippedPhoto {
  id: number
  reason: 'not_owner' | 'readonly'
}

export interface BatchDeleteResult {
  deleted: number[]
  skipped: BatchDeleteSkippedPhoto[]
}

export function batchDeletePhotos(photoIds: number[]) {
  return apiFetch<BatchDeleteResult>('/photos/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ photoIds })
  })
}

// ---------- Destructive: Purge ----------

export interface PurgeFilesResult {
  deleted: boolean
  uploadsRemoved: number
  thumbnailsRemoved: number
  failures: number
}

export interface PurgeEmbeddingServiceResult {
  called: boolean
  ok: boolean
  deleted: number
  error: string
}

export interface PurgeResult {
  success: boolean
  dbCounts: Record<string, number>
  files: PurgeFilesResult
  embeddingService: PurgeEmbeddingServiceResult
}

/**
 * Purge every photo-related row in the database (photos, albums, faces,
 * persons, scan queue, …). When `deleteFiles` is true, the stored originals
 * and all cached thumbnails are removed from disk as well. Requires the
 * `photos.purge` permission.
 */
export function purgePhotos(deleteFiles: boolean) {
  return apiFetch<PurgeResult>('/photos/purge', {
    method: 'POST',
    body: JSON.stringify({ deleteFiles })
  })
}

// ---------- Albums ----------

export type AlbumAccessLevel = 'read' | 'write' | 'write_share'

export interface Album {
  id: number
  user_id: number
  name: string
  description?: string
  event_name?: string
  cover_photo_id?: number
  cover_filename?: string
  display_mode: 'grid' | 'map'
  newest_photo_at?: string
  oldest_photo_at?: string
  photo_count: number
  is_shared: boolean
  created_at: string
  updated_at: string
  /** Access level of the current caller relative to this album. */
  my_access_level?: 'owner' | AlbumAccessLevel
}

export type ActiveView = 'all' | 'favorites' | 'consensus' | 'others-favorites' | 'custom'

export interface ViewConfig {
  hideFilter: 'none' | 'mine' | 'consensus'
  hideConsensusMin?: number
  favFilter: 'all' | 'mine' | 'any' | 'consensus' | 'others-not-mine'
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
  cover_photo_id?: number | null
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

export function createAlbum(name: string, description?: string, displayMode?: 'grid' | 'map') {
  return apiFetch<Album>('/albums', {
    method: 'POST',
    body: JSON.stringify({ name, description, displayMode })
  })
}

export function updateAlbum(id: number, patch: { name?: string; description?: string; coverPhotoId?: number | null; displayMode?: 'grid' | 'map' }) {
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

export interface PhotoLocationAlbum { id: number; name: string }
export interface PhotoLocationPerson { id: number; name: string }
export interface PhotoLocationsResponse {
  photoId: number
  albums: PhotoLocationAlbum[]
  persons: PhotoLocationPerson[]
  hasGps: boolean
}

/** Jump destinations for a single photo (albums / persons / map). */
export function getPhotoLocations(id: number) {
  return apiFetch<PhotoLocationsResponse>(`/photos/${id}/locations`)
}

export function batchUpdateAlbumPhotos(albumIds: number[], photoIds: number[], action: 'add' | 'remove') {
  return apiFetch<{ success: boolean }>('/albums/photos/batch', {
    method: 'POST',
    body: JSON.stringify({ albumIds, photoIds, action })
  })
}

export function shareAlbum(albumId: number, userId: number, accessLevel: AlbumAccessLevel) {
  return apiFetch<{ success: boolean }>('/albums/share', {
    method: 'POST',
    body: JSON.stringify({ albumId, userId, accessLevel })
  })
}

export interface AlbumShareWithUser {
  album_id: number
  user_id: number
  access_level: AlbumAccessLevel
  /** Creator of the share. NULL for legacy rows (treated as owner-created). */
  invited_by_user_id: number | null
  user_name: string
  user_email: string
}

export interface AlbumPublicLink {
  id: number
  album_id: number
  token: string
  created_by_user_id: number
  created_at: string
  expires_at?: string
}

export type PublicLinkExpiry = '7d' | '30d' | '90d' | undefined

export function getAlbumShares(albumId: number) {
  return apiFetch<{ shares: AlbumShareWithUser[]; publicLink?: AlbumPublicLink }>(`/albums/${albumId}/shares`)
}

export function removeAlbumShare(albumId: number, userId: number) {
  return apiFetch<{ success: boolean }>(`/albums/${albumId}/shares/${userId}`, {
    method: 'DELETE'
  })
}

export function leaveAlbum(albumId: number) {
  return apiFetch<{ success: boolean }>(`/albums/${albumId}/leave`, {
    method: 'DELETE'
  })
}

export function createAlbumPublicLink(albumId: number, expiresIn?: PublicLinkExpiry) {
  return apiFetch<AlbumPublicLink>(`/albums/${albumId}/public-link`, {
    method: 'POST',
    body: JSON.stringify(expiresIn ? { expiresIn } : {})
  })
}

export function deleteAlbumPublicLink(albumId: number) {
  return apiFetch<{ success: boolean }>(`/albums/${albumId}/public-link`, {
    method: 'DELETE'
  })
}

export interface PublicAlbumPhoto {
  id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  taken_at?: string
  created_at: string
  latitude?: number
  longitude?: number
  location_name?: string
  location_city?: string
  location_country?: string
  ai_quality_score?: number
  auto_crop?: { x: number; y: number }
  description?: string
  /** Photo is a cover of a similarity group curated by the album owner. */
  is_highlight?: boolean
  /** Album owner has hidden this photo in their curation. */
  is_hidden?: boolean
}

export interface PublicAlbumResponse {
  id: number
  name: string
  description?: string
  display_mode: 'grid' | 'map'
  cover_filename?: string
  newest_photo_at?: string
  oldest_photo_at?: string
  photo_count: number
  photos: PublicAlbumPhoto[]
}

export function getPublicAlbum(token: string) {
  return apiFetch<PublicAlbumResponse>(`/albums/public/${token}`)
}

export function batchFavoritePhotos(albumId: number, photoIds: number[]) {
  return apiFetch<{ success: boolean; favorited: number }>(`/albums/${albumId}/batch-favorite`, {
    method: 'POST',
    body: JSON.stringify({ photoIds })
  })
}

export function updateAlbumUserSettings(albumId: number, settings: Partial<AlbumUserSettings>) {
  const { album_id, user_id, ...rest } = settings as any
  const req: Record<string, unknown> = {}
  if (rest.hide_mode) req.hideMode = rest.hide_mode
  if (rest.active_view) req.activeView = rest.active_view
  if (rest.view_config !== undefined) req.viewConfig = rest.view_config
  if (rest.cover_photo_id !== undefined) req.coverPhotoId = rest.cover_photo_id

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
  // AI auto-pick (Track I). Absent until the group has been scored.
  ai_picked_photo_ids?: number[]
  ai_picked_confidence?: 'high' | 'medium' | 'low'
  ai_picked_at?: string
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

export function reviewPhotoGroup(id: number, photoIds?: number[]) {
  return apiFetch<{ success: boolean }>(`/photos/groups/${id}/review`, {
    method: 'POST',
    body: photoIds ? JSON.stringify({ photoIds }) : undefined,
  })
}

// ---------- AI Auto-Pick (Track I) ----------

export function recomputeAiPicks() {
  return apiFetch<{ groups_scored: number; groups_skipped: number }>(
    '/photos/groups/recompute-ai-picks',
    { method: 'POST' },
  )
}

export function acceptAiPick(id: number) {
  return apiFetch<{ success: boolean; hidden_count: number }>(
    `/photos/groups/${id}/accept-ai-pick`,
    { method: 'POST' },
  )
}

export function bulkAcceptHighConfidenceAiPicks() {
  return apiFetch<{ groups_accepted: number; hidden_count: number }>(
    '/photos/groups/bulk-accept-ai-picks',
    { method: 'POST' },
  )
}

export interface AiPickCalibrationEntry {
  group_id: number
  group_confidence: 'high' | 'medium' | 'low' | null
  group_ai_picked_photo_ids: number[]
  reviewed_at: string
  photos: Array<{
    photo_id: number
    user_kept: boolean
    ai_picked: boolean
    has_face: boolean
    signals: Record<string, number>
  }>
}

export function getAiPickCalibration() {
  return apiFetch<{ entries: AiPickCalibrationEntry[] }>(
    '/photos/groups/ai-pick-calibration',
  )
}

export function backfillPhotoDimensions() {
  return apiFetch<{ scanned: number; updated: number; failed: number }>(
    '/photos/backfill-dimensions',
    { method: 'POST' },
  )
}

export interface AiPickWeights {
  face: number[]
  non_face: number[]
}

export interface AiPickWeightsCalibrationResult {
  weights: AiPickWeights
  metadata: {
    pair_count_face: number
    pair_count_non_face: number
    pair_count_skipped_mixed: number
    top1_accuracy_face: number
    top1_accuracy_non_face: number
    top1_accuracy_face_baseline: number
    top1_accuracy_non_face_baseline: number
  }
}

export function calibrateAiPickWeights() {
  return apiFetch<AiPickWeightsCalibrationResult>(
    '/photos/groups/calibrate-ai-pick-weights',
    { method: 'POST' },
  )
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
  return apiFetch<{ photos: Photo[] }>('/photos/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit, threshold })
  })
}

/** Structured breakdown of a natural-language query returned by the backend. */
export interface ParsedQuery {
  semanticQuery: string
  fromDate?: string
  toDate?: string
  location?: string
}

export interface NaturalSearchResult extends PhotoSearchResult {
  location_city?: string
  location_country?: string
}

/**
 * Semantic + structural photo search.
 * Understands queries like "Kirchen in München von 2004 bis 2017":
 * the backend parses location and date filters out and combines them with
 * the CLIP semantic similarity search.
 */
export function searchPhotosNatural(query: string, limit: number = 500, threshold: number = 0.18) {
  return apiFetch<{ results: NaturalSearchResult[]; parsed: ParsedQuery }>('/photos/search/natural', {
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

export interface ServerPressureStatus {
  underPressure: boolean
  eventLoopLagMs: number
}

export function getExternalServiceHealth(signal?: AbortSignal) {
  return apiFetch<{ services: ExternalServiceHealth[]; serverPressure: ServerPressureStatus }>(
    '/photos/service-health',
    { signal, timeoutMs: 10_000 }
  )
}

