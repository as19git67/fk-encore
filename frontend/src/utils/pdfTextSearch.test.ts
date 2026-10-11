import { describe, expect, it } from 'vitest'
import {
  buildPageText,
  countMatches,
  findMatches,
  matchRects,
  normalizeQuery,
  type PdfTextRun,
} from './pdfTextSearch'

function run(str: string, x: number, w: number): PdfTextRun {
  return { str, x, y: 0.1, w, h: 0.02 }
}

describe('normalizeQuery', () => {
  it('trims, lower-cases and collapses inner whitespace', () => {
    expect(normalizeQuery('  Kauf\tPREIS  gesamt ')).toBe('kauf preis gesamt')
  })
})

describe('findMatches', () => {
  it('ignores case and finds every occurrence', () => {
    const page = buildPageText([run('Kaufpreis und kaufpreis', 0.1, 0.5)])
    expect(countMatches(page, 'KAUFPREIS')).toBe(2)
  })

  it('finds a phrase that spans several runs', () => {
    const page = buildPageText([run('Der', 0.1, 0.05), run('Kaufpreis', 0.16, 0.12), run('beträgt', 0.3, 0.1)])
    expect(countMatches(page, 'kaufpreis beträgt')).toBe(1)
  })

  it('treats a run ending in a space like a single space', () => {
    const page = buildPageText([run('zwei ', 0.1, 0.06), run('Wörter', 0.2, 0.08)])
    expect(countMatches(page, 'zwei wörter')).toBe(1)
  })

  it('finds nothing for an empty term', () => {
    expect(findMatches(buildPageText([run('Text', 0, 0.1)]), '   ')).toEqual([])
  })
})

describe('matchRects', () => {
  it('covers only the matched part of a run', () => {
    const page = buildPageText([run('abcdefghij', 0.1, 0.5)])
    const [rect] = matchRects(page, 'cde')
    expect(rect!.x).toBeCloseTo(0.2)
    expect(rect!.w).toBeCloseTo(0.15)
    expect(rect!.y).toBe(0.1)
    expect(rect!.h).toBe(0.02)
  })

  it('gives one rectangle per run a phrase touches', () => {
    const page = buildPageText([run('Der', 0.1, 0.05), run('Kaufpreis', 0.16, 0.12), run('beträgt', 0.3, 0.1)])
    const rects = matchRects(page, 'kaufpreis beträgt')
    expect(rects).toHaveLength(2)
    expect(rects[0]!.x).toBeCloseTo(0.16)
    expect(rects[0]!.w).toBeCloseTo(0.12)
    expect(rects[1]!.x).toBeCloseTo(0.3)
    expect(rects[1]!.w).toBeCloseTo(0.1)
  })
})
