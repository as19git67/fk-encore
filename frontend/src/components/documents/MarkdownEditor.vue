<script setup lang="ts">
/**
 * Writes Markdown with a formatted preview beside it — or, below `md`, behind
 * a switch between "Schreiben" and "Vorschau". The toolbar inserts the syntax
 * for whoever does not know it; Strg/Cmd+B, +I and +K do the same from the
 * keyboard, Strg/Cmd+S asks the page to save.
 */
import { nextTick, ref } from 'vue'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import MarkdownView from './MarkdownView.vue'
import { useAtLeast } from '../../composables/useBreakpoint'
import { insertBlock, insertParagraphs, prefixLines, wrapSelection, type InsertPlace, type TextEdit } from '../../utils/markdown'

const model = defineModel<string>({ required: true })
const props = defineProps<{ placeholder?: string; ariaLabel?: string }>()
const emit = defineEmits<{ save: [] }>()

const wide = useAtLeast('md')
const mode = ref<'write' | 'preview'>('write')
const modeOptions = [
  { label: 'Schreiben', value: 'write' },
  { label: 'Vorschau', value: 'preview' },
]
const textarea = ref<HTMLTextAreaElement | null>(null)

function apply(change: (edit: TextEdit) => TextEdit) {
  const el = textarea.value
  if (!el) return
  const next = change({ text: model.value, start: el.selectionStart, end: el.selectionEnd })
  model.value = next.text
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(next.start, next.end)
  })
}

interface Tool {
  /** A PrimeIcons class, or a letter for what PrimeIcons has no symbol for. */
  icon?: string
  glyph?: string
  label: string
  run: () => void
}

const TABLE = '| Spalte 1 | Spalte 2 |\n| --- | --- |\n| Wert | Wert |'

const tools: Tool[][] = [
  [
    { glyph: 'H', label: 'Überschrift', run: () => apply((e) => prefixLines(e, () => '## ', /^#{1,6} /)) },
    { glyph: 'B', label: 'Fett (Strg+B)', run: () => apply((e) => wrapSelection(e, '**')) },
    { glyph: 'I', label: 'Kursiv (Strg+I)', run: () => apply((e) => wrapSelection(e, '*')) },
    { glyph: 'S', label: 'Durchgestrichen', run: () => apply((e) => wrapSelection(e, '~~')) },
  ],
  [
    { icon: 'pi pi-list', label: 'Aufzählung', run: () => apply((e) => prefixLines(e, () => '- ', /^[-*+] (?!\[[ xX]\] )/)) },
    { icon: 'pi pi-sort-numeric-down', label: 'Nummerierte Liste', run: () => apply((e) => prefixLines(e, (i) => `${i + 1}. `, /^\d+\. /)) },
    { icon: 'pi pi-check-square', label: 'Aufgabenliste', run: () => apply((e) => prefixLines(e, () => '- [ ] ', /^[-*+] \[[ xX]\] /)) },
    { icon: 'pi pi-comment', label: 'Zitat', run: () => apply((e) => prefixLines(e, () => '> ', /^> ?/)) },
  ],
  [
    { icon: 'pi pi-link', label: 'Link (Strg+K)', run: insertLink },
    { icon: 'pi pi-code', label: 'Code', run: () => apply((e) => wrapSelection(e, '`', '`', 'Code')) },
    { icon: 'pi pi-table', label: 'Tabelle', run: () => apply((e) => insertBlock(e, TABLE)) },
    { icon: 'pi pi-arrows-h', label: 'Trennlinie', run: () => apply((e) => insertBlock(e, '---')) },
  ],
]

function insertLink() {
  apply((e) => {
    const selected = e.text.slice(e.start, e.end) || 'Linktext'
    const before = e.text.slice(0, e.start)
    const inserted = `[${selected}](https://)`
    // Select the address, which is what has to be typed next.
    const urlStart = before.length + selected.length + 3
    return { text: before + inserted + e.text.slice(e.end), start: urlStart, end: urlStart + 8 }
  })
}

/**
 * Puts text from outside (the assistant) into the document: at the cursor,
 * in place of the whole text, or after it. What was inserted ends up
 * selected, so it is easy to see and to take back with one delete.
 */
function insertText(text: string, where: InsertPlace) {
  apply((e) => insertParagraphs(e, text, where))
}

defineExpose({ insertText })

function onKeydown(ev: KeyboardEvent) {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return
  const key = ev.key.toLowerCase()
  if (key === 'b') apply((e) => wrapSelection(e, '**'))
  else if (key === 'i') apply((e) => wrapSelection(e, '*'))
  else if (key === 'k') insertLink()
  else if (key === 's') emit('save')
  else return
  ev.preventDefault()
}
</script>

<template>
  <div class="md-editor" :class="{ 'md-editor--wide': wide }">
    <div class="md-editor__bar">
      <div v-if="wide || mode === 'write'" class="md-editor__tools" role="toolbar" aria-label="Formatierung">
        <div v-for="(group, gi) in tools" :key="gi" class="md-editor__group">
          <Button
            v-for="tool in group"
            :key="tool.label"
            :icon="tool.icon"
            :label="tool.glyph"
            :class="tool.glyph ? `md-editor__glyph md-editor__glyph--${tool.glyph}` : undefined"
            text
            rounded
            size="small"
            :aria-label="tool.label"
            v-tooltip.bottom="tool.label"
            @click="tool.run"
          />
        </div>
      </div>
      <SelectButton
        v-if="!wide"
        v-model="mode"
        :options="modeOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        size="small"
        class="md-editor__mode"
      />
    </div>

    <div class="md-editor__panes">
      <textarea
        v-show="wide || mode === 'write'"
        ref="textarea"
        v-model="model"
        class="md-editor__input"
        :placeholder="props.placeholder"
        :aria-label="props.ariaLabel ?? 'Text in Markdown'"
        spellcheck="true"
        @keydown="onKeydown"
      />
      <section
        v-if="wide || mode === 'preview'"
        class="md-editor__preview"
        aria-label="Vorschau"
      >
        <MarkdownView v-if="model.trim()" :source="model" />
        <p v-else class="md-editor__empty">Die Vorschau erscheint, sobald du schreibst.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.md-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  flex: 1 1 auto;
}
.md-editor__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.md-editor__tools {
  display: flex;
  flex-wrap: wrap;
  column-gap: var(--space-4);
}
.md-editor__group {
  display: flex;
}
.md-editor__glyph {
  min-width: 2.25rem;
}
.md-editor__glyph :deep(.p-button-label) {
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 400;
}
.md-editor__glyph--H :deep(.p-button-label),
.md-editor__glyph--B :deep(.p-button-label) {
  font-weight: 700;
}
.md-editor__glyph--I :deep(.p-button-label) {
  font-style: italic;
}
.md-editor__glyph--S :deep(.p-button-label) {
  text-decoration: line-through;
}
.md-editor__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  flex: 1 1 auto;
  min-height: 24rem;
}
.md-editor--wide .md-editor__panes {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.md-editor__input,
.md-editor__preview {
  min-height: 24rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  padding: var(--space-3);
}
.md-editor__input {
  width: 100%;
  resize: vertical;
  color: var(--p-text-color);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--text-sm);
  line-height: 1.55;
}
.md-editor__input:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.md-editor__preview {
  overflow: auto;
}
.md-editor__empty {
  margin: 0;
  color: var(--p-text-muted-color);
}
</style>
