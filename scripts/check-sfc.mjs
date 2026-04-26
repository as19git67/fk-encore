#!/usr/bin/env node
/**
 * Fast SFC parse check for the frontend.
 *
 * Walks every `*.vue` file under `frontend/src` and runs both
 * `@vue/compiler-sfc.parse` (block extraction) and `compileTemplate`
 * (the same template parser Vite uses at build time). This catches a
 * specific class of bug that `vue-tsc --noEmit` happily lets through:
 * Vue's template attribute parser does not accept multi-statement
 * expressions split across lines inside a quoted attribute value, and
 * Volar's TS-channel is permissive enough to silently accept what Vite
 * later refuses.
 *
 * Designed for a pre-commit hook: typically runs in 1–2 s on the whole
 * repo and never starts a bundler.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const FRONTEND_DIR = join(REPO_ROOT, 'frontend')
const FRONTEND_SRC = join(FRONTEND_DIR, 'src')

// `@vue/compiler-sfc` only lives under frontend/node_modules — there is no
// reason to install it twice. Resolve it from the frontend package via a
// scoped `require` so the root invocation does not need its own copy.
const fRequire = createRequire(join(FRONTEND_DIR, 'package.json'))
const { parse, compileTemplate } = fRequire('@vue/compiler-sfc')

/** @type {string[]} */
const failures = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (entry.endsWith('.vue')) checkFile(full)
  }
}

function checkFile(file) {
  const src = readFileSync(file, 'utf8')
  const sfc = parse(src, { filename: file })
  if (sfc.errors.length > 0) {
    for (const err of sfc.errors) {
      failures.push(formatErr(file, err))
    }
    return
  }
  if (!sfc.descriptor.template) return
  // We only need to know whether the template *parses*. id is required
  // for scope hashing but the value is irrelevant for an error check.
  const tpl = compileTemplate({
    source: sfc.descriptor.template.content,
    filename: file,
    id: 'check-sfc',
    // Use the same compiler options Vite/Vue use by default. Anything
    // stricter would risk false positives.
  })
  if (tpl.errors && tpl.errors.length > 0) {
    for (const err of tpl.errors) {
      failures.push(formatErr(file, err))
    }
  }
}

function formatErr(file, err) {
  const loc = err.loc?.start
  const where = loc ? `:${loc.line}:${loc.column}` : ''
  const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file
  return `${rel}${where} — ${err.message ?? err}`
}

walk(FRONTEND_SRC)

if (failures.length > 0) {
  console.error('SFC parse check FAILED:')
  for (const f of failures) console.error('  ' + f)
  console.error(`\n${failures.length} error(s).`)
  process.exit(1)
}
console.log('SFC parse check OK.')
