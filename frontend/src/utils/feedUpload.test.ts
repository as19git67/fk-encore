import { describe, it, expect, beforeEach } from 'vitest'
import type { Album } from '../api/photos'
import {
  writableAlbums,
  initialAlbumSelection,
  saveLastAlbumSelection,
  loadLastAlbumSelection,
  filterAlbums,
  sortAlbumsForDialog,
} from './feedUpload'

function album(id: number, name: string, level?: Album['my_access_level']): Album {
  return { id, name, my_access_level: level } as Album
}

describe('feedUpload helpers', () => {
  beforeEach(() => localStorage.clear())

  it('keeps only albums the user can write to', () => {
    const albums = [
      album(1, 'Owned', 'owner'),
      album(2, 'Write', 'write'),
      album(3, 'WriteShare', 'write_share'),
      album(4, 'ReadOnly', 'read'),
      album(5, 'Unknown', undefined),
    ]
    expect(writableAlbums(albums).map((a) => a.id)).toEqual([1, 2, 3])
  })

  it('persists and restores the last album selection', () => {
    saveLastAlbumSelection([7, 9])
    expect(loadLastAlbumSelection()).toEqual([7, 9])
  })

  it('returns an empty selection when nothing was stored', () => {
    expect(loadLastAlbumSelection()).toEqual([])
  })

  it('pre-selects last time intersected with available albums', () => {
    saveLastAlbumSelection([1, 2, 99])
    const available = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' },
    ]
    // 99 is gone now, so it is dropped from the pre-selection.
    expect(initialAlbumSelection(available)).toEqual([1, 2])
  })

  it('pre-selects nothing on first use', () => {
    expect(initialAlbumSelection([{ id: 1, name: 'A' }])).toEqual([])
  })

  it('filters albums by name, case-insensitively', () => {
    const albums = [
      { id: 1, name: 'Urlaub 2026' },
      { id: 2, name: 'Geburtstag' },
      { id: 3, name: 'Urlaub 2025' },
    ]
    expect(filterAlbums(albums, 'urlaub').map((a) => a.id)).toEqual([1, 3])
    expect(filterAlbums(albums, '  ').map((a) => a.id)).toEqual([1, 2, 3])
    expect(filterAlbums(albums, 'xyz')).toEqual([])
  })

  it('orders pre-selected albums first, then the rest, each alphabetical', () => {
    const albums = [
      { id: 1, name: 'Zoo' },
      { id: 2, name: 'Alpen' },
      { id: 3, name: 'Berge' },
      { id: 4, name: 'Akropolis' },
    ]
    // Pre-selected: Zoo (1) and Berge (3) → those first (alphabetical: Berge, Zoo),
    // then the rest alphabetical (Akropolis, Alpen).
    expect(sortAlbumsForDialog(albums, [1, 3]).map((a) => a.name)).toEqual([
      'Berge',
      'Zoo',
      'Akropolis',
      'Alpen',
    ])
  })

  it('sorts purely alphabetically when nothing is pre-selected', () => {
    const albums = [
      { id: 1, name: 'Zoo' },
      { id: 2, name: 'Alpen' },
    ]
    expect(sortAlbumsForDialog(albums, []).map((a) => a.name)).toEqual(['Alpen', 'Zoo'])
  })
})
