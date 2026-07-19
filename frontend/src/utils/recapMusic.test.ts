import { describe, expect, it } from 'vitest'
import { orderedTrackCycle } from './recapMusic'
import type { MusicTrack } from '../api/recaps'

const track = (id: string): MusicTrack => ({
  id,
  mood: 'calm',
  title: id,
  url: `/recaps-music/file/${id}`,
})

const A = track('a')
const B = track('b')
const C = track('c')
const D = track('d')

describe('orderedTrackCycle', () => {
  it('starts the cycle at the suggested track', () => {
    expect(orderedTrackCycle([A, B, C, D], 'c').map((t) => t.id)).toEqual([
      'c',
      'd',
      'a',
      'b',
    ])
  })

  it('starts at the head when there is no suggested track', () => {
    expect(orderedTrackCycle([A, B, C], null).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('falls back to the head when the suggested id is unknown', () => {
    expect(orderedTrackCycle([A, B], 'zzz').map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('handles an empty track list', () => {
    expect(orderedTrackCycle([], 'a')).toEqual([])
  })

  it('wraps back to the first (suggested) track after a full round', () => {
    const cycle = orderedTrackCycle([A, B, C], 'b')
    // Stepping length times returns to the start.
    const idx = (i: number) => (i + 1) % cycle.length
    let i = 0
    for (let n = 0; n < cycle.length; n++) i = idx(i)
    expect(cycle[i].id).toBe('b')
  })
})
