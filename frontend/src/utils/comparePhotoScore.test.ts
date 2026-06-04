import { describe, it, expect } from 'vitest'
import { mergeFreshScore } from './comparePhotoScore'

describe('mergeFreshScore', () => {
  const base = { id: 1, ai_quality_score: null as number | null, ai_quality_details: null as Record<string, number> | null, curation_status: 'visible' }

  it('overlays a fresh score onto a stale/unscored photo', () => {
    const out = mergeFreshScore(base, { ai_quality_score: 0.82, ai_quality_details: { sharpness: 0.9 } })
    expect(out.ai_quality_score).toBe(0.82)
    expect(out.ai_quality_details).toEqual({ sharpness: 0.9 })
  })

  it('preserves curation_status (visibility/undo must not change)', () => {
    const hidden = { ...base, curation_status: 'hidden' }
    const out = mergeFreshScore(hidden, { ai_quality_score: 0.5, ai_quality_details: null })
    expect(out.curation_status).toBe('hidden')
  })

  it('keeps the base score when no fresh data is available', () => {
    const scored = { ...base, ai_quality_score: 0.4 }
    expect(mergeFreshScore(scored, undefined).ai_quality_score).toBe(0.4)
  })

  it('does not wipe an existing score with a null fresh read', () => {
    const scored = { ...base, ai_quality_score: 0.4 }
    const out = mergeFreshScore(scored, { ai_quality_score: null, ai_quality_details: null })
    expect(out.ai_quality_score).toBe(0.4)
  })
})
