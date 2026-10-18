import { describe, expect, it } from 'vitest'
import { MAX_PINNED_PHOTO_IDS, parsePinnedPhotoIds, pinnedPhotoIdsQuery } from './photoIdsQuery'

describe('pinned photo ids in the gallery URL', () => {
  it('reads the ids in order, without junk or repeats', () => {
    expect(parsePinnedPhotoIds('3,9, 27,9,x,-1,0')).toEqual([3, 9, 27])
    expect(parsePinnedPhotoIds(['5,6'])).toEqual([5, 6])
  })

  it('is null without any id', () => {
    expect(parsePinnedPhotoIds(undefined)).toBeNull()
    expect(parsePinnedPhotoIds('')).toBeNull()
    expect(parsePinnedPhotoIds('a,b')).toBeNull()
  })

  it('caps a very long list and writes the same shape back', () => {
    const many = Array.from({ length: MAX_PINNED_PHOTO_IDS + 5 }, (_, i) => i + 1)
    expect(parsePinnedPhotoIds(many.join(','))).toHaveLength(MAX_PINNED_PHOTO_IDS)
    expect(pinnedPhotoIdsQuery([3, 9, 27])).toBe('3,9,27')
  })
})
