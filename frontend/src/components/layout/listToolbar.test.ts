import { describe, it, expect } from 'vitest'
import { formatCount, formatResultCount, isSearchHotkey } from './listToolbar'

describe('formatResultCount', () => {
  it('says nothing found when there is nothing', () => {
    expect(formatResultCount(0)).toBe('Keine Treffer')
    expect(formatResultCount(0, 0)).toBe('Keine Treffer')
  })

  it('still names the total while the first rows are on their way', () => {
    // Not "Keine Treffer": 42 rows match, none have arrived yet.
    expect(formatResultCount(0, 42)).toBe('0 von 42')
  })

  it('counts plain hits when no total is known', () => {
    expect(formatResultCount(7)).toBe('7 Treffer')
  })

  it('collapses to a plain count once everything is loaded', () => {
    expect(formatResultCount(12, 12)).toBe('12 Treffer')
    // Defensive: a loaded count above the reported total is still complete.
    expect(formatResultCount(13, 12)).toBe('12 Treffer')
  })

  it('shows loaded of total while more is waiting', () => {
    expect(formatResultCount(200, 4567)).toBe('200 von 4.567')
  })

  it('groups thousands the German way', () => {
    expect(formatCount(4567)).toBe('4.567')
  })
})

describe('isSearchHotkey', () => {
  const key = (init: Partial<KeyboardEvent> & { target?: unknown }) =>
    ({ key: '/', ctrlKey: false, metaKey: false, altKey: false, ...init }) as KeyboardEvent

  it('accepts a bare slash outside any text entry', () => {
    expect(isSearchHotkey(key({ target: { tagName: 'DIV' } }))).toBe(true)
    expect(isSearchHotkey(key({ target: null }))).toBe(true)
  })

  it('ignores any other key', () => {
    expect(isSearchHotkey(key({ key: 'a', target: { tagName: 'DIV' } }))).toBe(false)
  })

  it('ignores a slash that carries a modifier', () => {
    expect(isSearchHotkey(key({ ctrlKey: true, target: { tagName: 'DIV' } }))).toBe(false)
    expect(isSearchHotkey(key({ metaKey: true, target: { tagName: 'DIV' } }))).toBe(false)
    expect(isSearchHotkey(key({ altKey: true, target: { tagName: 'DIV' } }))).toBe(false)
  })

  it('leaves a slash typed into a field alone', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isSearchHotkey(key({ target: { tagName } }))).toBe(false)
    }
    expect(isSearchHotkey(key({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false)
  })
})
