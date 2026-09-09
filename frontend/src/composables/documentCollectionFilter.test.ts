import { describe, it, expect } from 'vitest'
import {
  collectionQueryParams,
  countActiveDocFilters,
  docFilterToQuery,
  effectiveCollectionScope,
  parseDocFilterFromQuery,
  DOCUMENT_FILTER_QUERY_KEYS,
} from './useDocumentFilter'

/**
 * The Sammelmappen scope on the document list.
 *
 * By default a bundled document is left out of the list, because its folder
 * row stands for it above — so the default is a real filter, and it has to be
 * as visible, as shareable and as undoable as one the user typed.
 */
describe('the default scope', () => {
  it('leaves bundled documents out when nothing was chosen', () => {
    expect(effectiveCollectionScope({})).toBe('without')
    expect(collectionQueryParams({})).toEqual({ in_collection: false })
  })

  it('stays out of the URL — a link carries what the sender changed', () => {
    expect(docFilterToQuery({})).toEqual({})
    expect(docFilterToQuery({ collectionScope: 'without' })).toEqual({})
  })

  it('does not count as an active filter', () => {
    expect(countActiveDocFilters({})).toBe(0)
    expect(countActiveDocFilters({ collectionScope: 'without' })).toBe(0)
  })
})

describe('departing from the default', () => {
  it('carries "auch in Sammelmappen" through the URL, asking for no condition', () => {
    const query = docFilterToQuery({ collectionScope: 'with' })
    expect(query).toEqual({ collectionScope: 'with' })
    expect(parseDocFilterFromQuery(query)).toEqual({ collectionScope: 'with' })
    expect(collectionQueryParams({ collectionScope: 'with' })).toEqual({})
  })

  it('carries "nur in Sammelmappen" through the URL', () => {
    const query = docFilterToQuery({ collectionScope: 'only' })
    expect(query).toEqual({ collectionScope: 'only' })
    expect(parseDocFilterFromQuery(query)).toEqual({ collectionScope: 'only' })
    expect(collectionQueryParams({ collectionScope: 'only' })).toEqual({ in_collection: true })
  })

  it('carries one named folder through the URL', () => {
    const query = docFilterToQuery({ collectionId: 42 })
    expect(query).toEqual({ collection: '42' })
    expect(parseDocFilterFromQuery(query)).toEqual({ collectionId: 42 })
    expect(collectionQueryParams({ collectionId: 42 })).toEqual({ collection_id: 42 })
  })

  it('lets a named folder supersede the scope', () => {
    // Asking for one folder's documents is the more specific request, and it
    // is the only reading under which the two can both be set.
    expect(collectionQueryParams({ collectionId: 42, collectionScope: 'without' })).toEqual({
      collection_id: 42,
    })
  })

  it('counts as one filter however it is expressed', () => {
    expect(countActiveDocFilters({ collectionScope: 'with' })).toBe(1)
    expect(countActiveDocFilters({ collectionScope: 'only' })).toBe(1)
    expect(countActiveDocFilters({ collectionId: 3 })).toBe(1)
    expect(countActiveDocFilters({ collectionId: 3, collectionScope: 'only' })).toBe(1)
  })

  it('adds to the other facets rather than replacing them', () => {
    expect(countActiveDocFilters({ category: 'steuer', collectionScope: 'with' })).toBe(2)
  })
})

describe('a scope value the URL should not carry', () => {
  it('falls back to the default rather than to nothing', () => {
    expect(parseDocFilterFromQuery({ collectionScope: 'without' })).toEqual({})
    expect(parseDocFilterFromQuery({ collectionScope: 'irgendwas' })).toEqual({})
    expect(effectiveCollectionScope(parseDocFilterFromQuery({ collectionScope: '' }))).toBe(
      'without',
    )
  })

  it('ignores a collection id that is not a number', () => {
    expect(parseDocFilterFromQuery({ collection: 'steuer' })).toEqual({})
  })
})

describe('filter reset', () => {
  it('registers both keys so a reset clears them from the URL', () => {
    // The reset path strips exactly DOCUMENT_FILTER_QUERY_KEYS; a key missing
    // here would survive a reset and silently keep filtering.
    expect(DOCUMENT_FILTER_QUERY_KEYS).toContain('collectionScope')
    expect(DOCUMENT_FILTER_QUERY_KEYS).toContain('collection')
  })
})
