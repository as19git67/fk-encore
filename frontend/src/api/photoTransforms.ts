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

/**
 * One-shot list of photo IDs the caller has a transform on. Used by
 * the gallery / album grids to decide per tile whether to render the
 * bare original thumbnail or the user-recipe rendered URL — avoids
 * an N-fan-out of per-tile transform lookups.
 */
export function getMyTransformedPhotoIds() {
  return apiFetch<{ photo_ids: number[] }>('/photos/transforms/mine')
}

export function adoptPhotoTransform(photoId: number, fromTransformId: number) {
  return apiFetch<PhotoTransformRow>(`/photos/${photoId}/transforms/adopt`, {
    method: 'POST',
    body: JSON.stringify({ from_transform_id: fromTransformId }),
  })
}

export interface AutoLevelsResponse {
  exposure: number
  contrast: number
  gamma: number
}

/**
 * Compute an auto-levels recipe for a photo (and optional crop). Does NOT
 * persist — the caller applies the returned values to the editor recipe
 * and saves explicitly. When a crop is given the stats are computed over
 * just the cropped region so the auto-levels match what the user will
 * actually see.
 */
export function computePhotoAutoLevels(
  photoId: number,
  crop?: PhotoTransformCrop | null,
) {
  return apiFetch<AutoLevelsResponse>(
    `/photos/${photoId}/transforms/auto-levels`,
    {
      method: 'POST',
      body: JSON.stringify({ crop: crop ?? null }),
    },
  )
}

// In production both the frontend and the Encore-served API live on
// the same origin; in dev the SPA proxies /api/* to the Encore
// process, so any URL we hand to <img>/<a> needs the /api prefix.
function urlPrefix(): string {
  return import.meta.env.PROD ? '' : '/api'
}

/** Build the render URL for a server-rendered variant. */
export function getRenderedPhotoUrl(
  photoId: number,
  opts:
    | { variant: 'suggested'; ratio: PhotoTransformAspectRatio; width?: number }
    | { variant: 'user'; userId: number; width?: number },
): string {
  const params = new URLSearchParams({ v: opts.variant })
  if (opts.variant === 'suggested') params.set('ratio', opts.ratio)
  if (opts.variant === 'user') params.set('user', String(opts.userId))
  if (opts.width) params.set('w', String(opts.width))
  return `${urlPrefix()}/photos/${photoId}/render?${params.toString()}`
}

/** Build the full-resolution export URL. */
export function getExportedPhotoUrl(
  photoId: number,
  opts:
    | { variant: 'suggested'; ratio: PhotoTransformAspectRatio }
    | { variant: 'user'; userId: number },
): string {
  const params = new URLSearchParams({ v: opts.variant })
  if (opts.variant === 'suggested') params.set('ratio', opts.ratio)
  if (opts.variant === 'user') params.set('user', String(opts.userId))
  return `${urlPrefix()}/photos/${photoId}/export?${params.toString()}`
}
