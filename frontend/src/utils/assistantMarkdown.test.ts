import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline, parseTable } from './assistantMarkdown'

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

describe('tables', () => {
  const cells = (row: { text: string }[][]) => row.map((c) => c.map((r) => r.text).join(''))

  it('turns a Markdown pipe table into a table with header and alignment', () => {
    const blocks = parseBlocks('Verbrauch:\n\n| Jahr | Strom | Notiz |\n|:-----|------:|:-----:|\n| 2024 | 3.188 kWh | **neu** |\n| 2025 | 2.957 kWh | |\n\nFertig.')
    expect(blocks.map((b) => b.type)).toEqual(['p', 'table', 'p'])
    const t = blocks[1]!
    if (t.type !== 'table') throw new Error('no table')
    expect(cells(t.head)).toEqual(['Jahr', 'Strom', 'Notiz'])
    expect(t.rows.map(cells)).toEqual([['2024', '3.188 kWh', 'neu'], ['2025', '2.957 kWh', '']])
    expect(t.rows[0]![2]).toEqual([{ text: 'neu', bold: true }])
    expect(t.align).toEqual(['left', 'right', 'center'])
  })

  it('reads a pipe table without outer pipes', () => {
    const t = parseBlocks('Jahr | Summe\n--- | ---\n2025 | 12,00 €')[0]
    expect(t?.type).toBe('table')
  })

  it('turns a drawn ASCII table, also inside a code fence, into a table', () => {
    const ascii = [
      '+--------+---------+',
      '| Konto  | Saldo   |',
      '+========+=========+',
      '| Giro   | 1.234,56 € |',
      '| Tages  | -12,00 €   |',
      '+--------+---------+',
    ]
    for (const text of [ascii.join('\n'), ['```text', ...ascii, '```'].join('\n')]) {
      const blocks = parseBlocks(text)
      expect(blocks).toHaveLength(1)
      const t = blocks[0]!
      if (t.type !== 'table') throw new Error('no table')
      expect(cells(t.head)).toEqual(['Konto', 'Saldo'])
      expect(t.rows.map(cells)).toEqual([['Giro', '1.234,56 €'], ['Tages', '-12,00 €']])
      // Amounts line up on the right without a separator saying so.
      expect(t.align).toEqual([undefined, 'right'])
    }
  })

  it('reads box-drawing tables', () => {
    const t = parseTable([
      '┌──────┬──────┐',
      '│ A    │ B    │',
      '├──────┼──────┤',
      '│ x    │ 1    │',
      '└──────┴──────┘',
    ])
    expect(t && cells(t.head)).toEqual(['A', 'B'])
    expect(t?.rows.map(cells)).toEqual([['x', '1']])
  })

  it('leaves text that only looks like a table alone', () => {
    expect(parseBlocks('| nur eine Zeile |')).toEqual([{ type: 'p', lines: [[{ text: '| nur eine Zeile |' }]] }])
    expect(parseBlocks('+5 % mehr als im Vorjahr')[0]?.type).toBe('p')
  })

  it('keeps a fenced block that is no table as code, never as HTML', () => {
    expect(parseBlocks('```\n<script>alert(1)</script>\n```')).toEqual([{ type: 'pre', text: '<script>alert(1)</script>' }])
    const t = parseBlocks('| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | 2 |')[0]
    if (t?.type !== 'table') throw new Error('no table')
    expect(t.rows[0]![0]).toEqual([{ text: '<img src=x onerror=alert(1)>' }])
  })
})
