/**
 * Full-text search over the text layer of a PDF, as pdfjs hands it out.
 *
 * pdfjs returns a page's text as a list of runs (a word, a line, whatever the
 * producer wrote in one go), each with its own position. A search term often
 * spans several runs — an OCR layer usually writes one run per word — so the
 * runs are joined into one string per page, the term is found in that, and
 * each match is mapped back onto the runs it covers to draw its highlight.
 *
 * Positions are fractions of the page as shown (0..1, origin top left), like
 * the redaction boxes, so they hold at any render size. Where a match covers
 * only part of a run, the part is estimated from the character offsets: pdfjs
 * gives no per-glyph positions, and for a highlight that is close enough.
 */

/** One text run, positioned on the page as shown. */
export interface PdfTextRun {
  str: string
  x: number
  y: number
  w: number
  h: number
}

export interface PdfPageText {
  /** The runs joined with single spaces, lower-cased for matching. */
  text: string
  /** Where each run starts in `text`, parallel to `runs`. */
  starts: number[]
  runs: PdfTextRun[]
}

export interface PdfTextRect {
  x: number
  y: number
  w: number
  h: number
}

/** Lower-case and turn every whitespace character into a plain space, keeping the length. */
function fold(value: string): string {
  let out = ''
  for (const ch of value) {
    const lower = ch.toLowerCase()
    // A character whose lower case has a different length would shift every
    // offset after it; keep it as it is instead.
    out += /\s/.test(ch) ? ' ' : lower.length === ch.length ? lower : ch
  }
  return out
}

/** The search term as it is matched: trimmed, folded, inner whitespace collapsed. */
export function normalizeQuery(query: string): string {
  return fold(query.trim()).replace(/ +/g, ' ')
}

export function buildPageText(runs: PdfTextRun[]): PdfPageText {
  const kept = runs.filter((run) => run.str.length > 0)
  const starts: number[] = []
  let text = ''
  for (const run of kept) {
    if (text.length > 0) text += ' '
    starts.push(text.length)
    text += fold(run.str)
  }
  return { text, starts, runs: kept }
}

/**
 * Offsets `[start, end)` into `page.text` of every match of `query`, without
 * overlaps. Runs of spaces count as one — a run boundary next to a run that
 * ends in a space must not make "zwei Wörter" miss.
 */
export function findMatches(page: PdfPageText, query: string): Array<[number, number]> {
  const term = normalizeQuery(query)
  if (!term) return []
  const collapsed = collapseSpaces(page.text)
  const out: Array<[number, number]> = []
  let from = 0
  for (;;) {
    const at = collapsed.text.indexOf(term, from)
    if (at < 0) break
    out.push([collapsed.map[at]!, collapsed.map[at + term.length - 1]! + 1])
    from = at + term.length
  }
  return out
}

/** `text` with runs of spaces collapsed, and where each kept character came from. */
function collapseSpaces(text: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && out.endsWith(' ')) continue
    out += text[i]
    map.push(i)
  }
  return { text: out, map }
}

/** How many times `query` occurs on the page. */
export function countMatches(page: PdfPageText, query: string): number {
  return findMatches(page, query).length
}

/** Highlight rectangles for every match of `query`, one per run a match touches. */
export function matchRects(page: PdfPageText, query: string): PdfTextRect[] {
  const rects: PdfTextRect[] = []
  for (const [start, end] of findMatches(page, query)) {
    page.runs.forEach((run, i) => {
      const runStart = page.starts[i]!
      const runEnd = runStart + run.str.length
      const from = Math.max(start, runStart)
      const to = Math.min(end, runEnd)
      if (to <= from) return
      const len = run.str.length || 1
      rects.push({
        x: run.x + (run.w * (from - runStart)) / len,
        y: run.y,
        w: (run.w * (to - from)) / len,
        h: run.h,
      })
    })
  }
  return rects
}
