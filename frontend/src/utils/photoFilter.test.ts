import { describe, expect, it } from 'vitest'
import type { Photo } from '../api/photos'
import { matchesPhotoFilter } from './photoFilter'

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 1,
    user_id: 7,
    filename: 'photo.jpg',
    original_name: 'photo.jpg',
    mime_type: 'image/jpeg',
    size: 2_000,
    taken_at: '2025-06-15T12:00:00.000Z',
    created_at: '2025-06-16T12:00:00.000Z',
    curation_status: 'visible',
    latitude: 48.1,
    longitude: 11.5,
    ai_quality_score: 0.8,
    ...overrides,
  }
}

describe('matchesPhotoFilter shared album/person criteria', () => {
  it('matches manual visibility and favorite filters', () => {
    expect(matchesPhotoFilter(photo({ curation_status: 'hidden' }), { hiddenMode: 'only' })).toBe(true)
    expect(matchesPhotoFilter(photo(), { hiddenMode: 'only' })).toBe(false)
    expect(matchesPhotoFilter(photo({ curation_status: 'favorite' }), { favorite: true })).toBe(true)
  })

  it('matches media type, GPS, quality and size filters', () => {
    const candidate = photo()
    expect(matchesPhotoFilter(candidate, {
      mediaTypes: ['photo'],
      hasGps: true,
      qualityMin: 75,
      qualityMax: 85,
      sizeMin: 1_000,
      sizeMax: 3_000,
    })).toBe(true)
    expect(matchesPhotoFilter(candidate, { mediaTypes: ['video'] })).toBe(false)
    expect(matchesPhotoFilter(candidate, { hasGps: false })).toBe(false)
    expect(matchesPhotoFilter(candidate, { qualityMin: 90 })).toBe(false)
    expect(matchesPhotoFilter(candidate, { sizeMax: 1_000 })).toBe(false)
  })

  it('matches date and nearby-location filters', () => {
    const candidate = photo()
    expect(matchesPhotoFilter(candidate, {
      dateFrom: '2025-06-01',
      dateTo: '2025-06-30',
      nearLat: 48.1,
      nearLon: 11.5,
      nearRadiusKm: 1,
    })).toBe(true)
    expect(matchesPhotoFilter(candidate, { dateFrom: '2025-07-01' })).toBe(false)
    expect(matchesPhotoFilter(candidate, {
      nearLat: 48.2,
      nearLon: 11.5,
      nearRadiusKm: 1,
    })).toBe(false)
  })
})
