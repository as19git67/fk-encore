import { API_BASE_URL, apiFetch } from './client'

export type RecapKind =
  | 'on_this_day'
  | 'trip'
  | 'person'
  | 'place'
  | 'theme'
  | 'recent_highlights'
  | 'scene_then_now'

export interface RecapSummary {
  id: number
  kind: RecapKind
  title: string
  subtitle: string | null
  cover_photo_id: number | null
  period_start: string | null
  period_end: string | null
  photo_count: number
  created_at: string
  dismissed_at: string | null
  seen_at: string | null
}

export interface RecapDetails extends RecapSummary {
  seed: Record<string, unknown>
  photo_ids: number[]
}

export interface ListRecapsResponse {
  recaps: RecapSummary[]
}

export type RecapMood = 'upbeat' | 'warm' | 'nostalgic' | 'calm'

/** Self-hosted background track, served from the recap-music folder. */
export interface MusicTrack {
  id: string
  mood: RecapMood
  title: string
  /** API path without host — resolve via getRecapMusicUrl(). */
  url: string
}

export interface GetRecapResponse {
  recap: RecapDetails
  /** Suggested background track; absent when the music folder is empty. */
  music?: MusicTrack
}

export function getRecapMusicUrl(track: MusicTrack): string {
  return `${API_BASE_URL}${track.url}`
}

/** All available background tracks, used to cycle music in the player. */
export function listRecapMusic() {
  return apiFetch<{ tracks: MusicTrack[] }>('/recaps-music')
}

export function listRecaps() {
  return apiFetch<ListRecapsResponse>('/recaps')
}

export function getRecap(id: number) {
  return apiFetch<GetRecapResponse>(`/recaps/${id}`)
}

export function dismissRecap(id: number) {
  return apiFetch<{ dismissed: boolean }>(`/recaps/${id}/dismiss`, {
    method: 'POST',
  })
}

export function markRecapSeen(id: number) {
  return apiFetch<{ seen: boolean }>(`/recaps/${id}/seen`, {
    method: 'POST',
  })
}

export function rebuildRecaps() {
  return apiFetch<{ on_this_day: number; trip: number }>(`/recaps/rebuild`, {
    method: 'POST',
  })
}

// ---------- Video export ----------

export interface RecapExportStatus {
  status: 'none' | 'running' | 'done' | 'failed'
  /** 0..1 */
  progress: number
  error?: string
  /** Relative download path once the MP4 is ready. */
  download_url?: string
}

export function startRecapExport(id: number) {
  return apiFetch<RecapExportStatus>(`/recaps/${id}/export`, { method: 'POST' })
}

export function getRecapExportStatus(id: number) {
  return apiFetch<RecapExportStatus>(`/recaps/${id}/export/status`)
}

export function getRecapExportDownloadUrl(status: RecapExportStatus): string | null {
  return status.download_url ? `${API_BASE_URL}${status.download_url}` : null
}
