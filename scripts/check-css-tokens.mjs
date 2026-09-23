#!/usr/bin/env node
/**
 * Colour audit for the frontend's own styles (issue #1281).
 *
 * The app follows the active PrimeVue theme, light or dark, and it can only
 * do that if its styles ask the theme rather than name a colour themselves.
 * Three habits break that, and this check refuses them:
 *
 *   1. `--p-surface-50` … `--p-surface-950` — the surface scale is a ladder of
 *      fixed brightnesses. Picking a rung means picking "light grey", which
 *      turns into "light grey on a dark page" the moment the theme flips.
 *      `--p-content-background`, `--p-content-hover-background` and
 *      `--p-content-border-color` are the same surfaces, asked for by role.
 *   2. A hex colour (`#eee`, `#1f2937`) — same problem, spelled out.
 *   3. An opaque `rgb(…)` — likewise. An `rgba(…)` *with* alpha is fine: a
 *      translucent overlay darkens or lightens whatever is underneath, so it
 *      works in both themes. That is the escape hatch CLAUDE.md names for
 *      the cases the theme has no variable for.
 *   4. A PrimeVue 3 variable name (`--surface-border`, `--text-color-secondary`,
 *      `--blue-100`). PrimeVue 4 prefixes everything with `--p-`, so the old
 *      names resolve to nothing — the rule silently does not apply, or the
 *      hard-coded fallback behind it renders instead. Neither follows the
 *      theme, and neither looks broken enough to notice.
 *
 * It also refuses a literal `font-size` (issue #1281): sizes come from the
 * type scale in style.css (`--text-xs` … `--text-7xl`), so a size is a
 * decision about role and not a number somebody typed. Relative units (`em`,
 * `%`, `inherit`) are untouched — they scale with their context by design.
 *
 * Only `<style>` blocks are read: a hex inside an inline SVG, a chart's data
 * colours in a script or a colour typed by the user are not theme styling.
 *
 * Runs in the pre-commit hook, so it stays a file walk and a few regexes —
 * no bundler, no dependencies.
 *
 * Usage:
 *   node scripts/check-css-tokens.mjs            # every file
 *   node scripts/check-css-tokens.mjs a.vue b.css  # only those (hook mode)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const FRONTEND_SRC = join(REPO_ROOT, 'frontend', 'src')

/**
 * Files that may name colours outright, each for a reason that is not
 * "nobody looked at it yet". Keep this list short and justified.
 */
const ALLOWED = new Map([
  [
    'frontend/src/style.css',
    'defines the theme bridge itself: the tokens every other file then asks for',
  ],
])

/** A line ending in this comment is exempt — say why in the same breath. */
const INLINE_EXEMPTION = /\/\*\s*audit-ok:/

/**
 * A `name(…)` call from `start` to its own closing bracket, brackets
 * balanced, plus what stands between them.
 *
 * `[^)]*` used to do this, and stopped at the first `)` — which in
 * `rgba(var(--p-primary-500-rgb), 0.35)` is the one closing `var(`. The
 * alpha was never seen, so the translucent overlay CLAUDE.md prescribes was
 * refused as opaque and the hook steered people towards typing the channel
 * numbers instead.
 */
function balancedCall(text, start) {
  const open = text.indexOf('(', start)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) {
      return { text: text.slice(start, i + 1), inner: text.slice(open + 1, i) }
    }
  }
  return null
}

/** Split on `sep`, ignoring any that sits inside a nested call. */
function splitTop(inner, sep) {
  const parts = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      parts.push(inner.slice(from, i))
      from = i + 1
    }
  }
  parts.push(inner.slice(from))
  return parts
}

/**
 * The alpha a colour carries, as written, or null when it has none.
 *
 * Three shapes reach here: `rgb(r g b / a)` puts it behind a slash,
 * `rgba(r, g, b, a)` makes it the fourth part, and
 * `rgba(var(--channels), a)` bundles the channels into one variable and
 * leaves the alpha as the second. Anything else has no alpha and is opaque.
 */
function alphaOf(inner) {
  const slashed = splitTop(inner, '/')
  if (slashed.length === 2) return slashed[1].trim() || null
  const parts = splitTop(inner, ',')
  if (parts.length === 4 || parts.length === 2) return parts[parts.length - 1].trim() || null
  return null
}

const RULES = [
  {
    id: 'surface-scale',
    // --p-surface-0 … --p-surface-950
    pattern: /--p-surface-\d+/g,
    message: 'fixed brightness from the surface scale — ask by role (--p-content-background, …)',
  },
  {
    id: 'hex-colour',
    // #abc, #aabbcc, #aabbccdd — but not an id selector or a URL fragment.
    pattern: /(?<![\w"'(])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])/g,
    message: 'hard-coded colour — use a --p-* variable, or rgba() when the theme has none',
  },
  {
    id: 'opaque-rgb',
    // The call itself; `extend` below takes it to its matching bracket.
    pattern: /\brgba?\(/g,
    extend: balancedCall,
    message: 'opaque colour — a translucent rgba() overlay works in both themes, this does not',
    /**
     * `rgba(0, 0, 0, 0.35)` and `rgb(0 0 0 / 45%)` are the documented escape
     * hatch — both spellings, since CSS takes either. An alpha of `1` (or
     * none at all) is an opaque colour wearing the other syntax.
     */
    accepts: (_match, inner) => {
      const raw = alphaOf(inner)
      if (!raw) return false
      const alpha = Number.parseFloat(raw)
      if (!Number.isFinite(alpha)) return false
      return raw.includes('%') ? alpha < 100 : alpha < 1
    },
  },
  {
    id: 'dead-surface-name',
    /*
     * `--p-surface-card`, `--p-surface-ground`, `--p-surface-section` and
     * their kin wear the PrimeVue 4 prefix and look current, but the theme
     * defines no such tokens — only the numbered scale (which `surface-scale`
     * above refuses) and the `--p-content-*` semantics. So the declaration
     * resolves to nothing and the element simply has no background: it looked
     * right on a white page and would have looked "right" on a dark one too,
     * for the wrong reason. Twenty-one of them sat in the tree, including the
     * PDF viewer's toolbar, which a sticky header then showed through.
     */
    pattern: /--p-surface-(?:card|ground|section|overlay|hover|border(?:-color)?|[a-d])\b/g,
    message:
      'no such token — PrimeVue 4 has --p-content-background / -hover-background / -border-color',
  },
  {
    id: 'legacy-token',
    // PrimeVue 3's unprefixed vocabulary. `--text-xs` … `--text-7xl` and
    // `--focus-ring*` are this app's own tokens, so `--text-color` and
    // `--text-color-secondary` are named exactly rather than by prefix.
    pattern:
      /--(?:surface-(?:border|card|ground|hover|section|overlay|[a-d])|text-color(?:-secondary)?|primary-color(?:-text)?|highlight-(?:bg|text-color)|(?:red|green|blue|yellow|orange|purple|pink|cyan|teal|indigo|gray|bluegray)-\d+)\b/g,
    message: 'PrimeVue 3 name — PrimeVue 4 prefixes everything with --p-, so this resolves to nothing',
  },
  {
    id: 'font-size-literal',
    // `font-size: 0.85rem` / `13px`. `em`, `%`, `inherit`, `clamp()` and a
    // var() are all fine: they are relative, or already a token.
    pattern: /font-size:\s*(\d*\.?\d+(?:rem|px|pt))/g,
    message: 'literal size — name a rung of the type scale (--text-xs … --text-7xl)',
  },
]

/**
 * Blank out what is not styling but lives in the same block: comments (where
 * "#1272" is an issue, not a colour) and quoted strings (a data-URI SVG
 * carries its own colours). Replaced space for space so the reported line
 * numbers stay true.
 */
function maskNonStyle(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m.replace(/[^\n]/g, ' '))
}

/** Every `<style>` block of an SFC, or the whole file for plain CSS. */
function styleRegions(source, file) {
  if (!file.endsWith('.vue')) return [{ start: 0, text: maskNonStyle(source) }]
  const regions = []
  const open = /<style\b[^>]*>/g
  let match
  while ((match = open.exec(source)) !== null) {
    const start = match.index + match[0].length
    const end = source.indexOf('</style>', start)
    if (end === -1) break
    regions.push({ start, text: maskNonStyle(source.slice(start, end)) })
    open.lastIndex = end
  }
  return regions
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function findViolations(file, source) {
  const found = []
  for (const region of styleRegions(source, file)) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(region.text)) !== null) {
        // A rule whose construct can nest brackets says where it really ends.
        const whole = rule.extend?.(region.text, match.index)
        const text = whole?.text ?? match[0]
        const inner = whole ? whole.inner : match[1] ?? ''
        if (rule.accepts?.(text, inner)) continue
        const absolute = region.start + match.index
        const line = lineOf(source, absolute)
        const lineText = source.split('\n')[line - 1] ?? ''
        if (INLINE_EXEMPTION.test(lineText)) continue
        found.push({ line, rule: rule.id, text, message: rule.message })
      }
    }
  }
  return found.sort((a, b) => a.line - b.line)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(vue|css)$/.test(entry)) out.push(full)
  }
  return out
}

const args = process.argv.slice(2)
// `resolve` so both spellings work: the repo-relative paths the hook passes
// and an absolute path from an editor or a test.
const files = (args.length ? args.map((a) => resolve(process.cwd(), a)) : walk(FRONTEND_SRC))
  .filter((f) => /\.(vue|css)$/.test(f))

let offending = 0
for (const file of files) {
  const rel = relative(REPO_ROOT, file).split('\\').join('/')
  if (ALLOWED.has(rel)) continue
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue // staged-but-deleted, or a path that no longer exists
  }
  const violations = findViolations(file, source)
  if (violations.length === 0) continue
  offending++
  for (const v of violations) {
    console.error(`${rel}:${v.line}  ${v.text}  — ${v.message}`)
  }
}

if (offending > 0) {
  console.error(
    `\n${offending} file(s) name values the theme or the scale should have chosen.\n` +
      'Use a semantic --p-* variable, or rgba() with alpha where none fits;\n' +
      'sizes come from --text-xs … --text-7xl.\n' +
      'A line that genuinely has to keep its value ends in /* audit-ok: why */.',
  )
  process.exit(1)
}
console.log(`Style audit clean (${files.length} files).`)
