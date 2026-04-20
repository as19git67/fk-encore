import { apiFetch } from './client'

export type RecapKind =
  | 'on_this_day'
  | 'trip'
  | 'person'
  | 'place'
  | 'theme'
  | 'recent_highlights'

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
}

export interface RecapDetails extends RecapSummary {
  seed: Record<string, unknown>
  photo_ids: number[]
}

export interface ListRecapsResponse {
  recaps: RecapSummary[]
}

export interface GetRecapResponse {
  recap: RecapDetails
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

export function rebuildRecaps() {
  return apiFetch<{ on_this_day: number; trip: number }>(`/recaps/rebuild`, {
    method: 'POST',
  })
}
