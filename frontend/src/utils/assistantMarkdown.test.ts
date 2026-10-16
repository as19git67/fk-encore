import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './assistantMarkdown'

describe('parseInline', () => {
  it('turns ** into bold, * into italics and ` into code, and leaves the rest', () => {
    expect(parseInline('**Antrag** vom *Juli* (`7996`) fertig')).toEqual([
      { text: 'Antrag', bold: true },
      { text: ' vom ' },
      { text: 'Juli', italic: true },
      { text: ' (' },
      { text: '7996', code: true },
      { text: ') fertig' },
    ])
  })

  it('keeps a lone asterisk and a multiplication', () => {
    expect(parseInline('3 * 4 = 12')).toEqual([{ text: '3 * 4 = 12' }])
    expect(parseInline('a*b')).toEqual([{ text: 'a*b' }])
  })
})

describe('parseBlocks', () => {
  it('makes paragraphs, bullet lists and numbered lists', () => {
    const blocks = parseBlocks('Ich habe gefunden:\n\n*   **Antrag** (06.07.2026)\n- Nachtrag\n\n1. erstens\n2) zweitens\n\nSoll ich?')
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'ol', 'p'])
    expect(blocks[1]).toEqual({ type: 'ul', items: [[{ text: 'Antrag', bold: true }, { text: ' (06.07.2026)' }], [{ text: 'Nachtrag' }]] })
    expect(blocks[2]).toEqual({ type: 'ol', items: [[{ text: 'erstens' }], [{ text: 'zweitens' }]] })
  })

  it('keeps line breaks inside a paragraph and continues an indented list item', () => {
    expect(parseBlocks('Zeile 1\nZeile 2')).toEqual([{ type: 'p', lines: [[{ text: 'Zeile 1' }], [{ text: 'Zeile 2' }]] }])
    expect(parseBlocks('* Punkt\n  mehr dazu')).toEqual([{ type: 'ul', items: [[{ text: 'Punkt' }, { text: ' ' }, { text: 'mehr dazu' }]] }])
  })

  it('never interprets HTML', () => {
    expect(parseBlocks('<b>x</b>')).toEqual([{ type: 'p', lines: [[{ text: '<b>x</b>' }]] }])
  })
})
