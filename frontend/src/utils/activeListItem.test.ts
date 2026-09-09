import { describe, it, expect } from 'vitest'
import { resolveActiveId, stepActiveId } from './activeListItem'

const list = (...ids: number[]) => ids.map((id) => ({ id }))

describe('resolveActiveId', () => {
  it('picks the first row when nothing is current yet', () => {
    expect(resolveActiveId(list(7, 8, 9), null)).toBe(7)
  })

  it('keeps the current row when it is still there', () => {
    // A background reload must not move the pane out from under the reader.
    expect(resolveActiveId(list(7, 8, 9), 8)).toBe(8)
  })

  it('has nothing to make current in an empty list', () => {
    expect(resolveActiveId([], 8)).toBeNull()
    expect(resolveActiveId([], null)).toBeNull()
  })

  it('falls to the row that took the place of a deleted one', () => {
    // 8 is gone; the row now at its index is 9 — the one a reader would
    // expect to land on, the same way a mail client moves down on delete.
    expect(resolveActiveId(list(7, 9), 8, list(7, 8, 9))).toBe(9)
  })

  it('falls to the last row when the deleted one was at the end', () => {
    expect(resolveActiveId(list(7, 8), 9, list(7, 8, 9))).toBe(8)
  })

  it('starts over when the current row is not in the previous list either', () => {
    // A filter changed the list wholesale — there is no "place" to fall to.
    expect(resolveActiveId(list(1, 2), 99, list(7, 8))).toBe(1)
  })
})

describe('stepActiveId', () => {
  it('walks down and up', () => {
    expect(stepActiveId(list(7, 8, 9), 7, 1)).toBe(8)
    expect(stepActiveId(list(7, 8, 9), 9, -1)).toBe(8)
  })

  it('stops at the ends instead of wrapping', () => {
    // Wrapping in a list that pages in more rows reads as a jump somewhere
    // else entirely; the returned id is unchanged so the caller can no-op.
    expect(stepActiveId(list(7, 8, 9), 9, 1)).toBe(9)
    expect(stepActiveId(list(7, 8, 9), 7, -1)).toBe(7)
  })

  it('adopts the first row when nothing is current', () => {
    expect(stepActiveId(list(7, 8, 9), null, 1)).toBe(7)
    expect(stepActiveId(list(7, 8, 9), 99, -1)).toBe(7)
  })

  it('has nowhere to go in an empty list', () => {
    expect(stepActiveId([], 7, 1)).toBeNull()
  })

  it('clamps a step larger than the list', () => {
    expect(stepActiveId(list(7, 8, 9), 7, 10)).toBe(9)
    expect(stepActiveId(list(7, 8, 9), 9, -10)).toBe(7)
  })
})
