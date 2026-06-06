import { describe, it, expect, beforeEach } from 'vitest'
import type { Album } from '../api/photos'
import {
  writableAlbums,
  initialAlbumSelection,
  saveLastAlbumSelection,
  loadLastAlbumSelection,
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
})
