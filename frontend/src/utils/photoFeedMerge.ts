import type { FeedPhotoItem, PhotoFeedCursor } from '../api/photoFeed'

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
