import { apiFetch } from './client'

export interface PhotoFeedCursor {
  ts: string
  id: number
}

export interface FeedPhotoItem {
  photoId: number
  filename: string
  width: number | null
  height: number | null
  description: string | null
  takenAt: string | null
  lastActivityAt: string
  /** A representative album the viewer shares with the photo. */
  album: { id: number; name: string } | null
  owner: { id: number | null; name: string | null }
  /** Global favorite count (likes == favorites). */
  likeCount: number
  likedByMe: boolean
  /** Comments visible to the viewer. */
  commentCount: number
  latestComment: { author: string | null; excerpt: string } | null
}

export interface ListPhotoFeedResponse {
  items: FeedPhotoItem[]
  nextCursor: PhotoFeedCursor | null
}

/**
 * Instagram-style content feed: a strictly chronological photo stream,
 * keyset-paginated. Pass `cursorTs`/`cursorId` from the previous response's
 * `nextCursor` to load the next page.
 */
export function listPhotoFeed(
  params: { cursorTs?: string; cursorId?: number; limit?: number } = {},
) {
  const qs = new URLSearchParams()
  if (params.cursorTs !== undefined) qs.set('cursorTs', params.cursorTs)
  if (params.cursorId !== undefined) qs.set('cursorId', String(params.cursorId))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch<ListPhotoFeedResponse>(`/feed/photos${suffix}`)
}
