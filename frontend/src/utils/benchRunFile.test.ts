import { describe, expect, it } from 'vitest'

import { benchRunFileName } from './benchRunFile'

describe('the file name of a downloaded benchmark run', () => {
  it('holds the day, the id and a slug of the label', () => {
    expect(benchRunFileName({ id: 12, label: 'GPU, Etappen 1–5', started_at: '2026-10-26T19:02:11.000Z' }))
      .toBe('benchmark-2026-10-26-12-gpu-etappen-1-5.json')
  })

  it('leaves the slug out when the label has nothing to keep', () => {
    expect(benchRunFileName({ id: 3, label: '???', started_at: '2026-10-27T06:00:00.000Z' })).toBe('benchmark-2026-10-27-3.json')
  })
})
