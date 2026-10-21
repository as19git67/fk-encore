/**
 * The little Markdown an answer uses (#1528): bold, italics, code, bullet
 * and numbered lists, paragraphs, tables and code blocks, and links to the
 * items the answer names by id (`assistantLinks.ts`). Nothing else is
 * interpreted — no HTML, no outside links, no headings — and the result is a tree
 * the template renders, never a string handed to v-html. A model writes
 * "**Titel** (06.07.2026)" and "* erster Punkt"; the reader should see bold
 * text and a list, not the asterisks.
 *
 * Tables come as Markdown pipe tables or drawn as ASCII/box art
 * (`+---+---+`, `┌───┬───┐`), bare or inside a ``` fence. Both become a
 * real table: in a proportional font the drawn columns never line up.
 */

import { linkEntities } from './assistantLinks'

export interface Inline {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** The app page this run opens: an item the answer names by id. */
  to?: string
}

export type Align = 'left' | 'center' | 'right'

export interface Table {
  type: 'table'
  /** The header row; empty when the table has none. */
  head: Inline[][]
  rows: Inline[][][]
  /** One entry per column; undefined leaves it to the default (left). */
  align: Array<Align | undefined>
}

export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul' | 'ol'; items: Inline[][] }
  | { type: 'pre'; text: string }
  | Table

const BULLET = /^\s*[*\-•]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/

/** Splits one line into runs of plain, bold, italic, code and linked text. */
export function parseInline(line: string): Inline[] {
  const runs = parseStyled(line).flatMap((run) => (run.code
    ? [run]
    : linkEntities(run.text).map((part) => ({ ...run, ...part }))))
  return runs.length ? runs : [{ text: '' }]
}

function parseStyled(line: string): Inline[] {
  const out: Inline[] = []
  // `code` first, so asterisks inside it stay; then ** and *.
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\s][^*]*?\*)/g
  let last = 0
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: line.slice(last, at) })
    if (m[1]) out.push({ text: m[1].slice(1, -1), code: true })
    else if (m[2]) out.push({ text: m[2].slice(2, -2), bold: true })
    else if (m[3]) out.push({ text: m[3].slice(1, -1), italic: true })
    last = at + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out.length ? out : [{ text: '' }]
}

const FENCE = /^\s*(```|~~~)/
/** A line a drawn or piped table starts with: a pipe, a `+` corner or a box-drawing character. */
const TABLE_START = /^\s*[|+┌├└│┃║╔╠╚╒╞╘]/
/** Box-drawing verticals that separate cells like a pipe. */
const BOX_VERTICAL = /[│┃║]/g
/** A rule between rows: only corners, dashes, pipes, colons and spaces, with a run of dashes. */
const RULE = /^[\s|+:\-=─━═┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╒╕╘╛╞╡╤╧╪]+$/
const DASHES = /[-─━═=]{3,}/
/** A Markdown separator row (`|---|:--:|`), the one place a column says how it is aligned. */
const MD_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
/** A cell that holds a number, an amount or a percentage: right-aligned so the digits line up. */
const NUMERIC = /^[-+−]?\s?\d[\d.,'’\s]*\s*(?:[%€$]|EUR|kWh|MWh|m³|m²|ha|kWp|Stk\.?)?$/i

function isRule(line: string): boolean {
  return RULE.test(line) && DASHES.test(line)
}

/** Cells of one row, without the outer pipes; `\|` stays a pipe inside its cell. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

function alignOf(cell: string): Align | undefined {
  const c = cell.trim()
  const left = c.startsWith(':')
  const right = c.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined
}

/**
 * A table from its lines, or null when they are not one: at least two rows
 * of at least two cells. The header is the single row above the first rule;
 * a Markdown separator under it also gives the columns' alignment.
 */
export function parseTable(lines: string[]): Table | null {
  const rows: string[][] = []
  let headRows = -1
  let mdAlign: Array<Align | undefined> | null = null
  for (const raw of lines) {
    const line = raw.replace(BOX_VERTICAL, '|')
    if (!line.trim()) continue
    if (isRule(line)) {
      if (headRows < 0 && rows.length > 0) {
        headRows = rows.length
        if (MD_SEPARATOR.test(line)) mdAlign = splitRow(line).map(alignOf)
      }
      continue
    }
    if (!line.includes('|')) return null
    rows.push(splitRow(line))
  }
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (rows.length < 2 || width < 2) return null

  const pad = (r: string[]): string[] => [...r, ...Array<string>(width - r.length).fill('')].slice(0, width)
  const hasHead = headRows === 1 && rows.length > 1
  const head = hasHead ? pad(rows[0]!) : []
  const body = (hasHead ? rows.slice(1) : rows).map(pad)

  const align: Array<Align | undefined> = []
  for (let c = 0; c < width; c++) {
    const given = mdAlign?.[c]
    if (given) { align.push(given); continue }
    const filled = body.map((r) => r[c]!).filter((v) => v !== '')
    align.push(filled.length && filled.every((v) => NUMERIC.test(v)) ? 'right' : undefined)
  }
  return {
    type: 'table',
    head: head.map(parseInline),
    rows: body.map((r) => r.map(parseInline)),
    align,
  }
}

/** Paragraphs, lists, tables and code blocks; a blank line ends a paragraph or list. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const last = (): Block | undefined => blocks[blocks.length - 1]
  // Whether the previous line continued the block at the end of `blocks`;
  // a blank line sets it false so the next line starts a new block.
  let open = false
  const all = text.replace(/\r\n?/g, '\n').split('\n')

  for (let i = 0; i < all.length; i++) {
    const raw = all[i]!
    const fence = FENCE.exec(raw)
    if (fence) {
      let end = i + 1
      while (end < all.length && !all[end]!.trim().startsWith(fence[1]!)) end++
      const inner = all.slice(i + 1, end)
      blocks.push(parseTable(inner) ?? { type: 'pre', text: inner.join('\n') })
      i = end
      open = false
      continue
    }
    // A run of table lines; when it is no table after all, it is read as text below.
    if (TABLE_START.test(raw) || (raw.includes('|') && MD_SEPARATOR.test(all[i + 1] ?? ''))) {
      let end = i + 1
      while (end < all.length && all[end]!.trim() && (TABLE_START.test(all[end]!) || all[end]!.includes('|'))) end++
      const table = parseTable(all.slice(i, end))
      if (table) {
        blocks.push(table)
        i = end - 1
        open = false
        continue
      }
    }
    const line = raw.trimEnd()
    if (!line.trim()) { open = false; continue }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    const tail = last()
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol'
      const item = parseInline((bullet ?? numbered)![1]!)
      if (open && tail && tail.type === type) tail.items.push(item)
      else blocks.push({ type, items: [item] })
    } else if (open && tail && tail.type === 'p') {
      tail.lines.push(parseInline(line))
    } else if (open && tail && (tail.type === 'ul' || tail.type === 'ol') && raw.startsWith('  ')) {
      // An indented line continues the list item above it.
      tail.items[tail.items.length - 1]!.push({ text: ' ' }, ...parseInline(line.trim()))
    } else {
      blocks.push({ type: 'p', lines: [parseInline(line)] })
    }
    open = true
  }
  return blocks
}
