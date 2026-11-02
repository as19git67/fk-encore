import { describe, expect, it } from 'vitest'
import type { FeedAlbumItem, FeedPhotoItem } from '../api/photoFeed'
import { feedStream, isAtOrBeforeFeedCursor, mergeFeedAlbums, mergePhotoFeedItems } from './photoFeedMerge'

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
    owner: { id: 1, name: 'Paul' },
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

function card(albumId: number, lastActivityAt: string, name = `Album ${albumId}`): FeedAlbumItem {
  return {
    albumId,
    name,
    description: null,
    lastActivityAt,
    owner: { id: 1, name: 'Paul' },
    sharedBy: { id: 1, name: 'Paul' },
    accessLevel: 'read',
    photoCount: 3,
    previews: [],
  }
}

describe('feedStream', () => {
  it('slots album cards between photos by lastActivityAt', () => {
    const stream = feedStream(
      [item(3), item(1)],
      [card(10, '2026-07-02T10:00:00Z'), card(11, '2026-07-09T10:00:00Z'), card(12, '2026-06-01T10:00:00Z')],
    )
    expect(stream.map((e) => e.key)).toEqual(['a11', 'p3', 'a10', 'p1', 'a12'])
  })

  it('keeps the photo first on a tie', () => {
    const stream = feedStream([item(3)], [card(10, '2026-07-03T10:00:00Z')])
    expect(stream.map((e) => e.key)).toEqual(['p3', 'a10'])
  })

  it('shows cards alone when there are no photos', () => {
    expect(feedStream([], [card(10, '2026-07-03T10:00:00Z')]).map((e) => e.key)).toEqual(['a10'])
  })
})

describe('mergeFeedAlbums', () => {
  it('replaces a card fetched again and keeps the rest', () => {
    const merged = mergeFeedAlbums(
      [card(10, '2026-07-01T10:00:00Z'), card(11, '2026-07-02T10:00:00Z')],
      [card(10, '2026-07-05T10:00:00Z', 'neu')],
    )
    expect(merged.map((a) => [a.albumId, a.name])).toEqual([[10, 'neu'], [11, 'Album 11']])
  })
})
