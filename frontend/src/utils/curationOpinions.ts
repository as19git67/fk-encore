export interface CurationOpinionStats {
  fav_count: number
  hide_count: number
  member_count: number
}

/**
 * Decide which curation-opinion stats the photo-detail sidebar should show
 * (the "X von Y favorisiert / ausgeblendet" row), or null when there's nothing
 * meaningful to display.
 *
 * - Prefers explicitly supplied album stats (the album views pass these for the
 *   fullscreen/split cursor photo, which otherwise doesn't carry album-scoped
 *   data) over the photo's own `curation_stats`.
 * - Returns null for a single participant (or none): "1 von 1" is noise, and a
 *   plain own gallery photo has no opinions to compare.
 */
export function resolveCurationOpinions(
  supplied: CurationOpinionStats | undefined | null,
  photoStats: CurationOpinionStats | undefined | null,
): CurationOpinionStats | null {
  const stats = supplied ?? photoStats
  if (!stats || stats.member_count <= 1) return null
  return stats
}
