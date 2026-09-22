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
 * Walk every tag in the markup, respecting quotes.
 *
 * A regex cannot do this: `@click="(v) => f(v)"` contains a `>` that ends
 * the match early and silently truncates the attribute list — which is how
 * a first version of this check both missed real cases and invented others.
 *
 * Yields opening, closing and self-closing tags alike, so a caller can keep
 * track of where it is in the tree.
 */
function* tagsIn(source) {
  let i = 0
  for (;;) {
    i = source.indexOf('<', i)
    if (i === -1) return
    // A comment holds markup that never renders — and a `</div>` in there
    // would close a subtree that is still open in the real tree.
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i)
      if (end === -1) return
      i = end + 3
      continue
    }
    const nameMatch = /^<(\/?)([A-Za-z][\w.-]*)/.exec(source.slice(i, i + 64))
    if (!nameMatch) {
      i += 1
      continue
    }
    let j = i + nameMatch[0].length
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
    const text = source.slice(i, j + 1)
    yield {
      start: i,
      end: j + 1,
      name: nameMatch[2],
      closing: nameMatch[1] === '/',
      selfClosing: /\/\s*>$/.test(text),
      text,
    }
    i = j + 1
  }
}

/**
 * The opening tags of one element type.
 *
 * The name has to match to its end: `<ButtonGroup` starts with `<Button`,
 * and a prefix test checked it as if it were a Button.
 */
function* tagsOf(source, name) {
  for (const tag of tagsIn(source)) {
    if (!tag.closing && tag.name === name) yield tag
  }
}

/** Elements that never have a closing tag, so they never open a subtree. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

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
 * Whether the tag sits inside an `aria-hidden="true"` element.
 *
 * Walks the tree up to `index` keeping a stack of what is open, so a hidden
 * container that holds another element of the same name is still recognised
 * as open afterwards. Looking for the first `</div>` instead — as a first
 * version did — ended the subtree at a nested child and reported buttons
 * that nothing ever announces.
 */
function insideAriaHidden(source, index) {
  const stack = []
  for (const tag of tagsIn(source)) {
    if (tag.start >= index) break
    if (VOID_ELEMENTS.has(tag.name.toLowerCase())) continue
    if (tag.closing) {
      // Pop to the matching name: unclosed markup must not unwind the stack
      // past the element that actually owns this position.
      const at = stack.map((e) => e.name).lastIndexOf(tag.name)
      if (at !== -1) stack.length = at
    } else if (!tag.selfClosing) {
      stack.push({ name: tag.name, hidden: /\saria-hidden\s*=\s*"true"/.test(tag.text) })
    }
  }
  return stack.some((e) => e.hidden)
}

/**
 * The text a button shows between its tags, with nested markup removed.
 *
 * `<Button icon="pi pi-plus">Neu anlegen</Button>` is an icon button with a
 * visible, announced label — judging it by its opening tag alone blocked a
 * commit for a button that says exactly what it does. A `{{ expression }}`
 * counts: it renders as text. An icon element on its own does not.
 */
function slotTextOf(source, tag) {
  if (tag.selfClosing) return ''
  let depth = 1
  for (const next of tagsIn(source.slice(tag.end))) {
    if (next.name !== tag.name || next.selfClosing) continue
    depth += next.closing ? -1 : 1
    if (depth === 0) {
      const inner = source.slice(tag.end, tag.end + next.start)
      return inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

function findUnlabelled(source) {
  const found = []
  for (const tag of tagsOf(source, 'Button')) {
    const { start, text } = tag
    const attrs = attributesOf(text)
    const hasIcon = attrs.has('icon') || attrs.has(':icon')
    const hasLabel = attrs.has('label') || attrs.has(':label')
    if (!hasIcon || hasLabel) continue
    if (slotTextOf(source, tag)) continue
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
