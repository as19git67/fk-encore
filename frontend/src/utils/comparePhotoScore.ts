export interface FreshScore {
  ai_quality_score: number | null
  ai_quality_details: Record<string, number> | null
}

/**
 * Overlay freshly fetched AI-quality fields onto a photo object used by the
 * compare view. The album's photo array is lazily cached and can be stale for
 * `ai_quality_score` (loaded before the quality scan finished), which made the
 * compare view show "?" even after all queues were done. We merge only the
 * AI-quality fields and deliberately keep everything else (notably
 * `curation_status`) so the in-session hide/undo logic is unaffected.
 *
 * A null fresh score falls back to the base value, so a not-yet-scored fresh
 * read never wipes an existing score.
 */
export function mergeFreshScore<
  T extends { ai_quality_score?: number | null; ai_quality_details?: Record<string, number> | null },
>(base: T, fresh: FreshScore | undefined): T {
  if (!fresh) return base
  return {
    ...base,
    ai_quality_score: fresh.ai_quality_score ?? base.ai_quality_score,
    ai_quality_details: fresh.ai_quality_details ?? base.ai_quality_details,
  }
}
