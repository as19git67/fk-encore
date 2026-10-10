<script setup lang="ts">
/**
 * Choosing which pages of one document reach the Sammelmappe's PDF.
 *
 * The pages are rendered in the browser, from the document's own bytes, rather
 * than asked of the backend page by page: the viewer already ships pdfjs, the
 * document is one request, and a per-page thumbnail endpoint would mean
 * rasterizing on the server for a decision the user makes in a few seconds.
 *
 * The selection is stored the other way round from how it reads here — the API
 * keeps the *excluded* pages, because a document whose page count changes
 * (a re-scan, a re-OCR) must keep meaning "all of it" rather than silently
 * freezing at the pages that existed when the folder was built.
 *
 * Only the round badge toggles a page. A tap on the page itself opens it large,
 * because a thumbnail is often too small to tell the cover letter from the
 * terms — and looking must not change the selection. The thumbnails can be
 * zoomed for the same reason; the PDF stays open while the dialog is, so the
 * large preview renders a page on demand at the size it is shown.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import { fetchDocumentBytes } from '../../api/documents'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{
  visible: boolean
  documentId: number
  title: string
  /** 1-based page numbers currently left out. */
  excludedPages: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', excludedPages: number[]): void
}>()

/** Thumbnail widths in CSS pixels the zoom steps through. */
const ZOOM_STEPS = [96, 132, 180, 240, 320] as const
const DEFAULT_ZOOM_INDEX = 1
/** Rendered once at the widest step, so zooming in never shows a blurry page. */
const THUMB_RENDER_WIDTH: number = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
const ZOOM_STORAGE_KEY = 'collection-page-selector-zoom'

const loading = ref(false)
const error = ref('')
const pages = ref<Array<{ page: number; dataUrl: string }>>([])
const excluded = ref<Set<number>>(new Set())

const selectedCount = computed(() => pages.value.length - excluded.value.size)
const allSelected = computed(() => excluded.value.size === 0)

// ─── Zoom ────────────────────────────────────────────────────────────────────
function readZoom(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_STORAGE_KEY))
    if (Number.isInteger(stored) && stored >= 0 && stored < ZOOM_STEPS.length) return stored
  } catch {
    // Storage blocked: the default is fine.
  }
  return DEFAULT_ZOOM_INDEX
}
const zoomIndex = ref(readZoom())
const thumbWidth = computed(() => ZOOM_STEPS[zoomIndex.value])
function zoom(delta: number) {
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomIndex.value + delta))
  zoomIndex.value = next
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(next))
  } catch {
    // Remembering the zoom is a convenience only.
  }
}

// ─── Loading ─────────────────────────────────────────────────────────────────
let pdf: pdfjsLib.PDFDocumentProxy | null = null
/** Bumped per load so a slow render for a previous document is dropped. */
let loadToken = 0

watch(
  () => [props.visible, props.documentId] as const,
  ([visible]) => {
    if (!visible) {
      closePreview()
      void releasePdf()
      return
    }
    excluded.value = new Set(props.excludedPages)
    void render()
  },
  { immediate: true },
)

onBeforeUnmount(() => void releasePdf())

async function releasePdf() {
  loadToken++
  const old = pdf
  pdf = null
  previewCache.clear()
  loading.value = false
  if (old) await old.destroy()
}

async function renderPage(doc: pdfjsLib.PDFDocumentProxy, pageNo: number, width: number, mime: string) {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: width / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas nicht verfügbar')
  await page.render({ canvasContext: context, viewport }).promise
  page.cleanup()
  return canvas.toDataURL(mime, 0.85)
}

async function render() {
  await releasePdf()
  const token = loadToken
  loading.value = true
  error.value = ''
  pages.value = []
  try {
    const bytes = await fetchDocumentBytes(props.documentId)
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise
    if (token !== loadToken) {
      await doc.destroy()
      return
    }
    pdf = doc
    const rendered: Array<{ page: number; dataUrl: string }> = []
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      rendered.push({ page: pageNo, dataUrl: await renderPage(doc, pageNo, THUMB_RENDER_WIDTH, 'image/jpeg') })
      if (token !== loadToken) return
    }
    pages.value = rendered
  } catch (err: any) {
    if (token !== loadToken) return
    error.value =
      err?.message ?? 'Seitenvorschau konnte nicht erzeugt werden — das Dokument ist kein PDF.'
  } finally {
    if (token === loadToken) loading.value = false
  }
}

// ─── Selection ───────────────────────────────────────────────────────────────
function togglePage(page: number) {
  const next = new Set(excluded.value)
  if (next.has(page)) next.delete(page)
  else next.add(page)
  excluded.value = next
}

function selectAll() {
  excluded.value = new Set()
}

function selectNone() {
  excluded.value = new Set(pages.value.map((p) => p.page))
}

// ─── Large preview ───────────────────────────────────────────────────────────
const previewPage = ref<number | null>(null)
const previewUrl = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref('')
const previewCache = new Map<number, string>()
const previewOpen = computed({
  get: () => previewPage.value !== null,
  set: (open: boolean) => {
    if (!open) closePreview()
  },
})

function previewRenderWidth(): number {
  // As wide as the dialog shows it, in device pixels; capped so a 4K screen
  // does not rasterize a 10-megapixel page for a glance.
  const css = Math.min(960, window.innerWidth)
  return Math.min(2400, Math.round(css * (window.devicePixelRatio || 1)))
}

async function openPreview(page: number) {
  previewPage.value = page
  previewError.value = ''
  const cached = previewCache.get(page)
  if (cached) {
    previewUrl.value = cached
    return
  }
  // Show the thumbnail right away; the sharp page replaces it when ready.
  previewUrl.value = pages.value.find((p) => p.page === page)?.dataUrl ?? null
  const doc = pdf
  if (!doc) return
  previewLoading.value = true
  try {
    const url = await renderPage(doc, page, previewRenderWidth(), 'image/jpeg')
    if (doc !== pdf) return
    previewCache.set(page, url)
    if (previewPage.value === page) previewUrl.value = url
  } catch (err: any) {
    if (previewPage.value === page) previewError.value = err?.message ?? 'Seite konnte nicht geladen werden.'
  } finally {
    if (previewPage.value === page || previewPage.value === null) previewLoading.value = false
  }
}

function closePreview() {
  previewPage.value = null
  previewUrl.value = null
  previewLoading.value = false
}

function stepPreview(delta: number) {
  if (previewPage.value === null) return
  const next = previewPage.value + delta
  if (next < 1 || next > pages.value.length) return
  void openPreview(next)
}

/** Arrow keys page through the preview wherever focus sits in it. */
function onPreviewKeydown(event: KeyboardEvent) {
  if (previewPage.value === null) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    stepPreview(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    stepPreview(1)
  }
}

watch(previewOpen, (open) => {
  if (open) window.addEventListener('keydown', onPreviewKeydown)
  else window.removeEventListener('keydown', onPreviewKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown))

function close() {
  emit('update:visible', false)
}

function save() {
  emit('save', [...excluded.value].sort((a, b) => a - b))
  close()
}
</script>

<template>
  <Dialog
    class="dialog-lg"
    :visible="visible"
    modal
    :header="`Seiten wählen — ${title}`"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="warn" :closable="false">{{ error }}</Message>

    <div v-if="loading" class="cps-loading">
      <ProgressSpinner style="width: 42px; height: 42px" />
      <span>Seitenvorschau wird erzeugt …</span>
    </div>

    <template v-else-if="pages.length > 0">
      <div class="cps-toolbar">
        <span class="cps-count">
          {{ selectedCount }} von {{ pages.length }}
          {{ pages.length === 1 ? 'Seite' : 'Seiten' }} ausgewählt
        </span>
        <div class="cps-toolbar-actions">
          <Button
            icon="pi pi-search-minus"
            text
            rounded
            size="small"
            severity="secondary"
            aria-label="Vorschaubilder verkleinern"
            :disabled="zoomIndex === 0"
            @click="zoom(-1)"
          />
          <Button
            icon="pi pi-search-plus"
            text
            rounded
            size="small"
            severity="secondary"
            aria-label="Vorschaubilder vergrößern"
            :disabled="zoomIndex === ZOOM_STEPS.length - 1"
            @click="zoom(1)"
          />
          <Button label="Alle" text size="small" :disabled="allSelected" @click="selectAll" />
          <Button
            label="Keine"
            text
            size="small"
            severity="secondary"
            :disabled="selectedCount === 0"
            @click="selectNone"
          />
        </div>
      </div>

      <ul class="cps-grid" :style="{ '--cps-thumb': `${thumbWidth}px` }">
        <li v-for="p in pages" :key="p.page">
          <div class="cps-page" :class="{ 'cps-page--off': excluded.has(p.page) }">
            <button
              type="button"
              class="cps-open"
              :aria-label="`Seite ${p.page} groß anzeigen`"
              @click="openPreview(p.page)"
            >
              <img :src="p.dataUrl" alt="" />
            </button>
            <button
              type="button"
              class="cps-badge"
              role="checkbox"
              :aria-checked="!excluded.has(p.page)"
              :aria-label="`Seite ${p.page} im PDF`"
              @click="togglePage(p.page)"
            >
              <i :class="excluded.has(p.page) ? 'pi pi-times' : 'pi pi-check'" aria-hidden="true" />
            </button>
            <span class="cps-label" aria-hidden="true">{{ p.page }}</span>
          </div>
        </li>
      </ul>
    </template>

    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="close" />
      <Button label="Übernehmen" icon="pi pi-check" :disabled="loading" @click="save" />
    </template>
  </Dialog>

  <Dialog
    v-model:visible="previewOpen"
    class="dialog-lg"
    modal
    dismissable-mask
    :header="previewPage !== null ? `Seite ${previewPage} von ${pages.length}` : ''"
  >
    <div class="cps-preview">
      <Message v-if="previewError" severity="warn" :closable="false">{{ previewError }}</Message>
      <div class="cps-preview-frame">
        <img
          v-if="previewUrl"
          :src="previewUrl"
          :alt="previewPage !== null ? `Seite ${previewPage}` : ''"
          class="cps-preview-img"
        />
        <ProgressSpinner v-if="previewLoading" class="cps-preview-spinner" style="width: 36px; height: 36px" />
      </div>
    </div>
    <template #footer>
      <Button
        icon="pi pi-chevron-left"
        text
        rounded
        aria-label="Vorherige Seite"
        :disabled="previewPage === null || previewPage <= 1"
        @click="stepPreview(-1)"
      />
      <Button
        icon="pi pi-chevron-right"
        text
        rounded
        aria-label="Nächste Seite"
        :disabled="previewPage === null || previewPage >= pages.length"
        @click="stepPreview(1)"
      />
      <span class="cps-preview-spacer" />
      <Button
        v-if="previewPage !== null"
        :icon="excluded.has(previewPage) ? 'pi pi-circle' : 'pi pi-check-circle'"
        :label="excluded.has(previewPage) ? 'Nicht im PDF' : 'Im PDF'"
        :severity="excluded.has(previewPage) ? 'secondary' : undefined"
        outlined
        :aria-pressed="!excluded.has(previewPage)"
        @click="togglePage(previewPage)"
      />
      <Button label="Schließen" @click="closePreview" />
    </template>
  </Dialog>
</template>

<style scoped>
.cps-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px 0;
  color: var(--p-text-muted-color);
}
.cps-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.cps-count {
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
}
.cps-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
/* The scroller makes room for the focus ring it would otherwise clip. */
.cps-grid {
  list-style: none;
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--cps-thumb, 132px), 100%), 1fr));
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
.cps-page {
  position: relative;
  width: 100%;
  border: 2px solid var(--p-primary-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--p-content-background);
}
/* Fills the rounded, clipping card edge to edge: the ring goes inside. */
.cps-open {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  outline-offset: var(--focus-ring-offset-inset);
}
.cps-open:focus-visible {
  outline: var(--focus-ring);
}
.cps-page img {
  display: block;
  width: 100%;
  height: auto;
}
.cps-page--off {
  border-color: var(--p-content-border-color);
}
.cps-page--off img {
  opacity: 0.35;
  filter: grayscale(1);
}
.cps-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  font-size: var(--text-xs);
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  cursor: pointer;
}
/* A larger touch target than the circle it draws. */
.cps-badge::before {
  content: '';
  position: absolute;
  inset: -8px;
}
.cps-badge:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.cps-page--off .cps-badge {
  background: var(--p-content-border-color);
  color: var(--p-text-muted-color);
}
.cps-label {
  pointer-events: none;
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: var(--text-sm);
  /* The label floats on the page thumbnail, not on a themed surface: the
     dark scrim gives it its own background in both themes, so the text
     stays white either way. */
  background: rgba(0, 0, 0, 0.55);
  color: #fff; /* audit-ok: white on the fixed dark scrim above, not on a theme surface */
}
.cps-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.cps-preview-frame {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 200px;
}
.cps-preview-img {
  display: block;
  max-width: 100%;
  max-height: 72dvh;
  height: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  background: var(--p-content-background);
}
.cps-preview-spinner {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
}
.cps-preview-spacer {
  flex: 1 1 auto;
}
</style>
