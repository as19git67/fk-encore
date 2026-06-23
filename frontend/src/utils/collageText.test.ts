import { describe, it, expect } from 'vitest'
import {
  COLLAGE_TEXT_FONTS,
  defaultTextOverlay,
  collageFontPreset,
  clampUnit,
  wrapLines,
} from './collageText'

describe('defaultTextOverlay', () => {
  it('is empty, centred, medium and white', () => {
    const o = defaultTextOverlay()
    expect(o).toEqual({ text: '', x: 0.5, y: 0.5, fontKey: 'medium', align: 'center', color: '#ffffff' })
  })

  it('returns a fresh object each call (no shared reference)', () => {
    const a = defaultTextOverlay()
    a.text = 'hi'
    expect(defaultTextOverlay().text).toBe('')
  })
})

describe('collageFontPreset', () => {
  it('resolves every known key', () => {
    for (const f of COLLAGE_TEXT_FONTS) {
      expect(collageFontPreset(f.key).key).toBe(f.key)
    }
  })

  it('falls back to medium for an unknown key', () => {
    // @ts-expect-error deliberately passing an invalid key
    expect(collageFontPreset('huge').key).toBe('medium')
  })

  it('orders presets small < medium < large by height fraction', () => {
    const [small, medium, large] = COLLAGE_TEXT_FONTS
    expect(small!.heightFraction).toBeLessThan(medium!.heightFraction)
    expect(medium!.heightFraction).toBeLessThan(large!.heightFraction)
  })
})

describe('clampUnit', () => {
  it('passes through values already in range', () => {
    expect(clampUnit(0)).toBe(0)
    expect(clampUnit(0.42)).toBe(0.42)
    expect(clampUnit(1)).toBe(1)
  })

  it('clamps out-of-range values to the edges', () => {
    expect(clampUnit(-2)).toBe(0)
    expect(clampUnit(5)).toBe(1)
  })

  it('collapses non-finite / missing input to the centre', () => {
    expect(clampUnit(NaN)).toBe(0.5)
    expect(clampUnit(undefined)).toBe(0.5)
    expect(clampUnit(null)).toBe(0.5)
  })
})

describe('wrapLines', () => {
  // Each character is one unit wide; spaces count too (candidate includes them).
  const measure = (s: string) => s.length

  it('keeps a short single line intact', () => {
    expect(wrapLines('hello world', 100, measure)).toEqual(['hello world'])
  })

  it('wraps on word boundaries when a line would overflow', () => {
    // "aaa bbb ccc" → width 11; cap at 7 → "aaa bbb" (7) overflows? 7 == 7 ok,
    // adding " ccc" → 11 > 7 → break.
    expect(wrapLines('aaa bbb ccc', 7, measure)).toEqual(['aaa bbb', 'ccc'])
  })

  it('honours explicit newlines and preserves blank lines', () => {
    expect(wrapLines('a\n\nb', 100, measure)).toEqual(['a', '', 'b'])
  })

  it('never breaks a single over-long word mid-word', () => {
    expect(wrapLines('supercalifragilistic', 5, measure)).toEqual(['supercalifragilistic'])
  })

  it('collapses runs of whitespace between words', () => {
    expect(wrapLines('a   b', 100, measure)).toEqual(['a b'])
  })

  it('treats a non-positive max width as no-wrap', () => {
    expect(wrapLines('a b c d', 0, measure)).toEqual(['a b c d'])
  })
})
