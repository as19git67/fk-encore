import { describe, expect, it } from 'vitest'
import { draftToNarrowing, narrowingDraft } from './photoBookNarrowing'

describe('photo book narrowing form', () => {
  it('starts a new book with nothing narrowed and one photo per series', () => {
    expect(draftToNarrowing(narrowingDraft())).toEqual({
      qualityMin: null, aestheticMin: null, withoutRecognisableFaces: false, maxPhotos: null, weights: null, groupPicksOnly: true,
    })
  })

  it("reads a book's source back and writes the same narrowing", () => {
    const draft = narrowingDraft({ kind: 'album', album_id: 3, quality_min: 60, max_photos: 80, weights: { people: -1 }, group_picks_only: false })
    expect(draft).toMatchObject({ useQuality: true, qualityMin: 60, useAesthetic: false, aestheticMin: 50, useMax: true, seriesPicks: false })
    expect(draftToNarrowing(draft)).toEqual({
      qualityMin: 60, aestheticMin: null, withoutRecognisableFaces: false, maxPhotos: 80, weights: { people: -1 }, groupPicksOnly: false,
    })
  })
})
