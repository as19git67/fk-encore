import { describe, it, expect } from 'vitest'
import { resolveCurationOpinions } from './curationOpinions'

describe('resolveCurationOpinions', () => {
  const shared = { fav_count: 2, hide_count: 1, member_count: 3 }
  const photoOwn = { fav_count: 1, hide_count: 0, member_count: 4 }

  it('prefers explicitly supplied album stats over the photo own stats', () => {
    expect(resolveCurationOpinions(shared, photoOwn)).toEqual(shared)
  })

  it('falls back to the photo own stats when none are supplied', () => {
    // This is the split-view case the fix restores: the cursor photo carries
    // curation_stats but no explicit prop is passed.
    expect(resolveCurationOpinions(undefined, photoOwn)).toEqual(photoOwn)
  })

  it('returns null when there is a single participant (nothing to compare)', () => {
    expect(resolveCurationOpinions({ fav_count: 1, hide_count: 0, member_count: 1 }, undefined)).toBeNull()
  })

  it('returns null when no stats are available at all', () => {
    expect(resolveCurationOpinions(undefined, undefined)).toBeNull()
    expect(resolveCurationOpinions(null, null)).toBeNull()
  })

  it('shows the row for shared albums with multiple participants', () => {
    const out = resolveCurationOpinions(undefined, shared)
    expect(out).not.toBeNull()
    expect(out!.member_count).toBe(3)
    expect(out!.fav_count).toBe(2)
  })
})
