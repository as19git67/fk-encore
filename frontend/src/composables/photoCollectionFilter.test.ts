import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/collections', () => ({
  getAnyCollection: vi.fn(async () => ({ name: 'Urlaub' })),
}))

import { countActiveFilters, filterToQuery, parseFilterFromQuery } from './useFilter'

describe('photo filter: collection (#1548)', () => {
  it('round-trips through the URL as `collection`', () => {
    const f = parseFilterFromQuery({ collection: '42' })
    expect(f.collectionId).toBe(42)
    expect(filterToQuery(f)).toEqual({ collection: '42' })
  })

  it('ignores ids that are not positive integers', () => {
    expect(parseFilterFromQuery({ collection: 'x' }).collectionId).toBeUndefined()
    expect(parseFilterFromQuery({ collection: '-3' }).collectionId).toBeUndefined()
    expect(parseFilterFromQuery({ collection: '1.5' }).collectionId).toBeUndefined()
  })

  it('counts as one active filter', () => {
    expect(countActiveFilters({ collectionId: 5 })).toBe(1)
  })
})
