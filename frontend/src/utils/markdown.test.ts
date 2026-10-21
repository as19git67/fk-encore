import { describe, expect, it } from 'vitest'
import { draftTitleOf, insertBlock, insertParagraphs, prefixLines, safeHref, wrapSelection } from './markdown'

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

describe('insertParagraphs', () => {
  it('replaces the selection with paragraphs of their own', () => {
    expect(insertParagraphs({ text: 'eins zwei drei', start: 5, end: 9 }, 'NEU', 'cursor')).toEqual({
      text: 'eins \n\nNEU\n\n drei',
      start: 7,
      end: 10,
    })
  })

  it('appends after the end', () => {
    expect(insertParagraphs({ text: 'Absatz\n', start: 0, end: 0 }, 'NEU', 'append').text).toBe('Absatz\n\nNEU')
  })

  it('replaces everything', () => {
    expect(insertParagraphs({ text: 'alt', start: 1, end: 1 }, 'neu', 'replace')).toEqual({ text: 'neu', start: 0, end: 3 })
  })
})

describe('draftTitleOf', () => {
  it('takes the first heading, else the first line without Markdown', () => {
    expect(draftTitleOf('Vorab\n\n## Stromverbrauch 2025\n\nText', '21.10.2026')).toBe('Stromverbrauch 2025')
    expect(draftTitleOf('**Der Zähler** zeigt 3.412 kWh.', '21.10.2026')).toBe('Der Zähler zeigt 3.412 kWh.')
    expect(draftTitleOf('   ', '21.10.2026')).toBe('Notiz vom 21.10.2026')
  })
})
