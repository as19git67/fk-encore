import { describe, expect, it } from 'vitest'
import { tripMapIntroFromSeed } from './recapMapIntro'

describe('tripMapIntroFromSeed', () => {
  const fullSeed = {
    centroid_lat: 35.68,
    centroid_lon: 139.69,
    home_lat: 48.14,
    home_lon: 11.58,
    location_city: 'Tokio',
    duration_days: 14,
  }

  it('builds intro data for a trip with home and centroid', () => {
    const intro = tripMapIntroFromSeed('trip', fullSeed)
    expect(intro).toEqual({
      from: { lat: 48.14, lon: 11.58 },
      to: { lat: 35.68, lon: 139.69 },
      label: 'Tokio',
    })
  })

  it('returns null for non-trip kinds', () => {
    expect(tripMapIntroFromSeed('place', fullSeed)).toBeNull()
    expect(tripMapIntroFromSeed('on_this_day', fullSeed)).toBeNull()
  })

  it('returns null without a centroid', () => {
    expect(tripMapIntroFromSeed('trip', { location_city: 'Rom' })).toBeNull()
    expect(tripMapIntroFromSeed('trip', null)).toBeNull()
    expect(tripMapIntroFromSeed('trip', undefined)).toBeNull()
  })

  it('tolerates missing home (older recaps) and missing label', () => {
    const intro = tripMapIntroFromSeed('trip', {
      centroid_lat: 1,
      centroid_lon: 2,
    })
    expect(intro).toEqual({ from: null, to: { lat: 1, lon: 2 }, label: undefined })
  })

  it('ignores non-numeric coordinates', () => {
    expect(
      tripMapIntroFromSeed('trip', { centroid_lat: '35', centroid_lon: 139 })
    ).toBeNull()
    const intro = tripMapIntroFromSeed('trip', {
      centroid_lat: 1,
      centroid_lon: 2,
      home_lat: 'x',
      home_lon: 3,
    })
    expect(intro?.from).toBeNull()
  })
})
