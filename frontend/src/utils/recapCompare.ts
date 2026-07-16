import type { RecapKind } from '../api/recaps'
import type { Photo } from '../api/photos'

/** Photo-id pair for the "Damals & heute" slide, as stored in the seed. */
export interface RecapCompareIds {
  thenId: number
  thenYear: number
  nowId: number
  nowYear: number
}

/** Resolved compare data the player renders (photos loaded via details batch). */
export interface RecapCompareData {
  then: Photo
  thenYear: number
  now: Photo
  nowYear: number
}

/**
 * Extract the "Damals & heute" pair from a person recap's seed. Only person
 * recaps whose builder found a pair with enough year span carry these fields.
 */
export function personCompareFromSeed(
  kind: RecapKind,
  seed: Record<string, unknown> | null | undefined
): RecapCompareIds | null {
  if (kind !== 'person' || !seed) return null
  const { then_photo_id, then_year, now_photo_id, now_year } = seed
  if (
    typeof then_photo_id !== 'number' ||
    typeof then_year !== 'number' ||
    typeof now_photo_id !== 'number' ||
    typeof now_year !== 'number'
  ) {
    return null
  }
  if (then_photo_id === now_photo_id) return null
  return {
    thenId: then_photo_id,
    thenYear: then_year,
    nowId: now_photo_id,
    nowYear: now_year,
  }
}
