import { apiFetch } from './client'
import type { PhotoComment } from './reactions'

const COOKIE: RequestInit = { credentials: 'include' }

export function listGuestComments(token: string, photoId: number) {
  return apiFetch<{ comments: PhotoComment[] }>(
    `/share/${encodeURIComponent(token)}/photos/${photoId}/comments`,
    COOKIE,
  )
}

export function createGuestComment(token: string, photoId: number, body: string) {
  return apiFetch<PhotoComment>(
    `/share/${encodeURIComponent(token)}/photos/${photoId}/comments`,
    {
      ...COOKIE,
      method: 'POST',
      body: JSON.stringify({ body }),
    },
  )
}

export function updateGuestComment(token: string, commentId: number, body: string) {
  return apiFetch<PhotoComment>(
    `/share/${encodeURIComponent(token)}/comments/${commentId}`,
    {
      ...COOKIE,
      method: 'PATCH',
      body: JSON.stringify({ body }),
    },
  )
}

export function deleteGuestComment(token: string, commentId: number) {
  return apiFetch<{ success: boolean }>(
    `/share/${encodeURIComponent(token)}/comments/${commentId}`,
    { ...COOKIE, method: 'DELETE' },
  )
}
