import { describe, it, expect } from 'vitest'

import {
  buildCategoryOptions,
  filterOptions,
  queryTerms,
  type CategoryNode,
} from './categoryOptions'

const CATEGORIES: CategoryNode[] = [
  { id: 1, slug: 'wohnen', name: 'Wohnen', parent_id: null },
  { id: 2, slug: 'wohnen-haus', name: 'Haus & Grund', parent_id: 1 },
  { id: 3, slug: 'wohnen-haus-grundsteuer', name: 'Grundsteuer', parent_id: 2 },
  { id: 4, slug: 'landwirtschaft', name: 'Landwirtschaft (verpachtet)', parent_id: null },
  { id: 5, slug: 'landwirtschaft-pacht', name: 'Pacht & Verträge', parent_id: 4 },
  { id: 6, slug: 'landwirtschaft-instandhaltung', name: 'Instandhaltung & Reparatur', parent_id: 4 },
]

describe('buildCategoryOptions', () => {
  it('includes every level, not just parents and their direct children', () => {
    const slugs = buildCategoryOptions(CATEGORIES).map((o) => o.slug)
    expect(slugs).toContain('wohnen-haus-grundsteuer')
  })

  it('lists a parent immediately followed by its descendants, alphabetically', () => {
    expect(buildCategoryOptions(CATEGORIES).map((o) => o.slug)).toEqual([
      'landwirtschaft',
      'landwirtschaft-instandhaltung',
      'landwirtschaft-pacht',
      'wohnen',
      'wohnen-haus',
      'wohnen-haus-grundsteuer',
    ])
  })

  it('indents each level with one dash prefix per depth', () => {
    const bySlug = new Map(buildCategoryOptions(CATEGORIES).map((o) => [o.slug, o.label]))
    expect(bySlug.get('wohnen')).toBe('Wohnen')
    expect(bySlug.get('wohnen-haus')).toBe('— Haus & Grund')
    expect(bySlug.get('wohnen-haus-grundsteuer')).toBe('— — Grundsteuer')
  })

  it('keeps rows whose parent is missing from the list', () => {
    const orphan: CategoryNode = { id: 9, slug: 'orphan', name: 'Waise', parent_id: 404 }
    expect(buildCategoryOptions([...CATEGORIES, orphan]).map((o) => o.slug)).toContain('orphan')
  })
})

describe('filterOptions', () => {
  const options = buildCategoryOptions(CATEGORIES)

  it('offers the subcategories when the parent name is typed', () => {
    expect(filterOptions(options, 'Landwirtschaft').map((o) => o.slug)).toEqual([
      'landwirtschaft',
      'landwirtschaft-instandhaltung',
      'landwirtschaft-pacht',
    ])
  })

  it('still matches a leaf name on its own', () => {
    expect(filterOptions(options, 'grundsteuer').map((o) => o.slug)).toEqual([
      'wohnen-haus-grundsteuer',
    ])
  })

  it('narrows down when several terms are typed', () => {
    expect(filterOptions(options, 'landwirtschaft inst').map((o) => o.slug)).toEqual([
      'landwirtschaft-instandhaltung',
    ])
  })

  it('returns the full list for an empty query', () => {
    expect(filterOptions(options, '   ')).toHaveLength(options.length)
  })
})

describe('queryTerms', () => {
  it('splits on whitespace and drops empties', () => {
    expect(queryTerms('  Haus   Grund ')).toEqual(['haus', 'grund'])
    expect(queryTerms('')).toEqual([])
  })
})
