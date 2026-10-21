/**
 * The critique of one photo in words (documentation/plans/foto-aesthetik.md,
 * stage 6). Asked for on request, kept on the server until asked again.
 */

import { apiFetch } from './client'

export interface PhotoCritique {
  photo_id: number
  summary: string
  strengths: string[]
  weaknesses: string[]
  model: string
  created_at: string
}

export function getPhotoCritique(photoId: number): Promise<{ critique: PhotoCritique | null }> {
  return apiFetch(`/photos/${photoId}/critique`)
}

/** The kept critique, or a new one; `refresh` always asks the model again. */
export function requestPhotoCritique(photoId: number, refresh = false): Promise<{ critique: PhotoCritique }> {
  return apiFetch(`/photos/${photoId}/critique`, {
    method: 'POST',
    body: JSON.stringify({ refresh }),
  })
}
