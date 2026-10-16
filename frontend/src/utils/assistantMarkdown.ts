/**
 * The little Markdown an answer uses (#1528): bold, italics, code, bullet
 * and numbered lists, paragraphs. Nothing else is interpreted — no HTML, no
 * links, no headings — and the result is a tree the template renders, never
 * a string handed to v-html. A model writes "**Titel** (06.07.2026)" and
 * "* erster Punkt"; the reader should see bold text and a list, not the
 * asterisks.
 */

export interface Inline {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul' | 'ol'; items: Inline[][] }

const BULLET = /^\s*[*\-•]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/

/** Splits one line into runs of plain, bold, italic and code text. */
export function parseInline(line: string): Inline[] {
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

/** Paragraphs and lists; a blank line ends either. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const last = (): Block | undefined => blocks[blocks.length - 1]
  // Whether the previous line continued the block at the end of `blocks`;
  // a blank line sets it false so the next line starts a new block.
  let open = false

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
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
    } else if (open && tail && tail.type !== 'p' && raw.startsWith('  ')) {
      // An indented line continues the list item above it.
      tail.items[tail.items.length - 1]!.push({ text: ' ' }, ...parseInline(line.trim()))
    } else {
      blocks.push({ type: 'p', lines: [parseInline(line)] })
    }
    open = true
  }
  return blocks
}
