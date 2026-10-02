import { describe, it, expect } from 'vitest'
import {
  allowedDuel,
  pickSideForScreen,
  bestPerSide,
  counterpartIds,
  hasBothOrientations,
  orientationFromDimensions,
  nextIndexSkippingCounterparts,
  isCounterpartOf,
  otherSide,
  shouldSwitchSide,
  sideLabel,
  variantModeFor,
  variantSideOf,
} from './orientationVariants'
import type { GalleryGridEntry } from '../api/gallery'

const variants = { portrait: 2, landscape: 1, portrait_ids: [11, 12], landscape_ids: [21] }
const group = { id: 5, is_cover: true, member_count: 3, reviewed: true, variants }
const entry = (id: number, orientation: 'portrait' | 'landscape' | 'square' | null): GalleryGridEntry => ({
  id, filename: `${id}.jpg`, curation: 'visible', orientation, group,
})

describe('orientationVariants helpers', () => {
  it('names the sides', () => {
    expect(otherSide('portrait')).toBe('landscape')
    expect(sideLabel('landscape')).toBe('Querformat')
  })

  it('finds an entry\'s side and the photos on the other side, best first', () => {
    expect(variantSideOf(entry(12, 'portrait'))).toBe('portrait')
    expect(counterpartIds(entry(12, 'portrait'))).toEqual([21])
    expect(counterpartIds(entry(21, 'landscape'))).toEqual([11, 12])
    expect(isCounterpartOf(entry(21, 'landscape'), { id: 11 })).toBe(true)
    expect(isCounterpartOf(entry(21, 'landscape'), { id: 99 })).toBe(false)
  })

  it('has no side for a member that is not part of the format group', () => {
    // A square frame in the same group: visible on both sides, no counterpart.
    expect(variantSideOf(entry(31, 'square'))).toBeNull()
    expect(counterpartIds(entry(31, 'square'))).toEqual([])
    expect(counterpartIds({ id: 1, orientation: 'portrait', group: null })).toEqual([])
  })

  it('sends the screen orientation unless the user wants everything', () => {
    expect(variantModeFor('portrait', {})).toBe('portrait')
    expect(variantModeFor('landscape', {})).toBe('landscape')
    expect(variantModeFor('portrait', { showVariants: true })).toBe('all')
    expect(variantModeFor('portrait', { selectMode: true })).toBe('all')
  })

  it('switches sides on rotation only when it helps and nothing is pinned', () => {
    const base = { shown: 'landscape', counterpart: 'portrait', screen: 'portrait', pinned: false } as const
    expect(shouldSwitchSide(base)).toBe(true)
    expect(shouldSwitchSide({ ...base, pinned: true })).toBe(false)
    expect(shouldSwitchSide({ ...base, screen: 'landscape' })).toBe(false)
    expect(shouldSwitchSide({ ...base, counterpart: null })).toBe(false)
    expect(shouldSwitchSide({ ...base, shown: null })).toBe(false)
    expect(shouldSwitchSide({ ...base, counterpart: 'square' })).toBe(false)
  })

  it('steps over the other side when paging through a list that holds both', async () => {
    // Index 0 landscape (21), 1 and 2 its portrait counterparts, 3 unrelated.
    const list = [entry(21, 'landscape'), entry(11, 'portrait'), entry(12, 'portrait'),
      { id: 40, filename: '40.jpg', curation: 'visible', orientation: null } as GalleryGridEntry]
    const load = async (i: number) => list[i] ?? null
    expect(await nextIndexSkippingCounterparts(list[0]!, 1, 1, list.length, load)).toBe(3)
    expect(await nextIndexSkippingCounterparts(list[3]!, 2, -1, list.length, load)).toBe(2)
    expect(await nextIndexSkippingCounterparts(list[1]!, 0, -1, list.length, load)).toBeNull()
    // Without a format group nothing is skipped and nothing is loaded.
    expect(await nextIndexSkippingCounterparts(null, 1, 1, list.length, load)).toBe(1)
  })

  it('classifies dimensions like the server does', () => {
    expect(orientationFromDimensions(4000, 3000)).toBe('landscape')
    expect(orientationFromDimensions(3000, 4000)).toBe('portrait')
    expect(orientationFromDimensions(3000, 3000)).toBe('square')
    expect(orientationFromDimensions(null, 3000)).toBeNull()
  })

  it('knows when a group holds both sides and which duels a format pair allows', () => {
    expect(hasBothOrientations([{ orientation: 'portrait' }, { orientation: 'landscape' }])).toBe(true)
    expect(hasBothOrientations([{ orientation: 'portrait' }, { orientation: 'square' }])).toBe(false)

    expect(allowedDuel('portrait', 'landscape', true)).toBe(false)
    expect(allowedDuel('portrait', 'landscape', false)).toBe(true)
    expect(allowedDuel('portrait', 'portrait', true)).toBe(true)
    expect(allowedDuel('portrait', 'square', true)).toBe(true)
    expect(allowedDuel('portrait', null, true)).toBe(true)
  })

  it('keeps the best of each side', () => {
    expect(bestPerSide([
      { id: 1, orientation: 'portrait', score: 1 },
      { id: 2, orientation: 'portrait', score: 3 },
      { id: 3, orientation: 'landscape', score: -1 },
      { id: 4, orientation: 'square', score: 9 },
    ]).sort()).toEqual([2, 3])
  })

  it('shows the side that fits the screen, and the photo itself otherwise', () => {
    const landscape = { id: 1, orientation: 'landscape' as const }
    const portrait = { id: 2, orientation: 'portrait' as const }
    expect(pickSideForScreen(landscape, portrait, 'portrait')).toBe(portrait)
    expect(pickSideForScreen(landscape, portrait, 'landscape')).toBe(landscape)
    expect(pickSideForScreen(portrait, landscape, 'landscape')).toBe(landscape)
    expect(pickSideForScreen(landscape, null, 'portrait')).toBe(landscape)
    expect(pickSideForScreen({ id: 3, orientation: null }, portrait, 'portrait')).toEqual({ id: 3, orientation: null })
  })
})
