#!/usr/bin/env node
/**
 * Every icon button says what it does (issue #1281).
 *
 * A `<Button icon="pi pi-trash" />` renders a picture and nothing else. A
 * sighted user guesses from the glyph; a screen reader announces "button"
 * and stops. There were 46 of them in this app — delete, rename, move up,
 * submit — and none of them could be told apart without looking.
 *
 * So an icon button with no visible `label` needs an `aria-label` (or a
 * `v-tooltip`, which PrimeVue also exposes to assistive technology). A
 * button inside an `aria-hidden` subtree is exempt: the measurement row in
 * ResponsiveToolbar renders a copy of every item off-stage, and nothing in
 * there is ever announced.
 *
 * Runs in the pre-commit hook, so it stays a file walk and a small parser —
 * no bundler, no dependencies.
 *
 * Usage:
 *   node scripts/check-button-labels.mjs            # every file
 *   node scripts/check-button-labels.mjs a.vue …    # only those (hook mode)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const FRONTEND_SRC = join(REPO_ROOT, 'frontend', 'src')

/**
 * Walk the tags of one element type, respecting quotes.
 *
 * A regex cannot do this: `@click="(v) => f(v)"` contains a `>` that ends
 * the match early and silently truncates the attribute list — which is how
 * a first version of this check both missed real cases and invented others.
 */
function* tagsOf(source, name) {
  const open = `<${name}`
  let i = 0
  for (;;) {
    i = source.indexOf(open, i)
    if (i === -1) return
    let j = i + open.length
    let quote = null
    for (; j < source.length; j++) {
      const c = source[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
    }
    yield { start: i, end: j + 1, text: source.slice(i, j + 1) }
    i = j + 1
  }
}

/** Attribute names on a tag, ignoring anything inside a quoted value. */
function attributesOf(tag) {
  const names = new Set()
  const body = tag.slice(tag.indexOf(' ') + 1)
  const pattern = /(?:^|\s)((?::|@|v-)?[\w.:-]+)(?==|[\s/>])/g
  let m
  while ((m = pattern.exec(body)) !== null) {
    const before = body.slice(0, m.index)
    const even = (s, q) => (s.split(q).length - 1) % 2 === 0
    if (even(before, '"') && even(before, "'")) names.add(m[1])
  }
  return names
}

/**
 * Whether the tag sits inside an `aria-hidden="true"` element. Approximated
 * by depth: walk back through the markup counting how many aria-hidden
 * openings are still unclosed. Good enough for the one case that needs it
 * and never wrong in the other direction — a stray `aria-hidden` on a
 * self-closing tag before the button does not open a subtree.
 */
function insideAriaHidden(source, index) {
  const before = source.slice(0, index)
  const marker = /<(\w+)([^>]*\saria-hidden="true"[^>]*)>/g
  let m
  while ((m = marker.exec(before)) !== null) {
    if (m[2].trimEnd().endsWith('/')) continue
    const close = before.indexOf(`</${m[1]}>`, m.index)
    if (close === -1) return true // still open where the button is
  }
  return false
}

function findUnlabelled(source) {
  const found = []
  for (const { start, text } of tagsOf(source, 'Button')) {
    const attrs = attributesOf(text)
    const hasIcon = attrs.has('icon') || attrs.has(':icon')
    const hasLabel = attrs.has('label') || attrs.has(':label')
    if (!hasIcon || hasLabel) continue
    const named = [...attrs].some(
      (a) => a.startsWith('aria-label') || a.startsWith(':aria-label') || a.startsWith('v-tooltip'),
    )
    if (named) continue
    if (insideAriaHidden(source, start)) continue
    found.push({
      line: source.slice(0, start).split('\n').length,
      text: text.replace(/\s+/g, ' ').slice(0, 110),
    })
  }
  return found
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.vue')) out.push(full)
  }
  return out
}

const args = process.argv.slice(2)
const files = (args.length ? args.map((a) => resolve(process.cwd(), a)) : walk(FRONTEND_SRC)).filter(
  (f) => f.endsWith('.vue'),
)

let offending = 0
for (const file of files) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue // staged-but-deleted
  }
  const rel = relative(REPO_ROOT, file).split('\\').join('/')
  for (const v of findUnlabelled(source)) {
    offending++
    console.error(`${rel}:${v.line}  ${v.text}`)
  }
}

if (offending > 0) {
  console.error(
    `\n${offending} icon button(s) say nothing.\n` +
      'Add an aria-label (or a v-tooltip) naming the action, not the glyph.',
  )
  process.exit(1)
}
console.log(`Button labels clean (${files.length} files).`)
