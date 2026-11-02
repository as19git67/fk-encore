import { apiFetch } from './client'
import type { OrientationCounterpart } from './photos'

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
  /**
   * Client-only: the viewer toggled "hide" on this card. The server never
   * returns hidden photos, so this starts falsy; hiding keeps the card in
   * place (dimmed) until the feed is reloaded, when it drops out.
   */
  hiddenByMe?: boolean
  /**
   * The best-ranked photo on the other side of the viewer's format group,
   * when this photo is one side of one (documentation/plans/orientierungs-varianten.md).
   * The card shows whichever side fits the screen. Optional: items built on
   * the client (the compare view's confirmation) carry none.
   */
  counterpart?: OrientationCounterpart | null
}

/**
 * An album shared with the viewer, shown once as a card that opens the album
 * instead of every photo in it as a post of its own.
 */
export interface FeedAlbumItem {
  albumId: number
  name: string
  description: string | null
  lastActivityAt: string
  owner: { id: number; name: string | null }
  /** Who shared it with the viewer (the inviter, else the owner). */
  sharedBy: { id: number; name: string | null }
  accessLevel: string
  photoCount: number
  /** Up to four photos: the cover first, then the newest added. */
  previews: { photoId: number; filename: string; width: number | null; height: number | null }[]
}

export interface ListPhotoFeedResponse {
  items: FeedPhotoItem[]
  /**
   * Album cards in the same stretch of the timeline as `items` (newer than the
   * request's cursor, not older than the page's last photo; on the last page
   * everything left). Merged into the stream by `lastActivityAt`.
   */
  albums?: FeedAlbumItem[]
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
