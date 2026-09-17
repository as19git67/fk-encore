import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the API layer so the cache can be exercised without network calls.
const getPhotoFaces = vi.fn()
const getPhotoPoiMatches = vi.fn()
const getPhotosAlbums = vi.fn()
const getPhotoOcr = vi.fn()

vi.mock('../api/photos', () => ({
  getPhotoFaces: (id: number) => getPhotoFaces(id),
  getPhotoPoiMatches: (id: number) => getPhotoPoiMatches(id),
  getPhotosAlbums: (ids: number[]) => getPhotosAlbums(ids),
  getPhotoOcr: (id: number) => getPhotoOcr(id),
}))

import {
  getPhotoFacesCached,
  getPhotoPoiMatchesCached,
  getPhotoAlbumsCached,
  peekPhotoAlbumsCached,
  primePhotoAlbumsCache,
  invalidatePhotoFaces,
  invalidatePhotoAlbums,
  invalidatePhotoMeta,
  prefetchPhotoMeta,
  refreshPhotoFaces,
  refreshPhotoPoiMatches,
  peekPhotoFacesCached,
  peekPhotoPoiMatchesCached,
  getPhotoOcrCached,
  peekPhotoOcrCached,
} from './usePhotoMetaCache'

beforeEach(() => {
  getPhotoFaces.mockReset()
  getPhotoPoiMatches.mockReset()
  getPhotosAlbums.mockReset()
  // Distinct ids per test avoid cross-test cache bleed (module-level cache).
})

describe('usePhotoMetaCache', () => {
  it('caches faces after the first fetch', async () => {
    getPhotoFaces.mockResolvedValue({ faces: [{ id: 1 }] })
    const a = await getPhotoFacesCached(101)
    const b = await getPhotoFacesCached(101)
    expect(a).toEqual([{ id: 1 }])
    expect(b).toEqual([{ id: 1 }])
    expect(getPhotoFaces).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent in-flight requests', async () => {
    let resolve!: (v: unknown) => void
    getPhotoPoiMatches.mockReturnValue(new Promise((r) => { resolve = r }))
    const p1 = getPhotoPoiMatchesCached(102)
    const p2 = getPhotoPoiMatchesCached(102)
    resolve({ matches: [{ id: 7 }] })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual([{ id: 7 }])
    expect(r2).toEqual([{ id: 7 }])
    expect(getPhotoPoiMatches).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures — a later read retries', async () => {
    getPhotoFaces.mockRejectedValueOnce(new Error('boom'))
    await expect(getPhotoFacesCached(103)).rejects.toThrow('boom')
    getPhotoFaces.mockResolvedValueOnce({ faces: [] })
    await expect(getPhotoFacesCached(103)).resolves.toEqual([])
    expect(getPhotoFaces).toHaveBeenCalledTimes(2)
  })

  it('extracts the matching photo id from a batch album response', async () => {
    getPhotosAlbums.mockResolvedValue({
      results: [
        { photoId: 104, albumIds: [5, 6] },
        { photoId: 999, albumIds: [1] },
      ],
    })
    const ids = await getPhotoAlbumsCached(104)
    expect(ids).toEqual([5, 6])
    expect(getPhotosAlbums).toHaveBeenCalledWith([104])
  })

  it('peek/prime expose the album cache synchronously', async () => {
    expect(peekPhotoAlbumsCached(105)).toBeUndefined()
    primePhotoAlbumsCache(105, [9])
    expect(peekPhotoAlbumsCached(105)).toEqual([9])
    // A primed entry is served without hitting the API.
    const ids = await getPhotoAlbumsCached(105)
    expect(ids).toEqual([9])
    expect(getPhotosAlbums).not.toHaveBeenCalled()
  })

  it('invalidatePhotoFaces forces a re-fetch', async () => {
    getPhotoFaces.mockResolvedValue({ faces: [] })
    await getPhotoFacesCached(106)
    invalidatePhotoFaces(106)
    await getPhotoFacesCached(106)
    expect(getPhotoFaces).toHaveBeenCalledTimes(2)
  })

  it('invalidatePhotoAlbums drops only the album cache', async () => {
    primePhotoAlbumsCache(107, [1])
    invalidatePhotoAlbums(107)
    expect(peekPhotoAlbumsCached(107)).toBeUndefined()
  })

  it('invalidatePhotoMeta drops faces, poi and albums', async () => {
    getPhotoFaces.mockResolvedValue({ faces: [{ id: 1 }] })
    getPhotoPoiMatches.mockResolvedValue({ matches: [{ id: 2 }] })
    primePhotoAlbumsCache(108, [3])
    await getPhotoFacesCached(108)
    await getPhotoPoiMatchesCached(108)
    invalidatePhotoMeta(108)
    expect(peekPhotoAlbumsCached(108)).toBeUndefined()
    await getPhotoFacesCached(108)
    await getPhotoPoiMatchesCached(108)
    expect(getPhotoFaces).toHaveBeenCalledTimes(2)
    expect(getPhotoPoiMatches).toHaveBeenCalledTimes(2)
  })

  it('prefetchPhotoMeta warms all three caches and swallows errors', async () => {
    getPhotoFaces.mockResolvedValue({ faces: [] })
    getPhotoPoiMatches.mockRejectedValue(new Error('poi down'))
    getPhotosAlbums.mockResolvedValue({ results: [{ photoId: 109, albumIds: [] }] })
    prefetchPhotoMeta(109)
    // Let the fire-and-forget promises settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(getPhotoFaces).toHaveBeenCalledWith(109)
    expect(getPhotosAlbums).toHaveBeenCalledWith([109])
    expect(peekPhotoAlbumsCached(109)).toEqual([])
  })

  it('refreshPhotoPoiMatches replaces a stale empty cache with fresh matches', async () => {
    // Simulate a prefetch that ran before POI detection finished → cached empty.
    getPhotoPoiMatches.mockResolvedValueOnce({ matches: [] })
    await getPhotoPoiMatchesCached(130)
    expect(peekPhotoPoiMatchesCached(130)).toEqual([])
    // Detection has since produced matches; a refresh surfaces them.
    getPhotoPoiMatches.mockResolvedValueOnce({ matches: [{ id: 5 }] })
    await expect(refreshPhotoPoiMatches(130)).resolves.toEqual([{ id: 5 }])
    expect(peekPhotoPoiMatchesCached(130)).toEqual([{ id: 5 }])
    expect(getPhotoPoiMatches).toHaveBeenCalledTimes(2)
  })

  it('refreshPhotoFaces forces a fresh fetch over any cached entry', async () => {
    getPhotoFaces.mockResolvedValueOnce({ faces: [] })
    await getPhotoFacesCached(131)
    getPhotoFaces.mockResolvedValueOnce({ faces: [{ id: 1 }] })
    await expect(refreshPhotoFaces(131)).resolves.toEqual([{ id: 1 }])
    expect(peekPhotoFacesCached(131)).toEqual([{ id: 1 }])
    expect(getPhotoFaces).toHaveBeenCalledTimes(2)
  })

  it('prefetchPhotoMeta ignores invalid ids', () => {
    prefetchPhotoMeta(0)
    prefetchPhotoMeta(NaN)
    expect(getPhotoFaces).not.toHaveBeenCalled()
    expect(getPhotosAlbums).not.toHaveBeenCalled()
  })
})

describe('recognised text (#1029)', () => {
  beforeEach(() => { getPhotoOcr.mockReset() })

  it('loads once and serves the sidebar and the overlay from the same entry', async () => {
    getPhotoOcr.mockResolvedValue({ ocr: { photo_id: 201, blocks: [], full_text: '', mean_confidence: 0, scanned_at: 't' } })
    const a = await getPhotoOcrCached(201)
    const b = await getPhotoOcrCached(201)
    expect(a).toBe(b)
    expect(getPhotoOcr).toHaveBeenCalledTimes(1)
  })

  it('remembers "not scanned yet" instead of asking again', async () => {
    // null is an answer, not a miss: the photo simply has no result yet.
    getPhotoOcr.mockResolvedValue({ ocr: null })
    expect(await getPhotoOcrCached(202)).toBeNull()
    expect(peekPhotoOcrCached(202)).toBeNull()
    await getPhotoOcrCached(202)
    expect(getPhotoOcr).toHaveBeenCalledTimes(1)
  })

  it('reports never-loaded as undefined', () => {
    expect(peekPhotoOcrCached(203)).toBeUndefined()
  })

  it('is dropped with the rest of the photo meta', async () => {
    getPhotoOcr.mockResolvedValue({ ocr: null })
    await getPhotoOcrCached(204)
    invalidatePhotoMeta(204)
    expect(peekPhotoOcrCached(204)).toBeUndefined()
  })

  it('does not cache a failure', async () => {
    getPhotoOcr.mockRejectedValueOnce(new Error('boom'))
    await expect(getPhotoOcrCached(205)).rejects.toThrow('boom')
    getPhotoOcr.mockResolvedValue({ ocr: null })
    await expect(getPhotoOcrCached(205)).resolves.toBeNull()
  })
})
