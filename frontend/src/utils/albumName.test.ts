import { describe, expect, it } from 'vitest'
import { albumNameKey, findOwnAlbumByName } from './albumName'

const albums = [
  { id: 1, name: 'Sommer', my_access_level: 'owner' },
  { id: 2, name: 'Herbst', my_access_level: 'write' },
]

describe('albumName', () => {
  it('ignores case and surrounding spaces', () => {
    expect(albumNameKey('  SoMMer ')).toBe('sommer')
    expect(findOwnAlbumByName(albums, ' sommer ')?.id).toBe(1)
  })

  it('only looks at the caller\'s own albums', () => {
    expect(findOwnAlbumByName(albums, 'Herbst')).toBeUndefined()
  })

  it('leaves out the album being renamed and empty names', () => {
    expect(findOwnAlbumByName(albums, 'SOMMER', 1)).toBeUndefined()
    expect(findOwnAlbumByName(albums, '   ')).toBeUndefined()
  })
})
