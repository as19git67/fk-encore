import { describe, it, expect } from 'vitest'
import {
  countActiveDocFilters,
  docFilterToQuery,
  parseDocFilterFromQuery,
  DOCUMENT_FILTER_QUERY_KEYS,
} from './useDocumentFilter'

/**
 * The Sammelmappen facet on the document list.
 *
 * Documents in a folder are never hidden on their own — a folder is a bundle
 * for handing over, not a filing location, and the same document may sit in
 * several. Thinning the list out is therefore an explicit filter, which means
 * it has to survive a reload and a shared URL like every other filter does.
 */
describe('Sammelmappen filter round-trip', () => {
  it('carries "only unbundled" through the URL', () => {
    const query = docFilterToQuery({ inCollection: false })
    expect(query).toEqual({ inCollection: 'false' })
    expect(parseDocFilterFromQuery(query)).toEqual({ inCollection: false })
  })

  it('carries "only bundled" through the URL', () => {
    const query = docFilterToQuery({ inCollection: true })
    expect(query).toEqual({ inCollection: 'true' })
    expect(parseDocFilterFromQuery(query)).toEqual({ inCollection: true })
  })

  it('carries one named folder through the URL', () => {
    const query = docFilterToQuery({ collectionId: 42 })
    expect(query).toEqual({ collection: '42' })
    expect(parseDocFilterFromQuery(query)).toEqual({ collectionId: 42 })
  })

  it('writes nothing when the facet has no opinion', () => {
    expect(docFilterToQuery({})).toEqual({})
    expect(parseDocFilterFromQuery({})).toEqual({})
  })

  it('ignores a collection id that is not a number', () => {
    expect(parseDocFilterFromQuery({ collection: 'steuer' })).toEqual({})
  })

  it('registers both keys so a filter reset clears them from the URL', () => {
    // The reset path strips exactly DOCUMENT_FILTER_QUERY_KEYS; a key missing
    // here would survive a reset and silently keep filtering.
    expect(DOCUMENT_FILTER_QUERY_KEYS).toContain('inCollection')
    expect(DOCUMENT_FILTER_QUERY_KEYS).toContain('collection')
  })
})

describe('Sammelmappen filter in the active count', () => {
  it('counts as one filter, however it is expressed', () => {
    expect(countActiveDocFilters({ inCollection: false })).toBe(1)
    expect(countActiveDocFilters({ inCollection: true })).toBe(1)
    expect(countActiveDocFilters({ collectionId: 3 })).toBe(1)
  })

  it('counts one even when both halves are set — it is a single decision', () => {
    expect(countActiveDocFilters({ collectionId: 3, inCollection: true })).toBe(1)
  })

  it('does not count when the facet is untouched', () => {
    expect(countActiveDocFilters({})).toBe(0)
    expect(countActiveDocFilters({ category: 'steuer' })).toBe(1)
  })

  it('adds to the other facets rather than replacing them', () => {
    expect(countActiveDocFilters({ category: 'steuer', inCollection: false })).toBe(2)
  })
})
