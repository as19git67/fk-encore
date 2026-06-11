import type { PhotoGroup } from '../api/photos'

/**
 * Build the ordered list of group ids to offer for manual review, given
 * the current grid order.
 *
 * The manual group review should follow what the user actually sees:
 *   - ONLY groups whose members appear in the current grid (an album, a
 *     filtered result set, a search) are offered — never the full library
 *     when the user has narrowed it down.
 *   - The ORDER mirrors the grid: a group's position is where its first
 *     member shows up in `orderedPhotoIds` (the grid's photo order).
 *
 * Already-reviewed groups are dropped. A photo that happens to belong to
 * more than one group is attributed to the first group that claims it, so
 * each group surfaces exactly once.
 *
 * @param orderedPhotoIds photo ids in grid order (e.g. from `/gallery/ids`)
 * @param groups          the user's groups (reviewed + unreviewed)
 */
export function orderedUnreviewedGroupIds(
  orderedPhotoIds: number[],
  groups: PhotoGroup[],
): number[] {
  const photoToGroup = new Map<number, number>()
  for (const g of groups) {
    if (g.reviewed_at) continue
    for (const pid of g.photo_ids) {
      if (!photoToGroup.has(pid)) photoToGroup.set(pid, g.id)
    }
  }

  const seen = new Set<number>()
  const seq: number[] = []
  for (const pid of orderedPhotoIds) {
    const gid = photoToGroup.get(pid)
    if (gid !== undefined && !seen.has(gid)) {
      seen.add(gid)
      seq.push(gid)
    }
  }
  return seq
}

/**
 * Given the ordered review sequence and the id of the group just
 * reviewed, return the next group to open. Prefers the next still-pending
 * group after the current position; if none trails it (the user started
 * mid-list), wraps to the first pending group. Returns null when nothing
 * is left.
 *
 * @param sequence    ordered group ids (grid order)
 * @param currentId   the group just reviewed
 * @param isPending   predicate: is this group still unreviewed?
 */
export function nextGroupInSequence(
  sequence: number[],
  currentId: number,
  isPending: (groupId: number) => boolean,
): number | null {
  const idx = sequence.indexOf(currentId)
  if (idx !== -1) {
    for (let i = idx + 1; i < sequence.length; i++) {
      if (sequence[i] !== currentId && isPending(sequence[i]!)) return sequence[i]!
    }
  }
  // Wrap: pick the first pending group that isn't the one we just did.
  for (const gid of sequence) {
    if (gid !== currentId && isPending(gid)) return gid
  }
  return null
}
