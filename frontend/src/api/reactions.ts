import { apiFetch } from './client'

export interface PhotoLikeSummary {
  count: number
  likedByMe: boolean
}

export interface PhotoLiker {
  userId: number
  name: string | null
  createdAt: string
}

export interface PhotoComment {
  id: number
  photoId: number
  author: {
    id: number
    name: string | null
  }
  body: string
  createdAt: string
  editedAt: string | null
}

// ---------- Likes ----------

export function likePhoto(photoId: number) {
  return apiFetch<PhotoLikeSummary>(`/photos/${photoId}/like`, {
    method: 'POST',
  })
}

export function unlikePhoto(photoId: number) {
  return apiFetch<PhotoLikeSummary>(`/photos/${photoId}/like`, {
    method: 'DELETE',
  })
}

export function getLikeSummary(photoId: number) {
  return apiFetch<PhotoLikeSummary>(`/photos/${photoId}/likes/summary`)
}

export function listLikers(photoId: number) {
  return apiFetch<{ likers: PhotoLiker[] }>(`/photos/${photoId}/likes`)
}

// ---------- Comments ----------

export function listComments(photoId: number) {
  return apiFetch<{ comments: PhotoComment[] }>(`/photos/${photoId}/comments`)
}

export function createComment(photoId: number, body: string) {
  return apiFetch<PhotoComment>(`/photos/${photoId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

export function updateComment(commentId: number, body: string) {
  return apiFetch<PhotoComment>(`/photos/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
}

export function deleteComment(commentId: number) {
  return apiFetch<{ success: boolean }>(`/photos/comments/${commentId}`, {
    method: 'DELETE',
  })
}
