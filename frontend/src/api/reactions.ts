import { apiFetch } from './client'

export type CommentAuthorKind = 'user' | 'guest'

export interface PhotoComment {
  id: number
  photoId: number
  /** Album the comment was written in. Comments are album-scoped. */
  albumId: number
  author: {
    id: number
    name: string | null
    /**
     * Distinguishes registered users from share-link guests so the UI
     * can apply identity comparisons in the right namespace (a user
     * id and a guest id can collide). Optional for backwards
     * compatibility with payloads predating the guest feature.
     */
    kind?: CommentAuthorKind
  }
  body: string
  createdAt: string
  editedAt: string | null
}

// ---------- Comments ----------

export function listComments(photoId: number, albumId: number) {
  return apiFetch<{ comments: PhotoComment[] }>(
    `/photos/${photoId}/comments?albumId=${albumId}`,
  )
}

export function createComment(photoId: number, body: string, albumId: number) {
  return apiFetch<PhotoComment>(`/photos/${photoId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, albumId }),
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
