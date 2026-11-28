import { describe, expect, it } from 'vitest'
import { calloutOf, draftTitleOf, markdownTokens, mediaIdOf, mediaImageMarkdown, insertBlock, insertParagraphs, prefixLines, safeHref, wrapSelection } from './markdown'

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

describe('calloutOf', () => {
  /** The text marked hands the view for the first quote of `source`. */
  function quoteText(source: string): string {
    const quote = markdownTokens(source).find((t) => t.type === 'blockquote') as { text: string }
    return quote.text
  }

  it('reads a warning and a note', () => {
    expect(calloutOf(quoteText('> [!WARNING]\n> Erst das Wasser abdrehen.'))).toEqual({
      kind: 'warning',
      body: 'Erst das Wasser abdrehen.',
    })
    expect(calloutOf(quoteText('> [!note]\n> Passt auch für M22.'))?.kind).toBe('note')
    expect(calloutOf(quoteText('> [!CAUTION]\n> Heiß.'))?.kind).toBe('warning')
    expect(calloutOf(quoteText('> [!TIP]\n> Mit Essig entkalken.'))?.kind).toBe('note')
  })

  it('leaves a plain quote alone', () => {
    expect(calloutOf(quoteText('> Ein Zitat'))).toBeNull()
    expect(calloutOf(quoteText('> Siehe [!WARNING] oben'))).toBeNull()
    expect(calloutOf(quoteText('> [!SOMETHING]\n> x'))).toBeNull()
  })
})

describe('mediaIdOf', () => {
  it('reads the photo id of a handbook image', () => {
    expect(mediaIdOf('media:12')).toBe(12)
    const [paragraph] = markdownTokens('![Filter](media:7)') as Array<{ tokens: Array<{ type: string; href: string }> }>
    expect(paragraph.tokens[0]).toMatchObject({ type: 'image', href: 'media:7' })
  })

  it('leaves every other source alone', () => {
    for (const href of ['https://example.test/a.jpg', 'media:', 'media:0', 'media:12/x', 'media:12?x', 'xmedia:1', null]) {
      expect(mediaIdOf(href)).toBeNull()
    }
  })

  it('writes an image whose caption cannot break the syntax', () => {
    expect(mediaImageMarkdown(5, 'Filter [alt]\nneu')).toBe('![Filter  alt  neu](media:5)')
    expect(mediaImageMarkdown(5)).toBe('![](media:5)')
  })
})
