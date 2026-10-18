/**
 * A fixed set of photos handed to the gallery in the URL (`?ids=3,9,27`):
 * the photos of one assistant answer, opened in the gallery so that the
 * viewer's previous/next move through exactly that answer and not through
 * the whole library (#1528). The gallery treats the set like a search result
 * and shows a chip that drops it.
 */

export const PHOTO_IDS_QUERY_KEY = 'ids'
/** The grid endpoint caps the list too; beyond this a URL is unwieldy anyway. */
export const MAX_PINNED_PHOTO_IDS = 500

/** The ids in a raw query value, in their order, or null without any. */
export function parsePinnedPhotoIds(raw: unknown): number[] | null {
  const text = Array.isArray(raw) ? raw[0] : raw
  if (typeof text !== 'string' || !text) return null
  const seen = new Set<number>()
  const out: number[] = []
  for (const part of text.split(',')) {
    const id = Number(part.trim())
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_PINNED_PHOTO_IDS) break
  }
  return out.length ? out : null
}

export function pinnedPhotoIdsQuery(ids: number[]): string {
  return ids.slice(0, MAX_PINNED_PHOTO_IDS).join(',')
}
