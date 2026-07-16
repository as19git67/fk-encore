import { describe, expect, it } from 'vitest'
import { personCompareFromSeed } from './recapCompare'

describe('personCompareFromSeed', () => {
  const seed = {
    person_id: 3,
    window: 'recent',
    then_photo_id: 11,
    then_year: 2015,
    now_photo_id: 99,
    now_year: 2026,
  }

  it('extracts the pair from a person seed', () => {
    expect(personCompareFromSeed('person', seed)).toEqual({
      thenId: 11,
      thenYear: 2015,
      nowId: 99,
      nowYear: 2026,
    })
  })

  it('returns null for other kinds', () => {
    expect(personCompareFromSeed('trip', seed)).toBeNull()
    expect(personCompareFromSeed('on_this_day', seed)).toBeNull()
  })

  it('returns null when fields are missing or invalid', () => {
    expect(personCompareFromSeed('person', null)).toBeNull()
    expect(personCompareFromSeed('person', { person_id: 3 })).toBeNull()
    expect(
      personCompareFromSeed('person', { ...seed, then_year: '2015' })
    ).toBeNull()
    expect(
      personCompareFromSeed('person', { ...seed, now_photo_id: 11 })
    ).toBeNull()
  })
})
