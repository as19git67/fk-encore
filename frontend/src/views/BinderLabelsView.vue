<script setup lang="ts">
/**
 * Label › Ordneretiketten: an A4 sheet with four wide spine labels of
 * 192 × 61 mm (REX, Avery Zweckform L4761), printed on an ordinary printer.
 *
 * Each label gets a field with Markdown; the preview beside it is drawn from
 * the same layout the server prints (`utils/binderLayout.ts`). A filled page
 * is saved under a name and opened again later from the list; the open page
 * stands in the URL (`?seite=<id>`), so a reload keeps it. The PDF is made
 * from what the page shows, saved or not (label/binder.ts).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import Textarea from 'primevue/textarea'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import BinderSheetPreview from '../components/label/BinderSheetPreview.vue'
import { useAuthStore } from '../stores/auth'
import { useBinderLayout } from '../composables/useBinderLayout'
import { BINDER_SHEET, type BinderAlign, type BinderDirection } from '../utils/binderLayout'
import { prefixLines, wrapSelection, type TextEdit } from '../utils/markdown'
import {
  createBinderPage,
  deleteBinderPage,
  downloadBinderPdf,
  getBinderPage,
  listBinderPages,
  updateBinderPage,
  type BinderPage,
  type BinderPageInput,
  type BinderPageSummary,
} from '../api/label'

const auth = useAuthStore()
const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const canPrint = computed(() => auth.hasPermission('label.print'))

const EMPTY = (): string[] => Array.from({ length: BINDER_SHEET.labels }, () => '')

const pages = ref<BinderPageSummary[]>([])
const loaded = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)
const saving = ref(false)
const downloading = ref<'pdf' | 'test' | null>(null)

const pageId = ref<number | null>(null)
const name = ref('')
const labels = ref<string[]>(EMPTY())
const direction = ref<BinderDirection>('across')
const align = ref<BinderAlign>('center')
const view = ref<'sheet' | 'spine'>('sheet')
const active = ref<number | null>(null)

/** What was last saved or opened, to tell whether there are changes. */
const savedState = ref(snapshot())

function snapshot(): string {
  return JSON.stringify({ name: name.value.trim(), labels: labels.value, direction: direction.value, align: align.value })
}
const dirty = computed(() => snapshot() !== savedState.value)
const isBlank = computed(() => labels.value.every((l) => !l.trim()) && !name.value.trim())

const { layouts } = useBinderLayout(labels, direction, align)
const overflowing = computed(() => layouts.value.map((l) => l.overflow))

const DIRECTION_OPTIONS = [
  { label: 'Quer', value: 'across', hint: 'Stehend lesbar, quer über den Rücken' },
  { label: 'Längs', value: 'along', hint: 'Entlang des Rückens' },
]
const ALIGN_OPTIONS = [
  { label: 'Zentriert', value: 'center', icon: 'pi pi-align-center' },
  { label: 'Links', value: 'left', icon: 'pi pi-align-left' },
]
const VIEW_OPTIONS = [
  { label: 'Seite', value: 'sheet' },
  { label: 'Am Ordner', value: 'spine' },
]

const pageOptions = computed(() =>
  pages.value.map((p) => ({ label: p.name, value: p.id, excerpt: p.excerpt })),
)

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function input(): BinderPageInput {
  return { name: name.value.trim(), labels: [...labels.value], direction: direction.value, align: align.value }
}

function apply(page: BinderPage | null) {
  pageId.value = page?.id ?? null
  name.value = page?.name ?? ''
  labels.value = page ? [...page.labels] : EMPTY()
  direction.value = page?.direction ?? 'across'
  align.value = page?.align ?? 'center'
  savedState.value = snapshot()
  const seite = page ? String(page.id) : undefined
  if (route.query.seite !== seite) {
    void router.replace({ query: { ...route.query, seite } })
  }
}

async function refreshList() {
  pages.value = (await listBinderPages()).pages
}

async function load() {
  try {
    await refreshList()
    const wanted = Number(route.query.seite)
    if (Number.isInteger(wanted) && wanted > 0) {
      try {
        apply(await getBinderPage(wanted))
      } catch {
        apply(null)
      }
    }
  } catch (e) {
    error.value = message(e, 'Die gespeicherten Seiten konnten nicht geladen werden')
  } finally {
    loaded.value = true
  }
}

onMounted(load)

/** Asks before unsaved changes are thrown away; resolves to whether to go on. */
function confirmDiscard(): Promise<boolean> {
  if (!dirty.value || isBlank.value) return Promise.resolve(true)
  return new Promise((resolve) => {
    confirm.require({
      header: 'Änderungen verwerfen?',
      message: pageId.value
        ? `Die Änderungen an „${name.value.trim() || 'dieser Seite'}“ sind nicht gespeichert.`
        : 'Diese Seite ist noch nicht gespeichert.',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Abbrechen',
      acceptLabel: 'Verwerfen',
      acceptClass: 'p-button-danger',
      accept: () => resolve(true),
      reject: () => resolve(false),
      onHide: () => resolve(false),
    })
  })
}

const selectedPageId = ref<number | null>(null)
watch(pageId, (id) => (selectedPageId.value = id), { immediate: true })

async function openPage(id: number | null) {
  if (id === null || id === pageId.value) return
  if (!(await confirmDiscard())) {
    selectedPageId.value = pageId.value
    return
  }
  error.value = null
  info.value = null
  try {
    apply(await getBinderPage(id))
  } catch (e) {
    selectedPageId.value = pageId.value
    error.value = message(e, 'Die Seite konnte nicht geöffnet werden')
  }
}

async function newPage() {
  if (!(await confirmDiscard())) return
  error.value = null
  info.value = null
  apply(null)
  await nextTick()
  focusLabel(0)
}

const nameInput = ref<{ $el?: HTMLElement } | null>(null)

function focusName() {
  const el = nameInput.value?.$el as HTMLInputElement | undefined
  el?.focus()
}

async function save(asNew = false) {
  error.value = null
  info.value = null
  const page = input()
  if (!page.name) {
    error.value = 'Bitte der Seite einen Namen geben.'
    focusName()
    return
  }
  saving.value = true
  try {
    const saved = pageId.value && !asNew ? await updateBinderPage(pageId.value, page) : await createBinderPage(page)
    apply(saved)
    await refreshList()
    info.value = `„${saved.name}“ gespeichert.`
  } catch (e) {
    error.value = message(e, 'Die Seite konnte nicht gespeichert werden')
  } finally {
    saving.value = false
  }
}

function remove() {
  const id = pageId.value
  if (!id) return
  const current = pages.value.find((p) => p.id === id)?.name ?? name.value
  confirm.require({
    header: 'Seite löschen',
    message: `Die gespeicherte Seite „${current}“ löschen? Die Etiketten bleiben zum Weiterbearbeiten offen.`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteBinderPage(id)
        await refreshList()
        pageId.value = null
        savedState.value = ''
        void router.replace({ query: { ...route.query, seite: undefined } })
        info.value = `„${current}“ gelöscht.`
      } catch (e) {
        error.value = message(e, 'Die Seite konnte nicht gelöscht werden')
      }
    },
  })
}

async function download(outlines: boolean) {
  error.value = null
  downloading.value = outlines ? 'test' : 'pdf'
  try {
    await downloadBinderPdf({ ...input(), outlines })
  } catch (e) {
    error.value = message(e, 'Das PDF konnte nicht erstellt werden')
  } finally {
    downloading.value = null
  }
}

// ---------- Fields ----------

const fields = ref<(HTMLTextAreaElement | null)[]>([])

function fieldEl(index: number): HTMLTextAreaElement | null {
  const ref = fields.value[index] as unknown as { $el?: HTMLTextAreaElement } | HTMLTextAreaElement | null
  if (!ref) return null
  return ref instanceof HTMLElement ? (ref as HTMLTextAreaElement) : (ref.$el ?? null)
}

function focusLabel(index: number) {
  const el = fieldEl(index)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function edit(index: number, change: (e: TextEdit) => TextEdit) {
  const el = fieldEl(index)
  const text = labels.value[index] ?? ''
  const next = change({ text, start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length })
  labels.value[index] = next.text
  void nextTick(() => {
    el?.focus()
    el?.setSelectionRange(next.start, next.end)
  })
}

interface Tool {
  glyph: string
  label: string
  run: (index: number) => void
}

const TOOLS: Tool[] = [
  { glyph: 'H1', label: 'Große Überschrift', run: (i) => edit(i, (e) => prefixLines(e, () => '# ', /^#{1,6} /)) },
  { glyph: 'H2', label: 'Mittlere Überschrift', run: (i) => edit(i, (e) => prefixLines(e, () => '## ', /^#{1,6} /)) },
  { glyph: 'B', label: 'Fett', run: (i) => edit(i, (e) => wrapSelection(e, '**')) },
  { glyph: 'I', label: 'Kursiv', run: (i) => edit(i, (e) => wrapSelection(e, '*')) },
  { glyph: '•', label: 'Aufzählung', run: (i) => edit(i, (e) => prefixLines(e, () => '- ', /^[-*+] /)) },
]

function onKeydown(index: number, event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (key === 'b') {
    event.preventDefault()
    edit(index, (e) => wrapSelection(e, '**'))
  } else if (key === 'i') {
    event.preventDefault()
    edit(index, (e) => wrapSelection(e, '*'))
  } else if (key === 's') {
    event.preventDefault()
    void save()
  }
}

// ---------- Leaving with changes ----------

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value && !isBlank.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

onBeforeRouteLeave(async (to) => {
  if (to.name === route.name) return true
  return confirmDiscard()
})

const title = computed(() => (pageId.value ? name.value.trim() || 'Ordneretiketten' : 'Ordneretiketten'))
</script>

<template>
  <PageLayout
    :title="title"
    :hint="`${BINDER_SHEET.labels} Rückenschilder zu 192 × 61 mm je A4-Bogen (z. B. REX oder Avery Zweckform L4761), als PDF für einen normalen Drucker. In Originalgröße (100 %) drucken, nicht „an Seite anpassen“.`"
    width="wide"
    :ready="loaded"
  >
    <template #notice>
      <Message v-if="info" severity="success" closable @close="info = null">{{ info }}</Message>
      <ErrorBanner v-if="error" :message="error" :retryable="false" closable @close="error = null" />
    </template>

    <div class="binder">
      <div class="editor">
        <section class="card" aria-labelledby="binder-page">
          <header class="card-head">
            <h2 id="binder-page" class="card-title">Seite</h2>
            <span v-if="dirty && !isBlank" class="muted">Nicht gespeichert</span>
          </header>
          <div class="fields">
            <div class="field field--grow">
              <label for="binder-open">Gespeicherte Seite</label>
              <Select
                v-model="selectedPageId"
                input-id="binder-open"
                :options="pageOptions"
                option-label="label"
                option-value="value"
                :placeholder="pages.length ? 'Seite öffnen …' : 'Noch keine gespeichert'"
                :disabled="!pages.length"
                filter
                :filter-fields="['label', 'excerpt']"
                @update:model-value="openPage"
              >
                <template #option="{ option }">
                  <div class="page-option">
                    <span>{{ option.label }}</span>
                    <small v-if="option.excerpt">{{ option.excerpt }}</small>
                  </div>
                </template>
              </Select>
            </div>
            <Button icon="pi pi-file" label="Neue Seite" severity="secondary" outlined @click="newPage" />
          </div>
          <div class="fields">
            <div class="field field--grow">
              <label for="binder-name">Name</label>
              <InputText
                id="binder-name"
                ref="nameInput"
                v-model="name"
                maxlength="80"
                placeholder="z. B. Arbeitszimmer, Regal oben"
                @keydown.enter.prevent="save()"
              />
            </div>
            <Button
              icon="pi pi-save"
              :label="pageId ? 'Speichern' : 'Speichern unter diesem Namen'"
              :loading="saving"
              :disabled="saving || (!!pageId && !dirty)"
              @click="save()"
            />
            <Button
              v-if="pageId"
              icon="pi pi-copy"
              label="Als neue Seite"
              severity="secondary"
              outlined
              :disabled="saving"
              v-tooltip.top="'Unter dem Namen im Feld als weitere Seite speichern'"
              @click="save(true)"
            />
            <Button
              v-if="pageId"
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              aria-label="Gespeicherte Seite löschen"
              v-tooltip.top="'Gespeicherte Seite löschen'"
              :disabled="saving"
              @click="remove"
            />
          </div>
          <div class="fields">
            <div class="field">
              <span id="binder-direction" class="field-label">Schreibrichtung</span>
              <SelectButton
                v-model="direction"
                :options="DIRECTION_OPTIONS"
                option-label="label"
                option-value="value"
                :allow-empty="false"
                aria-labelledby="binder-direction"
              >
                <template #option="{ option }">
                  <span v-tooltip.top="option.hint">{{ option.label }}</span>
                </template>
              </SelectButton>
            </div>
            <div class="field">
              <span id="binder-align" class="field-label">Ausrichtung</span>
              <SelectButton
                v-model="align"
                :options="ALIGN_OPTIONS"
                option-label="label"
                option-value="value"
                :allow-empty="false"
                aria-labelledby="binder-align"
              >
                <template #option="{ option }">
                  <i :class="option.icon" aria-hidden="true" />
                  <span>{{ option.label }}</span>
                </template>
              </SelectButton>
            </div>
          </div>
          <p class="muted">
            <template v-if="direction === 'across'">
              Quer: am stehenden Ordner lesbar, der Text läuft über die 61 mm des Rückens.
            </template>
            <template v-else>Längs: der Text läuft entlang des Rückens.</template>
            Das linke Ende eines Etiketts auf dem Bogen kommt am Ordner nach oben.
          </p>
        </section>

        <section
          v-for="(_, index) in labels"
          :key="index"
          class="card label-card"
          :class="{ 'label-card--active': active === index }"
          :aria-labelledby="`binder-label-${index}`"
        >
          <header class="card-head">
            <h2 :id="`binder-label-${index}`" class="card-title">Etikett {{ index + 1 }}</h2>
            <div class="tools" role="toolbar" :aria-label="`Formatierung für Etikett ${index + 1}`">
              <Button
                v-for="tool in TOOLS"
                :key="tool.glyph"
                :label="tool.glyph"
                text
                size="small"
                severity="secondary"
                class="tool"
                :aria-label="tool.label"
                v-tooltip.top="tool.label"
                @click="tool.run(index)"
              />
            </div>
          </header>
          <Textarea
            :ref="(el) => (fields[index] = el as unknown as HTMLTextAreaElement)"
            v-model="labels[index]"
            :aria-labelledby="`binder-label-${index}`"
            rows="4"
            auto-resize
            maxlength="2000"
            class="label-text"
            :placeholder="index === 0 ? '# Steuer\n## 2025\nBelege und Bescheide' : 'leer lassen, wenn das Etikett schon verbraucht ist'"
            @focus="active = index"
            @keydown="onKeydown(index, $event)"
          />
          <small v-if="overflowing[index]" class="hint-warn">
            Der Text passt nicht ganz auf das Etikett und wird unten abgeschnitten.
          </small>
        </section>
        <p class="muted">
          Markdown: <code># Groß</code>, <code>## Mittel</code>, <code>### Klein</code>, <code>**fett**</code>,
          <code>*kursiv*</code>, <code>- Aufzählung</code>, <code>---</code> für eine Linie. Jede Zeile und jede
          Leerzeile bleibt, wie sie ist. Die Schriftgröße bleibt: ein Wort, das nicht mehr in die Zeile passt, kommt in die
          nächste, ein Wort breiter als das Etikett wird nach deutschen Regeln getrennt.
        </p>
      </div>

      <aside class="preview page-aside" aria-label="Vorschau">
        <div class="card">
          <header class="card-head">
            <h2 class="card-title">Vorschau</h2>
            <SelectButton
              v-model="view"
              :options="VIEW_OPTIONS"
              option-label="label"
              option-value="value"
              :allow-empty="false"
              aria-label="Vorschau als Seite oder am Ordner"
              size="small"
            />
          </header>
          <div class="preview-frame">
            <BinderSheetPreview
              :layouts="layouts"
              :direction="direction"
              :view="view"
              :active="active"
              @select="focusLabel"
            />
          </div>
          <div class="actions">
            <Button
              v-if="canPrint"
              icon="pi pi-file-pdf"
              label="PDF herunterladen"
              :loading="downloading === 'pdf'"
              :disabled="downloading !== null"
              @click="download(false)"
            />
            <Button
              v-if="canPrint"
              icon="pi pi-download"
              label="Probedruck mit Umrissen"
              severity="secondary"
              outlined
              :loading="downloading === 'test'"
              :disabled="downloading !== null"
              v-tooltip.top="'Auf normalem Papier drucken und gegen das Licht auf einen Bogen legen'"
              @click="download(true)"
            />
          </div>
          <p v-if="!canPrint" class="muted">Das PDF braucht das Recht „Label drucken“.</p>
        </div>
      </aside>
    </div>
  </PageLayout>
</template>

<style scoped>
.binder {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
}
@media (min-width: 1024px) {
  .binder {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
}
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.preview {
  --page-aside-inset: var(--space-3);
  min-width: 0;
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  min-width: 0;
}
.label-card--active {
  border-color: var(--p-primary-color);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.card-title {
  margin: 0;
  font-size: var(--text-lg);
}
.muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.muted code {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
}
.hint-warn {
  color: var(--p-message-warn-color);
  font-size: var(--text-sm);
}
.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.field--grow {
  flex: 1 1 14rem;
}
.field label,
.field-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.page-option {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.page-option small {
  color: var(--p-text-muted-color);
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.tool {
  min-width: 2.25rem;
  font-weight: 700;
}
.label-text {
  width: 100%;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.preview-frame {
  padding: var(--space-2);
  border-radius: 0.5rem;
  background: var(--p-content-hover-background);
}
/* Beside the fields the whole card, buttons included, stays on screen: the
   drawing gives up height, the SVG keeps its proportions inside. */
@media (min-width: 1024px) {
  .preview-frame :deep(.sheet) {
    max-height: calc(100dvh - var(--app-stack-height, 0px) - 15rem);
  }
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
