import { apiFetch } from './client'

export type FeedItemKind =
  | 'photo_added'
  | 'album_shared'
  | 'photo_favorited'
  | 'photo_commented'
  | 'album_left'

export interface FeedActor {
  id: number | null
  name: string | null
}

export interface FeedAlbumRef {
  id: number
  name: string
}

export interface FeedPhotoRef {
  id: number
  filename: string
  description: string | null
}

export interface FeedItem {
  id: number
  kind: FeedItemKind
  actor: FeedActor
  album: FeedAlbumRef | null
  photo: FeedPhotoRef | null
  payload: Record<string, unknown>
  seen_at: string | null
  created_at: string
}

export interface ListFeedResponse {
  items: FeedItem[]
  nextCursor: number | null
  unreadCount: number
}

export function listFeed(params: { cursor?: number; limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (params.cursor !== undefined) qs.set('cursor', String(params.cursor))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch<ListFeedResponse>(`/feed${suffix}`)
}

export function getFeedUnreadCount() {
  return apiFetch<{ count: number }>('/feed/unread-count')
}

export function markFeedSeen(upToId: number) {
  return apiFetch<{ updated: number }>('/feed/mark-seen', {
    method: 'POST',
    body: JSON.stringify({ upToId }),
  })
}
