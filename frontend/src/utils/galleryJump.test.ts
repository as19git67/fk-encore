import { describe, it, expect } from 'vitest'
import { newestIndex, oldestIndex, jumpTargetIndex } from './galleryJump'

describe('galleryJump', () => {
  it('newestIndex: end for ascending, start for descending', () => {
    expect(newestIndex(10, 'asc')).toBe(9)
    expect(newestIndex(10, 'desc')).toBe(0)
  })

  it('oldestIndex: start for ascending, end for descending', () => {
    expect(oldestIndex(10, 'asc')).toBe(0)
    expect(oldestIndex(10, 'desc')).toBe(9)
  })

  it('handles empty / single item lists safely', () => {
    expect(newestIndex(0, 'asc')).toBe(0)
    expect(oldestIndex(0, 'desc')).toBe(0)
    expect(newestIndex(1, 'asc')).toBe(0)
    expect(newestIndex(1, 'desc')).toBe(0)
  })

  it('jumpTargetIndex maps target + direction to the right edge', () => {
    expect(jumpTargetIndex('newest', 10, 'asc')).toBe(9)
    expect(jumpTargetIndex('oldest', 10, 'asc')).toBe(0)
    expect(jumpTargetIndex('newest', 10, 'desc')).toBe(0)
    expect(jumpTargetIndex('oldest', 10, 'desc')).toBe(9)
  })
})
