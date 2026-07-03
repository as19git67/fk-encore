import { describe, expect, it } from 'vitest'
import type { FeedPhotoItem } from '../api/photoFeed'
import { isAtOrBeforeFeedCursor, mergePhotoFeedItems } from './photoFeedMerge'

function item(photoId: number, overrides: Partial<FeedPhotoItem> = {}): FeedPhotoItem {
  return {
    photoId,
    filename: `${photoId}.jpg`,
    width: 100,
    height: 100,
    description: null,
    takenAt: null,
    lastActivityAt: `2026-07-0${photoId}T10:00:00Z`,
    album: null,
    owner: { id: 1, name: 'Anton' },
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    latestComment: null,
    ...overrides,
  }
}

describe('mergePhotoFeedItems', () => {
  it('inserts new first-page items and keeps older loaded pages', () => {
    const current = [item(3), item(2), item(1)]

    const merged = mergePhotoFeedItems(current, [item(4), item(3)])

    expect(merged.map((entry) => entry.photoId)).toEqual([4, 3, 2, 1])
  })

  it('moves changed cards without replacing their objects', () => {
    const existing = item(2, { commentCount: 0, hiddenByMe: false })
    const current = [item(3), existing, item(1)]

    const merged = mergePhotoFeedItems(current, [
      item(2, { commentCount: 1, latestComment: { author: 'Ada', excerpt: 'Neu' } }),
      item(3),
    ])

    expect(merged[0]).toBe(existing)
    expect(existing.commentCount).toBe(1)
    expect(existing.hiddenByMe).toBe(false)
    expect(merged.map((entry) => entry.photoId)).toEqual([2, 3, 1])
  })

  it('does not duplicate cards returned by the refreshed page', () => {
    const merged = mergePhotoFeedItems([item(3), item(2), item(1)], [item(3), item(2)])

    expect(merged.map((entry) => entry.photoId)).toEqual([3, 2, 1])
  })
})

describe('isAtOrBeforeFeedCursor', () => {
  const cursor = { ts: '2026-07-03T10:00:00Z', id: 10 }

  it('uses the same timestamp and id ordering as feed pagination', () => {
    expect(isAtOrBeforeFeedCursor(item(11, { lastActivityAt: cursor.ts }), cursor)).toBe(false)
    expect(isAtOrBeforeFeedCursor(item(10, { lastActivityAt: cursor.ts }), cursor)).toBe(true)
    expect(isAtOrBeforeFeedCursor(item(12, { lastActivityAt: '2026-07-03T09:59:59Z' }), cursor)).toBe(true)
  })
})
