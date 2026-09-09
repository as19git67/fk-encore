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
 */
import { computed, ref, watch } from 'vue'
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

/** Preview width in CSS pixels; the render scale is derived per page. */
const THUMB_WIDTH = 132

const loading = ref(false)
const error = ref('')
const pages = ref<Array<{ page: number; dataUrl: string }>>([])
const excluded = ref<Set<number>>(new Set())

const selectedCount = computed(() => pages.value.length - excluded.value.size)
const allSelected = computed(() => excluded.value.size === 0)

watch(
  () => [props.visible, props.documentId] as const,
  ([visible]) => {
    if (!visible) return
    excluded.value = new Set(props.excludedPages)
    void render()
  },
  { immediate: true },
)

async function render() {
  loading.value = true
  error.value = ''
  pages.value = []
  try {
    const bytes = await fetchDocumentBytes(props.documentId)
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
    const rendered: Array<{ page: number; dataUrl: string }> = []
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas nicht verfügbar')
      await page.render({ canvasContext: context, viewport }).promise
      rendered.push({ page: pageNo, dataUrl: canvas.toDataURL('image/png') })
      page.cleanup()
    }
    pages.value = rendered
    await pdf.destroy()
  } catch (err: any) {
    error.value =
      err?.message ?? 'Seitenvorschau konnte nicht erzeugt werden — das Dokument ist kein PDF.'
  } finally {
    loading.value = false
  }
}

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
    :visible="visible"
    modal
    :header="`Seiten wählen — ${title}`"
    :style="{ width: 'min(900px, 96vw)' }"
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

      <ul class="cps-grid">
        <li v-for="p in pages" :key="p.page">
          <button
            type="button"
            class="cps-page"
            :class="{ 'cps-page--off': excluded.has(p.page) }"
            :aria-pressed="!excluded.has(p.page)"
            @click="togglePage(p.page)"
          >
            <img :src="p.dataUrl" :alt="`Seite ${p.page}`" />
            <span class="cps-badge">
              <i :class="excluded.has(p.page) ? 'pi pi-times' : 'pi pi-check'" />
            </span>
            <span class="cps-label">{{ p.page }}</span>
          </button>
        </li>
      </ul>
    </template>

    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="close" />
      <Button label="Übernehmen" icon="pi pi-check" :disabled="loading" @click="save" />
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
  font-size: 0.85rem;
}
.cps-toolbar-actions {
  display: flex;
  gap: 4px;
}
.cps-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
.cps-page {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  border: 2px solid var(--p-primary-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--p-content-background);
  cursor: pointer;
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
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 0.7rem;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}
.cps-page--off .cps-badge {
  background: var(--p-content-border-color);
  color: var(--p-text-muted-color);
}
.cps-label {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 0.72rem;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
</style>
