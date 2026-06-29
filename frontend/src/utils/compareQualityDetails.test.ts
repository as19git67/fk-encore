import { describe, expect, it } from 'vitest'
import { qualityComparisonRows } from './compareQualityDetails'

describe('qualityComparisonRows', () => {
  it('includes criteria found on either photo in stable order', () => {
    expect(qualityComparisonRows(
      { sharpness: 0.8 },
      { exposure: 0.4, sharpness: 0.6 },
    )).toEqual([
      { key: 'exposure', first: null, second: 0.4 },
      { key: 'sharpness', first: 0.8, second: 0.6 },
    ])
  })

  it('clamps malformed out-of-range model values', () => {
    expect(qualityComparisonRows(
      { sharpness: 2, contrast: Number.NaN },
      { sharpness: -1 },
    )).toEqual([
      { key: 'contrast', first: null, second: null },
      { key: 'sharpness', first: 1, second: 0 },
    ])
  })
})
