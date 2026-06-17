import type { Photo, PhotoFilter } from '../api/photos'

/**
 * Context available to the client-side filter matcher for criteria that
 * require information beyond the photo object itself.
 *
 * `curationStats` — per-photo `{ fav_count, hide_count }` (as served by
 *   getAlbumLogic). Required for `othersFavorited` / `othersHidden`.
 * `groupCoverIds` — photo ids that are the cover photo of a
 *   similar-photo group. Required for `groupHighlight`.
 * `inGroupIds` — photo ids that belong to any similar-photo group.
 *   Required for `inGroup`.
 */
export interface PhotoFilterContext {
  curationStats?: Map<number, { fav_count: number; hide_count: number }>
  groupCoverIds?: Set<number>
  inGroupIds?: Set<number>
}

function hasGpsData(photo: Photo): boolean {
  // Full photo payloads carry exact GPS coordinates. Some client-side views
  // (notably person detail) can operate on face-embedded photo payloads where
  // coordinates may be absent while already-derived location fields are present.
  // Treat those location fields as location/GPS-positive for the UI filter so
  // the tri-state does not collapse to "no matches" in that view.
  if (photo.latitude != null && photo.longitude != null) return true
  return !!(photo.location_name || photo.location_city || photo.location_country || photo.location_short)
}

/**
 * Test whether a photo matches a PhotoFilter on the client.
 *
 * Criteria that require data not available on the client (album-level
 * facts like albumIds/albumHighlight, face/person assignments) are silently
 * ignored here — the caller should only expose criteria it can actually
 * evaluate via FilterMenu's `available` prop.
 */
export function matchesPhotoFilter(
  photo: Photo,
  filter: PhotoFilter,
  ctx: PhotoFilterContext = {},
): boolean {
  const hm = filter.hiddenMode ?? 'exclude'
  if (hm === 'exclude' && photo.curation_status === 'hidden') return false
  if (hm === 'only' && photo.curation_status !== 'hidden') return false

  if (filter.favorite && photo.curation_status !== 'favorite') return false

  const stats = ctx.curationStats?.get(photo.id)

  if (filter.othersFavorited) {
    const fc = stats?.fav_count ?? 0
    const own = photo.curation_status === 'favorite' ? 1 : 0
    if (fc - own < 1) return false
  }
  if (filter.othersHidden) {
    const hc = stats?.hide_count ?? 0
    const own = photo.curation_status === 'hidden' ? 1 : 0
    if (hc - own < 1) return false
  }

  if (filter.groupHighlight && !ctx.groupCoverIds?.has(photo.id)) return false
  if (filter.inGroup && !ctx.inGroupIds?.has(photo.id)) return false

  if (filter.qualityMin !== undefined) {
    if ((photo.ai_quality_score ?? 0) * 100 < filter.qualityMin) return false
  }
  if (filter.qualityMax !== undefined) {
    if ((photo.ai_quality_score ?? 1) * 100 > filter.qualityMax) return false
  }

  if (filter.mediaTypes?.length) {
    const mt = photo.mime_type || ''
    const ok = filter.mediaTypes.some((t) => {
      if (t === 'photo') return mt.startsWith('image/') && !mt.startsWith('image/x-')
      if (t === 'video') return mt.startsWith('video/')
      if (t === 'raw') return mt.startsWith('image/x-')
      return false
    })
    if (!ok) return false
  }

  if (filter.hasGps !== undefined) {
    const hasGps = hasGpsData(photo)
    if (filter.hasGps && !hasGps) return false
    if (!filter.hasGps && hasGps) return false
  }

  if (filter.dateFrom || filter.dateTo) {
    const iso = photo.taken_at || photo.created_at
    if (!iso) return false
    const t = new Date(iso).getTime()
    if (filter.dateFrom && t < new Date(filter.dateFrom).getTime()) return false
    if (filter.dateTo) {
      const end = new Date(filter.dateTo).getTime() + 86400000
      if (t >= end) return false
    }
  }

  if (filter.ownerIds?.length && !filter.ownerIds.includes(photo.user_id)) return false

  if (filter.sizeMin !== undefined && (photo.size ?? 0) < filter.sizeMin) return false
  if (filter.sizeMax !== undefined && (photo.size ?? 0) > filter.sizeMax) return false

  if (filter.importedDaysAgo !== undefined && filter.importedDaysAgo > 0) {
    const cutoff = Date.now() - filter.importedDaysAgo * 86400000
    if (!photo.created_at || new Date(photo.created_at).getTime() < cutoff) return false
  }

  return true
}
