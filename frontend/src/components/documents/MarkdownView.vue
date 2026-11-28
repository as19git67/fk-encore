<script setup lang="ts">
/**
 * Shows the Markdown of a text document formatted (editor preview and detail
 * page). Built as a tree from the tokens in `utils/markdown.ts`, never through
 * v-html: what a document contains is shown, not executed or loaded.
 *
 * Images stay a placeholder, with one exception: a page that passes
 * `mediaUrl` (the house handbook) shows `![…](media:123)` as that photo,
 * loaded through the app's own authenticated endpoint. Any other image source
 * — a web address above all — is never loaded.
 */
import { computed, h, type VNodeChild } from 'vue'
import type { Token, Tokens } from 'marked'
import { calloutOf, decodeEntities, markdownTokens, mediaIdOf, safeHref } from '../../utils/markdown'

const props = defineProps<{
  source: string
  /** Where the photo `media:<id>` is loaded from; without it images stay a placeholder. */
  mediaUrl?: (id: number) => string
}>()

const tokens = computed(() => markdownTokens(props.source))

function inline(list: readonly Token[] | undefined): VNodeChild[] {
  return (list ?? []).map(inlineToken)
}

function inlineToken(t: Token): VNodeChild {
  switch (t.type) {
    case 'strong':
      return h('strong', inline((t as Tokens.Strong).tokens))
    case 'em':
      return h('em', inline((t as Tokens.Em).tokens))
    case 'del':
      return h('del', inline((t as Tokens.Del).tokens))
    case 'codespan':
      return h('code', decodeEntities((t as Tokens.Codespan).text))
    case 'br':
      return h('br')
    case 'link': {
      const link = t as Tokens.Link
      const href = safeHref(link.href)
      const children = inline(link.tokens)
      return href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children)
        : h('span', children)
    }
    case 'image': {
      const image = t as Tokens.Image
      const mediaId = props.mediaUrl ? mediaIdOf(image.href) : null
      if (mediaId !== null && props.mediaUrl) {
        const alt = decodeEntities(image.text)
        return h('figure', { class: 'md-figure' }, [
          h('img', { src: props.mediaUrl(mediaId), alt, loading: 'lazy', class: 'md-photo' }),
          alt ? h('figcaption', alt) : null,
        ])
      }
      return h('em', { class: 'md-image' }, `[Bild: ${image.text || 'ohne Beschreibung'}]`)
    }
    case 'text': {
      const text = t as Tokens.Text
      return text.tokens?.length ? inline(text.tokens) : decodeEntities(text.text)
    }
    default:
      // escape, raw html and anything newer: the characters as written.
      return decodeEntities((t as { text?: string }).text ?? t.raw)
  }
}

function blocks(list: readonly Token[]): VNodeChild[] {
  return list.map(block)
}

function block(t: Token): VNodeChild {
  switch (t.type) {
    case 'space':
    case 'def':
      return null
    case 'heading': {
      const heading = t as Tokens.Heading
      // The page's own title is the one h1; a document's headings sit below it.
      const level = Math.min(heading.depth + 1, 6)
      return h(`h${level}`, { class: `md-h md-h${heading.depth}` }, inline(heading.tokens))
    }
    case 'paragraph':
      return h('p', inline((t as Tokens.Paragraph).tokens))
    case 'text': {
      const text = t as Tokens.Text
      return text.tokens?.length ? inline(text.tokens) : decodeEntities(text.text)
    }
    case 'blockquote': {
      const quote = t as Tokens.Blockquote
      const callout = calloutOf(quote.text)
      if (!callout) return h('blockquote', blocks(quote.tokens))
      // `> [!WARNING]` — a handbook's "turn off the water first" has to stand
      // out from the steps around it.
      const warning = callout.kind === 'warning'
      return h('div', { class: ['md-callout', `md-callout--${callout.kind}`], role: 'note' }, [
        h('p', { class: 'md-callout-title' }, [
          h('i', { class: warning ? 'pi pi-exclamation-triangle' : 'pi pi-info-circle', 'aria-hidden': 'true' }),
          warning ? ' Achtung' : ' Hinweis',
        ]),
        ...blocks(markdownTokens(callout.body)),
      ])
    }
    case 'code':
      return h('pre', h('code', (t as Tokens.Code).text))
    case 'hr':
      return h('hr')
    case 'html':
      return h('pre', { class: 'md-html' }, (t as Tokens.HTML).text)
    case 'list': {
      const list = t as Tokens.List
      const items = list.items.map((item) =>
        h('li', { class: item.task ? 'md-task' : undefined }, [
          item.task
            ? h('input', {
                type: 'checkbox',
                checked: !!item.checked,
                disabled: true,
                'aria-label': item.checked ? 'Erledigt' : 'Offen',
              })
            : null,
          ...blocks(item.tokens.filter((c) => c.type !== 'checkbox')),
        ]),
      )
      const start = typeof list.start === 'number' && list.start !== 1 ? list.start : undefined
      return list.ordered ? h('ol', { start }, items) : h('ul', items)
    }
    case 'table': {
      const table = t as Tokens.Table
      const align = (i: number) => (table.align[i] ? { textAlign: table.align[i]! } : undefined)
      return h('div', { class: 'md-table' }, [
        h('table', [
          h('thead', h('tr', table.header.map((c, i) => h('th', { style: align(i) }, inline(c.tokens))))),
          h('tbody', table.rows.map((row) =>
            h('tr', row.map((c, i) => h('td', { style: align(i) }, inline(c.tokens)))),
          )),
        ]),
      ])
    }
    default:
      return h('p', t.raw)
  }
}

const Body = () => blocks(tokens.value)
</script>

<template>
  <div class="md-view">
    <Body />
  </div>
</template>

<style>
/* Unscoped: the tree is built in a render function. Every rule hangs off
   `.md-view`, so nothing leaks out. */
.md-view {
  color: var(--p-text-color);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.md-view > :first-child {
  margin-top: 0;
}
.md-view p,
.md-view ul,
.md-view ol,
.md-view blockquote,
.md-view pre,
.md-view .md-table {
  margin: 0 0 var(--space-3);
}
.md-view .md-h {
  margin: var(--space-4) 0 var(--space-2);
  line-height: 1.3;
}
.md-view .md-h1 { font-size: var(--text-2xl); }
.md-view .md-h2 { font-size: var(--text-xl); }
.md-view .md-h3 { font-size: var(--text-lg); }
.md-view .md-h4,
.md-view .md-h5,
.md-view .md-h6 { font-size: var(--text-base); }
.md-view ul,
.md-view ol {
  padding-left: 1.5em;
}
.md-view li > ul,
.md-view li > ol,
.md-view li > p {
  margin-bottom: 0;
}
.md-view li.md-task {
  list-style: none;
  margin-left: -1.4em;
}
.md-view li.md-task > input {
  margin-right: 0.4em;
}
.md-view blockquote {
  padding-left: var(--space-3);
  border-left: 3px solid var(--p-content-border-color);
  color: var(--p-text-muted-color);
}
.md-view code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  background: rgba(127, 127, 127, 0.14);
  border-radius: 4px;
  padding: 0.05em 0.3em;
}
.md-view pre {
  background: rgba(127, 127, 127, 0.1);
  border-radius: 6px;
  padding: var(--space-2) var(--space-3);
  overflow-x: auto;
  white-space: pre;
}
.md-view pre code {
  background: none;
  padding: 0;
}
.md-view pre.md-html {
  white-space: pre-wrap;
}
.md-view hr {
  border: 0;
  border-top: 1px solid var(--p-content-border-color);
  margin: var(--space-4) 0;
}
.md-view a {
  color: var(--p-primary-color);
}
.md-view a:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.md-view .md-table {
  overflow-x: auto;
  padding: var(--focus-ring-reach);
  margin-left: calc(-1 * var(--focus-ring-reach));
  margin-right: calc(-1 * var(--focus-ring-reach));
}
.md-view table {
  border-collapse: collapse;
  min-width: 50%;
}
.md-view th,
.md-view td {
  border: 1px solid var(--p-content-border-color);
  padding: var(--space-1) var(--space-2);
  vertical-align: top;
}
.md-view th {
  background: var(--p-content-hover-background);
  text-align: left;
}
.md-view .md-callout {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-left: 4px solid var(--p-text-muted-color);
  border-radius: 6px;
  background: var(--p-content-hover-background);
}
.md-view .md-callout--warning {
  border-left-color: var(--p-orange-500);
  background: color-mix(in srgb, var(--p-orange-500) 12%, transparent);
}
.md-view .md-callout > :last-child {
  margin-bottom: 0;
}
.md-view .md-callout-title {
  margin: 0 0 var(--space-1);
  font-weight: 600;
}
.md-view .md-callout--warning .md-callout-title i {
  color: var(--p-orange-500);
}
.md-view .md-callout--note .md-callout-title i {
  color: var(--p-primary-color);
}
.md-view .md-image {
  color: var(--p-text-muted-color);
}
.md-view .md-figure {
  margin: var(--space-2) 0;
}
.md-view .md-photo {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  height: auto;
  border-radius: 6px;
}
.md-view .md-figure figcaption {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  margin-top: var(--space-1);
}
</style>
