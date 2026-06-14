// Shared per-photo metadata cache for the gallery.
//
// Faces, POI matches and album membership are fetched per photo and were
// previously re-requested on every fullscreen navigation, so each prev/next
// step showed a spinner while the panel reloaded. This module caches those
// "light JSON" lookups by photo id and exposes a `prefetchPhotoMeta` helper
// so a host can warm the neighbours of the current photo — turning a real
// navigation into an instant cache hit.
//
// Staleness is handled explicitly by the few code paths that mutate this
// data:
//   - faces change on reindex / ignore  → invalidatePhotoFaces / ...Meta
//   - album membership changes via the album dialog → invalidatePhotoAlbums
// POI matches are derived from the photo's geo position and are effectively
// static, so they only drop when the whole entry is invalidated.

import {
  getPhotoFaces,
  getPhotoPoiMatches,
  getPhotosAlbums,
  type Face,
  type PoiMatchItem,
} from '../api/photos'

const facesCache = new Map<number, Face[]>()
const facesInFlight = new Map<number, Promise<Face[]>>()
const poiCache = new Map<number, PoiMatchItem[]>()
const poiInFlight = new Map<number, Promise<PoiMatchItem[]>>()
const albumsCache = new Map<number, number[]>()
const albumsInFlight = new Map<number, Promise<number[]>>()

// Generic cache-with-dedup. Successful results are cached; failures reject
// (and clear the in-flight slot) so they can be retried and are never cached
// as an empty placeholder. Callers decide how to degrade on error.
function cached<T>(
  id: number,
  cache: Map<number, T>,
  inFlight: Map<number, Promise<T>>,
  fetcher: (id: number) => Promise<T>,
): Promise<T> {
  const hit = cache.get(id)
  if (hit !== undefined) return Promise.resolve(hit)
  const pending = inFlight.get(id)
  if (pending) return pending
  const p = fetcher(id)
    .then((value) => {
      cache.set(id, value)
      inFlight.delete(id)
      return value
    })
    .catch((err) => {
      inFlight.delete(id)
      throw err
    })
  inFlight.set(id, p)
  return p
}

export function getPhotoFacesCached(id: number): Promise<Face[]> {
  return cached(id, facesCache, facesInFlight, async (i) => {
    const res = await getPhotoFaces(i)
    return res.faces ?? []
  })
}

export function getPhotoPoiMatchesCached(id: number): Promise<PoiMatchItem[]> {
  return cached(id, poiCache, poiInFlight, async (i) => {
    const res = await getPhotoPoiMatches(i)
    return res.matches ?? []
  })
}

export function getPhotoAlbumsCached(id: number): Promise<number[]> {
  return cached(id, albumsCache, albumsInFlight, async (i) => {
    const res = await getPhotosAlbums([i])
    return res.results.find((r) => r.photoId === i)?.albumIds ?? []
  })
}

/** Synchronously read a cached faces entry, if present. Lets the host skip the
 *  loading flash when a prefetched neighbour is already available. */
export function peekPhotoFacesCached(id: number): Face[] | undefined {
  return facesCache.get(id)
}

/** Synchronously read a cached POI-matches entry, if present. */
export function peekPhotoPoiMatchesCached(id: number): PoiMatchItem[] | undefined {
  return poiCache.get(id)
}

/** Synchronously read a cached album-membership entry, if present. Lets the
 *  sidebar render instantly from a prefetched neighbour without awaiting. */
export function peekPhotoAlbumsCached(id: number): number[] | undefined {
  return albumsCache.get(id)
}

/** Seed the album cache from a batch `/photos/albums` response so the
 *  sidebar's multi-id fetch also warms the single-id cache. */
export function primePhotoAlbumsCache(id: number, albumIds: number[]): void {
  albumsCache.set(id, albumIds)
}

export function invalidatePhotoFaces(id: number): void {
  facesCache.delete(id)
  facesInFlight.delete(id)
}

export function invalidatePhotoAlbums(id: number): void {
  albumsCache.delete(id)
  albumsInFlight.delete(id)
}

export function invalidatePhotoMeta(id: number): void {
  invalidatePhotoFaces(id)
  invalidatePhotoAlbums(id)
  poiCache.delete(id)
  poiInFlight.delete(id)
}

/** Warm faces + POI + album membership for a photo. Fire-and-forget: errors
 *  are swallowed so a failed prefetch just means the next real read retries. */
export function prefetchPhotoMeta(id: number): void {
  if (!Number.isFinite(id) || id <= 0) return
  void getPhotoFacesCached(id).catch(() => {})
  void getPhotoPoiMatchesCached(id).catch(() => {})
  void getPhotoAlbumsCached(id).catch(() => {})
}
