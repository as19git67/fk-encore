<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{
  /** Raw PDF bytes. pdfjs takes ownership, so pass a fresh copy per load. */
  data: Uint8Array | null
  /** Optional external error message (e.g. fetch failure). */
  errorMessage?: string | null
}>()

const ZOOM_STEPS: readonly number[] = [0.5, 0.66, 0.75, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const FIT_WIDTH = -1 as const

const pdfDoc = shallowRef<PDFDocumentProxy | null>(null)
const renderTask = shallowRef<RenderTask | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

const totalPages = ref(0)
const currentPage = ref(1)
const pageInput = ref('1')
const zoom = ref<number | typeof FIT_WIDTH>(FIT_WIDTH)
const effectiveZoom = ref(1)
const loading = ref(false)
const internalError = ref<string | null>(null)

let resizeObserver: ResizeObserver | null = null
let resizeRaf = 0

async function destroyDoc() {
  if (renderTask.value) {
    try { renderTask.value.cancel() } catch { /* ignore */ }
    renderTask.value = null
  }
  if (pdfDoc.value) {
    try { await pdfDoc.value.destroy() } catch { /* ignore */ }
    pdfDoc.value = null
  }
}

async function loadDocument(bytes: Uint8Array) {
  await destroyDoc()
  internalError.value = null
  loading.value = true
  try {
    const task = pdfjsLib.getDocument({ data: bytes })
    const doc = await task.promise
    pdfDoc.value = doc
    totalPages.value = doc.numPages
    currentPage.value = 1
    pageInput.value = '1'
    await renderPage()
  } catch (err: any) {
    internalError.value = err?.message || 'PDF konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

function computeScale(page: PDFPageProxy): number {
  if (zoom.value === FIT_WIDTH) {
    const containerWidth = containerRef.value?.clientWidth ?? 0
    if (containerWidth > 0) {
      const baseViewport = page.getViewport({ scale: 1 })
      // Leave a little padding so the page doesn't touch the scrollbar.
      return Math.max(0.1, (containerWidth - 16) / baseViewport.width)
    }
    return 1
  }
  return zoom.value
}

async function renderPage() {
  const doc = pdfDoc.value
  const canvas = canvasRef.value
  if (!doc || !canvas) return

  if (renderTask.value) {
    try { renderTask.value.cancel() } catch { /* ignore */ }
    renderTask.value = null
  }

  const page = await doc.getPage(currentPage.value)
  const cssScale = computeScale(page)
  effectiveZoom.value = cssScale

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const viewport = page.getViewport({ scale: cssScale * dpr })

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const task = page.render({ canvasContext: ctx, viewport })
  renderTask.value = task
  try {
    await task.promise
  } catch (err: any) {
    if (err?.name !== 'RenderingCancelledException') {
      internalError.value = err?.message || 'Seite konnte nicht gerendert werden'
    }
  } finally {
    if (renderTask.value === task) renderTask.value = null
  }
}

function clampedPage(value: number): number {
  if (Number.isNaN(value)) return currentPage.value
  return Math.min(Math.max(1, Math.floor(value)), Math.max(1, totalPages.value))
}

function goToPage(value: number) {
  const next = clampedPage(value)
  if (next !== currentPage.value) {
    currentPage.value = next
  }
  pageInput.value = String(next)
}

function nextPage() { goToPage(currentPage.value + 1) }
function prevPage() { goToPage(currentPage.value - 1) }

function onPageInputCommit() {
  const parsed = parseInt(pageInput.value, 10)
  goToPage(parsed)
}

function zoomIn() {
  const current = effectiveZoom.value
  const next = ZOOM_STEPS.find((s) => s > current + 0.001) ?? ZOOM_MAX
  zoom.value = next
}

function zoomOut() {
  const current = effectiveZoom.value
  let next = ZOOM_MIN
  for (const s of ZOOM_STEPS) {
    if (s < current - 0.001) next = s
    else break
  }
  zoom.value = next
}

function fitWidth() { zoom.value = FIT_WIDTH }

function onContainerResize() {
  if (zoom.value !== FIT_WIDTH) return
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    void renderPage()
  })
}

watch(() => props.data, (bytes) => {
  if (bytes) void loadDocument(bytes)
  else void destroyDoc()
}, { immediate: false })

watch([currentPage, zoom], () => { void renderPage() })

onMounted(() => {
  if (props.data) void loadDocument(props.data)
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onContainerResize)
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect()
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  void destroyDoc()
})
</script>

<template>
  <div class="pdf-viewer">
    <div class="toolbar">
      <div class="toolbar-group">
        <Button
          icon="pi pi-chevron-left"
          text
          rounded
          aria-label="Vorherige Seite"
          :disabled="currentPage <= 1 || totalPages === 0"
          @click="prevPage"
        />
        <div class="page-indicator">
          <input
            class="page-input"
            type="text"
            inputmode="numeric"
            :value="pageInput"
            :disabled="totalPages === 0"
            @input="(e) => (pageInput = (e.target as HTMLInputElement).value)"
            @change="onPageInputCommit"
            @keydown.enter="onPageInputCommit"
          />
          <span class="page-total">/ {{ totalPages || '–' }}</span>
        </div>
        <Button
          icon="pi pi-chevron-right"
          text
          rounded
          aria-label="Nächste Seite"
          :disabled="currentPage >= totalPages || totalPages === 0"
          @click="nextPage"
        />
      </div>

      <div class="toolbar-group">
        <Button
          icon="pi pi-search-minus"
          text
          rounded
          aria-label="Verkleinern"
          :disabled="totalPages === 0"
          @click="zoomOut"
        />
        <button
          type="button"
          class="zoom-display"
          :disabled="totalPages === 0"
          aria-label="An Breite anpassen"
          @click="fitWidth"
        >
          {{ Math.round(effectiveZoom * 100) }}%
        </button>
        <Button
          icon="pi pi-search-plus"
          text
          rounded
          aria-label="Vergrößern"
          :disabled="totalPages === 0"
          @click="zoomIn"
        />
      </div>
    </div>

    <div ref="containerRef" class="canvas-wrapper">
      <div v-if="errorMessage || internalError" class="state-overlay error">
        <i class="pi pi-exclamation-triangle" />
        <span>{{ errorMessage || internalError }}</span>
      </div>
      <div v-else-if="loading || !props.data" class="state-overlay">
        <i class="pi pi-spin pi-spinner" />
        <span>PDF wird geladen…</span>
      </div>
      <canvas ref="canvasRef" class="pdf-canvas" />
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
  align-items: center;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: var(--p-surface-section, var(--p-surface-card));
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.page-indicator {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.9rem;
  color: var(--p-text-color);
}

.page-input {
  width: 3.25rem;
  padding: 0.2rem 0.4rem;
  text-align: center;
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  background: var(--p-surface-card);
  color: inherit;
  font-size: 0.9rem;
}

.page-input:disabled { opacity: 0.5; }
.page-total { color: var(--p-text-muted-color); }

.zoom-display {
  min-width: 3.5rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}
.zoom-display:hover:not(:disabled) {
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
}
.zoom-display:disabled { opacity: 0.5; cursor: default; }

.canvas-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 0.5rem;
  background: var(--p-surface-ground, #2a2a2a);
}

.pdf-canvas {
  display: block;
  background: white;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.state-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
  pointer-events: none;
  background: color-mix(in srgb, var(--p-surface-ground, #000) 60%, transparent);
}
.state-overlay.error { color: var(--p-red-400, #f87171); }
</style>
