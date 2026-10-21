import { describe, expect, it } from 'vitest'
import { insertBlock, prefixLines, safeHref, wrapSelection } from './markdown'

describe('safeHref', () => {
  it('lets web and mail links through', () => {
    expect(safeHref(' https://beispiel.test/a ')).toBe('https://beispiel.test/a')
    expect(safeHref('mailto:max@beispiel.test')).toBe('mailto:max@beispiel.test')
  })

  it('drops script and relative targets', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('/dokumente/1')).toBeNull()
  })
})

describe('wrapSelection', () => {
  it('wraps the selection', () => {
    expect(wrapSelection({ text: 'ein Wort hier', start: 4, end: 8 }, '**')).toEqual({
      text: 'ein **Wort** hier',
      start: 6,
      end: 10,
    })
  })

  it('unwraps when the markers are already there', () => {
    expect(wrapSelection({ text: 'ein **Wort** hier', start: 6, end: 10 }, '**')).toEqual({
      text: 'ein Wort hier',
      start: 4,
      end: 8,
    })
  })

  it('inserts a selected placeholder without a selection', () => {
    expect(wrapSelection({ text: 'ab', start: 1, end: 1 }, '*')).toEqual({ text: 'a*Text*b', start: 2, end: 6 })
  })
})

describe('prefixLines', () => {
  const bullet = (e: { text: string; start: number; end: number }) => prefixLines(e, () => '- ', /^- /)

  it('prefixes every touched line', () => {
    expect(bullet({ text: 'a\nb\nc', start: 0, end: 3 }).text).toBe('- a\n- b\nc')
  })

  it('removes the prefix when all lines carry it', () => {
    expect(bullet({ text: '- a\n- b', start: 0, end: 7 }).text).toBe('a\nb')
  })

  it('numbers lines', () => {
    expect(prefixLines({ text: 'a\nb', start: 0, end: 3 }, (i) => `${i + 1}. `, /^\d+\. /).text).toBe('1. a\n2. b')
  })
})

describe('insertBlock', () => {
  it('puts the block on lines of its own', () => {
    expect(insertBlock({ text: 'Absatz', start: 6, end: 6 }, '---').text).toBe('Absatz\n\n---\n')
    expect(insertBlock({ text: '', start: 0, end: 0 }, '---').text).toBe('---\n')
  })
})
