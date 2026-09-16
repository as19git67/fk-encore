import { describe, it, expect, vi } from 'vitest'
import {
  rangeBounds,
  toggleOne,
  applyRange,
  collectRangeIds,
  RANGE_ID_FETCH_THRESHOLD,
} from './rangeSelection'

describe('rangeBounds', () => {
  it('orders the bounds regardless of click direction', () => {
    expect(rangeBounds(3, 7)).toEqual({ start: 3, end: 7 })
    expect(rangeBounds(7, 3)).toEqual({ start: 3, end: 7 })
    expect(rangeBounds(4, 4)).toEqual({ start: 4, end: 4 })
  })
})

describe('toggleOne', () => {
  it('selects a photo that was not selected and reports the direction', () => {
    const { selected, adding } = toggleOne(new Set([1]), 2)
    expect([...selected]).toEqual([1, 2])
    expect(adding).toBe(true)
  })

  it('deselects a selected photo and reports the direction', () => {
    const { selected, adding } = toggleOne(new Set([1, 2]), 2)
    expect([...selected]).toEqual([1])
    expect(adding).toBe(false)
  })

  it('never mutates the Set it was given', () => {
    const before = new Set([1])
    toggleOne(before, 2)
    expect([...before]).toEqual([1])
  })
})

describe('applyRange', () => {
  it('adds the whole range when the anchor click was selecting', () => {
    expect([...applyRange(new Set([1]), [2, 3, 4], true)]).toEqual([1, 2, 3, 4])
  })

  it('removes the whole range when the anchor click was deselecting', () => {
    expect([...applyRange(new Set([1, 2, 3, 4]), [2, 3], false)]).toEqual([1, 4])
  })

  it('leaves photos outside the range alone', () => {
    expect([...applyRange(new Set([9]), [2], true)]).toEqual([9, 2])
    expect([...applyRange(new Set([9]), [2], false)]).toEqual([9])
  })
})

describe('collectRangeIds', () => {
  function sourceOf(ids: (number | null)[]) {
    return {
      loadEntryAt: vi.fn(async (i: number) => (ids[i] === null ? null : { id: ids[i] as number })),
      fetchAllIds: vi.fn(async () => ids.filter((x): x is number => x !== null)),
    }
  }

  it('reads a short range through the grid source', async () => {
    const source = sourceOf([10, 11, 12, 13, 14])
    expect(await collectRangeIds(1, 3, source)).toEqual([11, 12, 13])
    expect(source.fetchAllIds).not.toHaveBeenCalled()
  })

  it('includes both ends of the range', async () => {
    const source = sourceOf([10, 11, 12])
    expect(await collectRangeIds(0, 2, source)).toEqual([10, 11, 12])
  })

  it('handles a range of one', async () => {
    const source = sourceOf([10, 11, 12])
    expect(await collectRangeIds(1, 1, source)).toEqual([11])
  })

  it('skips positions the source cannot resolve', async () => {
    const source = sourceOf([10, null, 12])
    expect(await collectRangeIds(0, 2, source)).toEqual([10, 12])
  })

  it('returns nothing for an inverted range', async () => {
    const source = sourceOf([10, 11])
    expect(await collectRangeIds(1, 0, source)).toEqual([])
    expect(source.loadEntryAt).not.toHaveBeenCalled()
  })

  it('switches to the id list for a long range instead of paging', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1)
    const source = sourceOf(ids)
    const picked = await collectRangeIds(10, 10 + RANGE_ID_FETCH_THRESHOLD, source)
    expect(source.loadEntryAt).not.toHaveBeenCalled()
    expect(source.fetchAllIds).toHaveBeenCalledOnce()
    expect(picked[0]).toBe(11)
    expect(picked).toHaveLength(RANGE_ID_FETCH_THRESHOLD + 1)
  })
})
