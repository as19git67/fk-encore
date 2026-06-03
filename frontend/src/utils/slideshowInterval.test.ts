import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SLIDESHOW_INTERVAL_OPTIONS_MS,
  DEFAULT_SLIDESHOW_INTERVAL_MS,
  loadSlideshowIntervalMs,
  saveSlideshowIntervalMs,
  nextSlideshowIntervalMs,
  formatSlideshowIntervalLabel,
} from './slideshowInterval'

function fakeLocalStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

describe('slideshow interval options', () => {
  it('defaults to 5 seconds and offers the 3–30 s steps', () => {
    expect(DEFAULT_SLIDESHOW_INTERVAL_MS).toBe(5000)
    expect(SLIDESHOW_INTERVAL_OPTIONS_MS).toEqual([3000, 5000, 10000, 15000, 20000, 30000])
  })
})

describe('load/save', () => {
  it('returns the fallback (default 5 s) when nothing is stored', () => {
    expect(loadSlideshowIntervalMs()).toBe(5000)
    expect(loadSlideshowIntervalMs(10000)).toBe(10000)
  })

  it('round-trips a valid value', () => {
    saveSlideshowIntervalMs(15000)
    expect(loadSlideshowIntervalMs()).toBe(15000)
  })

  it('ignores a non-option value on save and falls back on load', () => {
    saveSlideshowIntervalMs(7000) // not an option → not stored
    expect(loadSlideshowIntervalMs()).toBe(5000)
  })

  it('falls back when the stored value is no longer an option', () => {
    localStorage.setItem('slideshow_interval_ms', '99999')
    expect(loadSlideshowIntervalMs()).toBe(5000)
  })
})

describe('nextSlideshowIntervalMs', () => {
  it('steps through the options and wraps around', () => {
    expect(nextSlideshowIntervalMs(3000)).toBe(5000)
    expect(nextSlideshowIntervalMs(5000)).toBe(10000)
    expect(nextSlideshowIntervalMs(30000)).toBe(3000) // wrap
  })

  it('restarts from the first option for an unknown current value', () => {
    expect(nextSlideshowIntervalMs(7000)).toBe(3000)
  })
})

describe('formatSlideshowIntervalLabel', () => {
  it('renders compact seconds', () => {
    expect(formatSlideshowIntervalLabel(5000)).toBe('5s')
    expect(formatSlideshowIntervalLabel(30000)).toBe('30s')
  })
})
