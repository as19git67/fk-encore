// API client for the photo-transforms endpoints (Phase 4a backend,
// consumed by the editor in Phase 5).
//
// Five endpoints:
//   GET    /photos/:id/transforms              → bundle
//   PUT    /photos/:id/transforms              → upsert "user" recipe
//   DELETE /photos/:id/transforms              → idempotent delete
//   POST   /photos/:id/transforms/from-suggestion  → materialize AI
//   POST   /photos/:id/transforms/adopt        → copy another user's recipe

import { apiFetch } from './client'

export type PhotoTransformAspectRatio =
  | '1:1'
  | '4:5'
  | '5:4'
  | '3:4'
  | '4:3'
  | '16:9'
  | '9:16'

export interface PhotoTransformCrop {
  x: number
  y: number
  w: number
  h: number
}

export type PhotoTransformSource = 'user' | 'ai' | 'adopted'

export interface PhotoTransformRow {
  id: number
  photo_id: number
  user_id: number
  source: PhotoTransformSource
  adopted_from: number | null
  crop: PhotoTransformCrop | null
  rotation: number
  exposure: number
  contrast: number
  gamma: number
  white_point: number | null
  black_point: number | null
  applied_at: string | null
  created_at: string
  updated_at: string
}

export interface PhotoTransformOther extends PhotoTransformRow {
  user: { id: number; name: string }
}

export interface PhotoTransformSuggestionsPayload {
  crops: Partial<Record<PhotoTransformAspectRatio, PhotoTransformCrop>>
  exposure: number
  contrast: number
  gamma: number
  white_point?: number
  black_point?: number
}

export interface PhotoTransformsBundle {
  mine: PhotoTransformRow | null
  others: PhotoTransformOther[]
  suggestion: PhotoTransformSuggestionsPayload | null
  model_version: string | null
}

export interface UpsertTransformRequest {
  crop?: PhotoTransformCrop | null
  rotation?: number
  exposure?: number
  contrast?: number
  gamma?: number
  white_point?: number | null
  black_point?: number | null
}

export function getPhotoTransforms(photoId: number) {
  return apiFetch<PhotoTransformsBundle>(`/photos/${photoId}/transforms`)
}

export function upsertPhotoTransform(photoId: number, body: UpsertTransformRequest) {
  return apiFetch<PhotoTransformRow>(`/photos/${photoId}/transforms`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deletePhotoTransform(photoId: number) {
  return apiFetch<{ deleted: boolean }>(`/photos/${photoId}/transforms`, {
    method: 'DELETE',
  })
}

export function materializePhotoTransform(
  photoId: number,
  ratio: PhotoTransformAspectRatio,
) {
  return apiFetch<PhotoTransformRow>(
    `/photos/${photoId}/transforms/from-suggestion`,
    {
      method: 'POST',
      body: JSON.stringify({ ratio }),
    },
  )
}

export function adoptPhotoTransform(photoId: number, fromTransformId: number) {
  return apiFetch<PhotoTransformRow>(`/photos/${photoId}/transforms/adopt`, {
    method: 'POST',
    body: JSON.stringify({ from_transform_id: fromTransformId }),
  })
}
