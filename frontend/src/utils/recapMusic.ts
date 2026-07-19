import type { MusicTrack } from '../api/recaps'

/**
 * Order the available tracks into a cycle that starts at the recap's suggested
 * track, so the player can step "andere Musik" through every track once and
 * wrap back to the first (suggested) one.
 *
 * Example: tracks [A, B, C, D], suggested = C → [C, D, A, B]. Advancing past
 * the end wraps to C again.
 */
export function orderedTrackCycle(
  tracks: MusicTrack[],
  suggestedId: string | null,
): MusicTrack[] {
  if (tracks.length === 0) return []
  const start = suggestedId ? tracks.findIndex((t) => t.id === suggestedId) : 0
  const s = start < 0 ? 0 : start
  return [...tracks.slice(s), ...tracks.slice(0, s)]
}
