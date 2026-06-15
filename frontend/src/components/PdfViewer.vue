<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import * as pdfjsLib from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
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
const textLayer = shallowRef<TextLayer | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const textLayerRef = ref<HTMLDivElement | null>(null)
const pageLayerRef = ref<HTMLDivElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

const totalPages = ref(0)
const currentPage = ref(1)
const pageInput = ref('1')
const zoom = ref<number | typeof FIT_WIDTH>(FIT_WIDTH)
const effectiveZoom = ref(1)
const loading = ref(false)
const internalError = ref<string | null>(null)

const passwordPrompt = ref(false)
const passwordWrong = ref(false)
const passwordInput = ref('')
let passwordCallback: ((pw: string) => void) | null = null

let resizeObserver: ResizeObserver | null = null
let resizeRaf = 0

function submitPassword() {
  if (!passwordCallback || passwordInput.value.length === 0) return
  loading.value = true
  passwordPrompt.value = false
  const cb = passwordCallback
  passwordCallback = null
  cb(passwordInput.value)
}

function cancelTextLayer() {
  if (textLayer.value) {
    try { textLayer.value.cancel() } catch { /* ignore */ }
    textLayer.value = null
  }
  if (textLayerRef.value) textLayerRef.value.replaceChildren()
}

async function destroyDoc() {
  if (renderTask.value) {
    try { renderTask.value.cancel() } catch { /* ignore */ }
    renderTask.value = null
  }
  cancelTextLayer()
  if (pdfDoc.value) {
    try { await pdfDoc.value.destroy() } catch { /* ignore */ }
    pdfDoc.value = null
  }
}

async function loadDocument(bytes: Uint8Array) {
  await destroyDoc()
  internalError.value = null
  passwordPrompt.value = false
  passwordWrong.value = false
  passwordCallback = null
  loading.value = true
  try {
    const task = pdfjsLib.getDocument({ data: bytes })
    // pdf.js asks for a password on encrypted PDFs. Surface an inline prompt
    // so the user can view the document client-side; the typed password is
    // never sent anywhere (use the document's "Entsperren" action to persist
    // a decrypted copy).
    task.onPassword = (updatePassword: (pw: string) => void, reason: number) => {
      // reason 2 == INCORRECT_PASSWORD (1 == NEED_PASSWORD).
      passwordWrong.value = reason === 2
      passwordCallback = updatePassword
      passwordInput.value = ''
      passwordPrompt.value = true
      loading.value = false
    }
    const doc = await task.promise
    passwordPrompt.value = false
    pdfDoc.value = doc
    totalPages.value = doc.numPages
    currentPage.value = 1
    pageInput.value = '1'
    await renderPage()
  } catch (err: any) {
    if (err?.name !== 'PasswordException') {
      internalError.value = err?.message || 'PDF konnte nicht geladen werden'
    }
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
  cancelTextLayer()

  const page = await doc.getPage(currentPage.value)
  const cssScale = computeScale(page)
  effectiveZoom.value = cssScale

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const viewport = page.getViewport({ scale: cssScale * dpr })

  // CSS-pixel dimensions of the rendered page. The canvas is rasterised at
  // device-pixel resolution for sharpness but laid out (and overlaid by the
  // text layer) in CSS pixels.
  const cssWidth = Math.floor(viewport.width / dpr)
  const cssHeight = Math.floor(viewport.height / dpr)

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  // Size the positioning wrapper so the absolutely-positioned text layer
  // lines up exactly with the canvas and the wrapper scrolls as a unit.
  if (pageLayerRef.value) {
    pageLayerRef.value.style.width = `${cssWidth}px`
    pageLayerRef.value.style.height = `${cssHeight}px`
  }

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
    return
  } finally {
    if (renderTask.value === task) renderTask.value = null
  }

  await renderTextLayer(page, cssScale)
}

/**
 * Overlay a transparent, selectable text layer on top of the rendered page
 * so users can select and copy text directly on the PDF image. pdf.js
 * positions each text run from the document's text content, which covers
 * born-digital PDFs and scans that carry an OCR text layer. Image-only PDFs
 * with no text content simply render an empty (harmless) layer.
 */
async function renderTextLayer(page: PDFPageProxy, cssScale: number) {
  const container = textLayerRef.value
  if (!container) return

  container.replaceChildren()
  // pdf.js scales text-run geometry by this CSS variable.
  container.style.setProperty('--scale-factor', String(cssScale))

  const textViewport = page.getViewport({ scale: cssScale })
  const layer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: textViewport,
  })
  textLayer.value = layer
  try {
    await layer.render()
  } catch (err: any) {
    // Cancellation during rapid zoom/page changes is expected; ignore it.
    // Image-only scans render an empty layer (no error). Anything else is
    // logged but never fails the page — the canvas is already shown.
    if (err?.name !== 'AbortException') {
      console.warn('[PdfViewer] text layer render failed:', err)
    }
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
      <div v-if="passwordPrompt" class="state-overlay password">
        <i class="pi pi-lock" />
        <span>Dieses PDF ist passwortgeschützt.</span>
        <span v-if="passwordWrong" class="password-error">Falsches Passwort — bitte erneut versuchen.</span>
        <form class="password-form" @submit.prevent="submitPassword">
          <input
            v-model="passwordInput"
            type="password"
            class="password-input"
            placeholder="Passwort"
            autocomplete="off"
            autofocus
          />
          <button type="submit" class="password-submit" :disabled="passwordInput.length === 0">
            Anzeigen
          </button>
        </form>
      </div>
      <div v-else-if="errorMessage || internalError" class="state-overlay error">
        <i class="pi pi-exclamation-triangle" />
        <span>{{ errorMessage || internalError }}</span>
      </div>
      <div v-else-if="loading || !props.data" class="state-overlay">
        <i class="pi pi-spin pi-spinner" />
        <span>PDF wird geladen…</span>
      </div>
      <div ref="pageLayerRef" class="page-layer">
        <canvas ref="canvasRef" class="pdf-canvas" />
        <div ref="textLayerRef" class="textLayer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* No fixed/inherited height — the viewer grows with the rendered
     canvas so the surrounding page is the only thing that scrolls. */
  min-width: 0;
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
  /* Allow scrolling the preview when the user zooms the page past the
     available width — horizontal in particular, so the cut-off sides
     stay reachable. The wrapper grows with the page height, so vertical
     overflow still falls through to the page scroll as before. */
  overflow: auto;
  display: flex;
  padding: 0.5rem;
  background: var(--p-surface-ground, #2a2a2a);
}

.page-layer {
  position: relative;
  /* `margin: auto` centers the page while it fits the wrapper, but
     collapses to 0 once the page is wider than the wrapper so the left
     edge stays reachable by scrolling. A plain `justify-content: center`
     would push the overflow off the left, out of reach. */
  margin: auto;
  /* Size is set in JS to the rendered page's CSS dimensions; until then
     it has no intrinsic size. flex-shrink:0 keeps it from being squeezed
     by the flex parent so the overlay stays aligned with the canvas. */
  flex-shrink: 0;
}

.pdf-canvas {
  display: block;
  background: white;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

/* Transparent selectable text overlay — geometry comes from pdf.js, which
   sizes runs relative to the --scale-factor set on the container in JS.
   Mirrors pdfjs-dist/web/pdf_viewer.css; spans are created dynamically so
   they need :deep() to escape Vue's scoped-style attribute. */
.textLayer {
  position: absolute;
  inset: 0;
  text-align: initial;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 1;
}

.textLayer :deep(span),
.textLayer :deep(br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}

.textLayer :deep(span.markedContent) {
  top: 0;
  height: 0;
}

.textLayer :deep(.endOfContent) {
  display: block;
  position: absolute;
  inset: 100% 0 0;
  z-index: 0;
  cursor: default;
  user-select: none;
}

.textLayer :deep(::selection) {
  background: color-mix(in srgb, var(--p-primary-color) 35%, transparent);
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

/* The password prompt is interactive, so it opts back into pointer events
   and stacks its controls vertically. */
.state-overlay.password {
  flex-direction: column;
  pointer-events: auto;
  color: var(--p-text-color);
  text-align: center;
  padding: 1rem;
}
.state-overlay.password i { font-size: 1.5rem; }
.password-error { color: var(--p-red-400, #f87171); font-size: 0.85rem; }
.password-form { display: flex; gap: 0.5rem; margin-top: 0.25rem; flex-wrap: wrap; justify-content: center; }
.password-input {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  background: var(--p-surface-card);
  color: var(--p-text-color);
}
.password-submit {
  padding: 0.35rem 0.85rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color, #fff);
  cursor: pointer;
}
.password-submit:disabled { opacity: 0.5; cursor: default; }
</style>
