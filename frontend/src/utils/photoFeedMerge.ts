import type { FeedAlbumItem, FeedPhotoItem, PhotoFeedCursor } from '../api/photoFeed'

/** Feed ordering is (lastActivityAt DESC, photoId DESC). */
export function isAtOrBeforeFeedCursor(
  item: FeedPhotoItem,
  cursor: PhotoFeedCursor,
): boolean {
  return item.lastActivityAt < cursor.ts
    || (item.lastActivityAt === cursor.ts && item.photoId <= cursor.id)
}

/**
 * Put the freshly fetched first page at the top without replacing cards that
 * are already mounted. Vue can move keyed cards in the DOM while preserving
 * their component state; older pages remain available below the refreshed
 * first page.
 */
export function mergePhotoFeedItems(
  current: FeedPhotoItem[],
  incoming: FeedPhotoItem[],
): FeedPhotoItem[] {
  const currentById = new Map(current.map((item) => [item.photoId, item]))
  const incomingIds = new Set<number>()

  const firstPage = incoming.map((item) => {
    incomingIds.add(item.photoId)
    const existing = currentById.get(item.photoId)
    if (!existing) return item

    // Keep the object identity used by PhotoFeedCard, but refresh all data
    // supplied by the server. hiddenByMe is deliberately client-only.
    const hiddenByMe = existing.hiddenByMe
    Object.assign(existing, item)
    if (hiddenByMe !== undefined) existing.hiddenByMe = hiddenByMe
    return existing
  })

  return [...firstPage, ...current.filter((item) => !incomingIds.has(item.photoId))]
}

/**
 * Add freshly fetched album cards to the loaded ones. A card fetched again
 * (refresh) replaces its older copy, so a re-shared album moves up.
 */
export function mergeFeedAlbums(
  current: FeedAlbumItem[],
  incoming: FeedAlbumItem[],
): FeedAlbumItem[] {
  const byId = new Map(current.map((a) => [a.albumId, a]))
  for (const a of incoming) byId.set(a.albumId, a)
  return [...byId.values()]
}

export type FeedStreamEntry =
  | { kind: 'photo'; key: string; item: FeedPhotoItem }
  | { kind: 'album'; key: string; album: FeedAlbumItem }

/**
 * The one stream the feed renders: photos in server order with the album
 * cards slotted in by `lastActivityAt` (newest first). On a tie the photo
 * stays first. Photo order is never changed — the server's keyset order is
 * the truth for photos.
 */
export function feedStream(
  items: FeedPhotoItem[],
  albums: FeedAlbumItem[],
): FeedStreamEntry[] {
  const cards = [...albums].sort((a, b) =>
    a.lastActivityAt === b.lastActivityAt
      ? b.albumId - a.albumId
      : a.lastActivityAt < b.lastActivityAt ? 1 : -1,
  )
  const out: FeedStreamEntry[] = []
  let c = 0
  for (const item of items) {
    while (c < cards.length && cards[c]!.lastActivityAt > item.lastActivityAt) {
      const album = cards[c++]!
      out.push({ kind: 'album', key: `a${album.albumId}`, album })
    }
    out.push({ kind: 'photo', key: `p${item.photoId}`, item })
  }
  for (; c < cards.length; c++) {
    const album = cards[c]!
    out.push({ kind: 'album', key: `a${album.albumId}`, album })
  }
  return out
}
