/**
 * Markdown of the text documents users write in the app. The server renders
 * the PDF from the same text with the same parser (`documents/markdown-pdf.ts`),
 * so editor preview, detail page and PDF show the same structure.
 *
 * The result is tokens that `components/documents/MarkdownView.vue` turns into
 * a tree, never a string handed to v-html: raw HTML in a document is shown as
 * text, links only open http(s) and mailto, and images stay their alt text —
 * a document must not load anything from elsewhere just by being opened.
 */

import { Lexer, type Token } from 'marked'

export function markdownTokens(source: string): Token[] {
  return new Lexer({ gfm: true, breaks: false }).lex(source)
}

/** The target of a link a reader may follow, or null for anything else (`javascript:`, relative paths). */
export function safeHref(href: string): string | null {
  const h = href.trim()
  return /^(https?:|mailto:)/i.test(h) ? h : null
}

/** `marked` passes text through with HTML entities escaped; the tree wants the characters. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * A text handed to the editor at `/dokumente/neu` through the router's history
 * state (`router.push({ name: 'dokumente-text-neu', state: { [TEXT_DRAFT_STATE_KEY]: draft } })`),
 * e.g. an assistant answer the user wants to keep as a document.
 */
export const TEXT_DRAFT_STATE_KEY = 'textDraft'

export interface TextDraft {
  title: string
  markdown: string
}

/**
 * A title for a text taken from elsewhere: its first heading, else its first
 * line without Markdown, cut to a few words; a dated fallback when it has none.
 */
export function draftTitleOf(markdown: string, today: string): string {
  const lines = markdown.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? ''
  const plain = line.replace(/^#{1,6}\s+|^[-*+>]\s+|^\d+\.\s+/, '').replace(/[*_`~[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').trim()
  if (!plain) return `Notiz vom ${today}`
  return plain.length > 80 ? `${plain.slice(0, 79).trimEnd()}…` : plain
}

// ─── Editing helpers for the toolbar ─────────────────────────────────────────

/** Text with a selection, as a textarea reports it. */
export interface TextEdit {
  text: string
  start: number
  end: number
}

/**
 * Puts `before`/`after` around the selection, or removes them when they are
 * already there. Without a selection it inserts `placeholder` selected, so the
 * next keystroke replaces it.
 */
export function wrapSelection(edit: TextEdit, before: string, after = before, placeholder = 'Text'): TextEdit {
  const { text, start, end } = edit
  const selected = text.slice(start, end)
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    return {
      text: text.slice(0, start - before.length) + selected + text.slice(end + after.length),
      start: start - before.length,
      end: end - before.length,
    }
  }
  const inner = selected || placeholder
  return {
    text: text.slice(0, start) + before + inner + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + inner.length,
  }
}

/**
 * Gives every line the selection touches the prefix `prefix(i)` (`"- "`,
 * `"1. "`, `"> "`), or takes it away when all of them already have it.
 */
export function prefixLines(edit: TextEdit, prefix: (i: number) => string, matches: RegExp): TextEdit {
  const { text, start, end } = edit
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end)
  const lineEnd = nextBreak < 0 ? text.length : nextBreak
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const remove = lines.every((l) => matches.test(l))
  const changed = lines.map((l, i) => (remove ? l.replace(matches, '') : prefix(i) + l)).join('\n')
  return {
    text: text.slice(0, lineStart) + changed + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + changed.length,
  }
}

/** Inserts a block (table, rule) on lines of its own after the selection. */
export function insertBlock(edit: TextEdit, block: string): TextEdit {
  const { text, end } = edit
  const before = text.slice(0, end)
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const insert = `${lead}${block}\n`
  const at = end + lead.length
  return { text: before + insert + text.slice(end), start: at, end: at + block.length }
}

/** Where text from outside (the assistant) goes. */
export type InsertPlace = 'cursor' | 'replace' | 'append'

/**
 * Puts text in as paragraphs of its own: in place of the selection, in place
 * of everything, or after the end. What was inserted is selected afterwards,
 * so it is easy to see and to take back with one delete.
 */
export function insertParagraphs(edit: TextEdit, text: string, where: InsertPlace): TextEdit {
  if (where === 'replace') return { text, start: 0, end: text.length }
  const start = where === 'append' ? edit.text.length : edit.start
  const end = where === 'append' ? edit.text.length : edit.end
  const head = edit.text.slice(0, start)
  const tail = edit.text.slice(end)
  const lead = head.length === 0 || head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'
  const trail = tail.length === 0 || tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n'
  return {
    text: head + lead + text + trail + tail,
    start: start + lead.length,
    end: start + lead.length + text.length,
  }
}
