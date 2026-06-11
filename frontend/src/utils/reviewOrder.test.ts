import { describe, it, expect } from 'vitest'
import { orderedUnreviewedGroupIds, nextGroupInSequence } from './reviewOrder'
import type { PhotoGroup } from '../api/photos'

function group(id: number, photoIds: number[], reviewed = false): PhotoGroup {
  return {
    id,
    user_id: 1,
    created_at: '2024-01-01T00:00:00Z',
    member_count: photoIds.length,
    photo_ids: photoIds,
    reviewed_at: reviewed ? '2024-01-02T00:00:00Z' : undefined,
  }
}

describe('orderedUnreviewedGroupIds', () => {
  it('orders groups by first member appearance in the grid', () => {
    const groups = [
      group(10, [5, 6]),
      group(20, [1, 2]),
      group(30, [9]),
    ]
    // Grid order: 1, 5, 9 → groups 20, 10, 30
    expect(orderedUnreviewedGroupIds([1, 2, 5, 6, 9], groups)).toEqual([20, 10, 30])
  })

  it('only offers groups whose members are present in the grid', () => {
    const groups = [
      group(10, [5, 6]),
      group(20, [100, 101]), // not in the grid
    ]
    expect(orderedUnreviewedGroupIds([5, 6, 7], groups)).toEqual([10])
  })

  it('drops already-reviewed groups', () => {
    const groups = [
      group(10, [1, 2]),
      group(20, [3, 4], /* reviewed */ true),
    ]
    expect(orderedUnreviewedGroupIds([1, 2, 3, 4], groups)).toEqual([10])
  })

  it('surfaces each group exactly once even if multiple members are in the grid', () => {
    const groups = [group(10, [1, 2, 3])]
    expect(orderedUnreviewedGroupIds([1, 2, 3], groups)).toEqual([10])
  })

  it('returns empty when nothing in the grid belongs to a group', () => {
    expect(orderedUnreviewedGroupIds([1, 2, 3], [group(10, [99])])).toEqual([])
  })
})

describe('nextGroupInSequence', () => {
  const pendingAll = () => true

  it('returns the next pending group after the current one', () => {
    expect(nextGroupInSequence([1, 2, 3], 2, pendingAll)).toBe(3)
  })

  it('skips reviewed groups when picking the next', () => {
    const pending = (id: number) => id !== 3
    expect(nextGroupInSequence([1, 2, 3, 4], 2, pending)).toBe(4)
  })

  it('wraps to the first pending group when none trail the current position', () => {
    // Started in the middle; only group 1 (before current) is still pending.
    const pending = (id: number) => id === 1
    expect(nextGroupInSequence([1, 2, 3], 3, pending)).toBe(1)
  })

  it('returns null when no other group is pending', () => {
    const pending = (id: number) => id === 2
    expect(nextGroupInSequence([1, 2, 3], 2, pending)).toBeNull()
  })

  it('handles a current id that is not in the sequence by wrapping', () => {
    expect(nextGroupInSequence([1, 2, 3], 99, pendingAll)).toBe(1)
  })
})
