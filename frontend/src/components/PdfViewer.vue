<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import * as pdfjsLib from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  PDF_PAGE_CHUNK_SIZE,
  chunkCount,
  chunkForPage,
  chunkLabel,
  chunkRange,
  clampChunkIndex,
  pageNumbersInChunk,
} from '../utils/pdfPageChunks'

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

/** Pages this far outside the viewport are rasterised ahead of the scroll. */
const RENDER_MARGIN_PX = 800

/** One page of the currently mounted chunk. */
interface PageEntry {
  pageNumber: number
  /** CSS-pixel size of the page at `scale` — reserves the placeholder box. */
  width: number
  height: number
  scale: number
  rendered: boolean
}

const pdfDoc = shallowRef<PDFDocumentProxy | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

const totalPages = ref(0)
const chunkIndex = ref(0)
const pages = ref<PageEntry[]>([])
const currentPage = ref(1)
const pageInput = ref('1')
const pageInputFocused = ref(false)
const zoom = ref<number | typeof FIT_WIDTH>(FIT_WIDTH)
const effectiveZoom = ref(1)
const loading = ref(false)
const internalError = ref<string | null>(null)

const passwordPrompt = ref(false)
const passwordWrong = ref(false)
const passwordInput = ref('')
let passwordCallback: ((pw: string) => void) | null = null

// Non-reactive bookkeeping — these hold DOM nodes and pdf.js handles, which
// must never be wrapped in a reactive proxy.
const pageProxies = new Map<number, PDFPageProxy>()
const pageEls = new Map<number, HTMLElement>()
const canvasEls = new Map<number, HTMLCanvasElement>()
const textEls = new Map<number, HTMLDivElement>()
const renderTasks = new Map<number, RenderTask>()
const textLayers = new Map<number, TextLayer>()
/** Pages inside the render margin — re-rasterised after zoom/resize. */
const pendingPages = new Set<number>()
const renderingPages = new Set<number>()

let resizeObserver: ResizeObserver | null = null
let resizeRaf = 0
let scanRaf = 0
/** Guards against a superseded chunk build finishing after a newer one. */
let buildToken = 0

const totalChunks = computed(() => chunkCount(totalPages.value, PDF_PAGE_CHUNK_SIZE))
const paginated = computed(() => totalChunks.value > 1)
const rangeLabel = computed(() => chunkLabel(chunkIndex.value, totalPages.value, PDF_PAGE_CHUNK_SIZE))
const hasPrevChunk = computed(() => chunkIndex.value > 0)
const hasNextChunk = computed(() => chunkIndex.value < totalChunks.value - 1)

function submitPassword() {
  if (!passwordCallback || passwordInput.value.length === 0) return
  loading.value = true
  passwordPrompt.value = false
  const cb = passwordCallback
  passwordCallback = null
  cb(passwordInput.value)
}

function cancelRenders() {
  for (const task of renderTasks.values()) {
    try { task.cancel() } catch { /* ignore */ }
  }
  renderTasks.clear()
  renderingPages.clear()
  for (const layer of textLayers.values()) {
    try { layer.cancel() } catch { /* ignore */ }
  }
  textLayers.clear()
  for (const el of textEls.values()) el.replaceChildren()
}

function clearChunk() {
  cancelRenders()
  pageProxies.clear()
  pageEls.clear()
  canvasEls.clear()
  textEls.clear()
  pendingPages.clear()
  pages.value = []
}

async function destroyDoc() {
  clearChunk()
  if (pdfDoc.value) {
    try { await pdfDoc.value.destroy() } catch { /* ignore */ }
    pdfDoc.value = null
  }
  totalPages.value = 0
  chunkIndex.value = 0
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
    chunkIndex.value = 0
    await buildChunk()
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

/**
 * Mount the pages of `chunkIndex`: fetch each page proxy, measure it at the
 * current zoom and publish placeholder boxes. Rasterising happens lazily once
 * a placeholder scrolls into (or near) the viewport.
 */
async function buildChunk(scrollToPage?: number) {
  const doc = pdfDoc.value
  if (!doc) return
  const token = ++buildToken
  clearChunk()

  const numbers = pageNumbersInChunk(chunkIndex.value, totalPages.value, PDF_PAGE_CHUNK_SIZE)
  const entries: PageEntry[] = []
  for (const n of numbers) {
    const page = await doc.getPage(n)
    if (token !== buildToken) return
    pageProxies.set(n, page)
    const scale = computeScale(page)
    const viewport = page.getViewport({ scale })
    entries.push({
      pageNumber: n,
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      scale,
      rendered: false,
    })
  }
  if (token !== buildToken) return

  pages.value = entries
  effectiveZoom.value = entries[0]?.scale ?? 1
  setCurrentPage(scrollToPage ?? numbers[0] ?? 1)
  await nextTick()
  if (token !== buildToken) return
  if (scrollToPage !== undefined) scrollToPageElement(scrollToPage)
  updateVisiblePages()
}

async function ensureRendered(pageNumber: number) {
  const entry = pages.value.find((p) => p.pageNumber === pageNumber)
  const page = pageProxies.get(pageNumber)
  const canvas = canvasEls.get(pageNumber)
  if (!entry || !page || !canvas) return
  if (entry.rendered || renderingPages.has(pageNumber)) return

  renderingPages.add(pageNumber)
  const cssScale = entry.scale
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const viewport = page.getViewport({ scale: cssScale * dpr })

  // The canvas is rasterised at device-pixel resolution for sharpness but
  // laid out (and overlaid by the text layer) in CSS pixels.
  const cssWidth = Math.floor(viewport.width / dpr)
  const cssHeight = Math.floor(viewport.height / dpr)
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    renderingPages.delete(pageNumber)
    return
  }

  const task = page.render({ canvasContext: ctx, viewport })
  renderTasks.set(pageNumber, task)
  try {
    await task.promise
    entry.rendered = true
  } catch (err: any) {
    if (err?.name !== 'RenderingCancelledException') {
      internalError.value = err?.message || 'Seite konnte nicht gerendert werden'
    }
    return
  } finally {
    // Only clear the guards if this is still the page's current task — a
    // relayout may already have cancelled us and started a fresh render.
    if (renderTasks.get(pageNumber) === task) {
      renderTasks.delete(pageNumber)
      renderingPages.delete(pageNumber)
    }
  }

  await renderTextLayer(pageNumber, page, cssScale)
}

/**
 * Overlay a transparent, selectable text layer on top of the rendered page
 * so users can select and copy text directly on the PDF image. pdf.js
 * positions each text run from the document's text content, which covers
 * born-digital PDFs and scans that carry an OCR text layer. Image-only PDFs
 * with no text content simply render an empty (harmless) layer.
 */
async function renderTextLayer(pageNumber: number, page: PDFPageProxy, cssScale: number) {
  const container = textEls.get(pageNumber)
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
  textLayers.set(pageNumber, layer)
  try {
    await layer.render()
  } catch (err: any) {
    // Cancellation during rapid zoom/page changes is expected; ignore it.
    // Image-only scans render an empty layer (no error). Anything else is
    // logged but never fails the page — the canvas is already shown.
    if (err?.name !== 'AbortException') {
      console.warn('[PdfViewer] text layer render failed:', err)
    }
  } finally {
    if (textLayers.get(pageNumber) === layer) textLayers.delete(pageNumber)
  }
}

// ─── Visibility scanning ────────────────────────────────────────────────────
// Which pages need rasterising depends on the layout: on wide viewports the
// page stack scrolls inside `.canvas-wrapper`, on narrow ones the wrapper
// just grows and the whole document scrolls. An IntersectionObserver would
// need a different `root` per case (and its rootMargin prefetch is defeated
// by an intermediate scroll container), so we measure against the wrapper's
// currently on-screen band instead — that is correct in both layouts.

/** The vertical slice of the viewer that is actually on screen. */
function visibleBand(): { top: number; bottom: number } | null {
  const el = containerRef.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const top = Math.max(rect.top, 0)
  const bottom = Math.min(rect.bottom, viewportHeight)
  return bottom > top ? { top, bottom } : null
}

/**
 * Rasterise every page within the render margin of the visible band, drop
 * the ones that scrolled away, and report the current page to the toolbar.
 *
 * "Current" is the page covering most of the band, not the top-most one:
 * with a sliver of the previous page still showing, the top-most rule would
 * name a page the user has effectively scrolled past.
 */
function updateVisiblePages() {
  const band = visibleBand()
  if (!band || pages.value.length === 0) return
  let best: number | null = null
  let bestCoverage = 0
  for (const entry of pages.value) {
    const el = pageEls.get(entry.pageNumber)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (rect.bottom >= band.top - RENDER_MARGIN_PX && rect.top <= band.bottom + RENDER_MARGIN_PX) {
      pendingPages.add(entry.pageNumber)
      void ensureRendered(entry.pageNumber)
    } else {
      pendingPages.delete(entry.pageNumber)
    }
    const coverage = Math.min(rect.bottom, band.bottom) - Math.max(rect.top, band.top)
    if (coverage > bestCoverage) {
      bestCoverage = coverage
      best = entry.pageNumber
    }
  }
  if (best !== null && best !== currentPage.value) setCurrentPage(best)
}

function scheduleScan() {
  if (scanRaf) return
  scanRaf = requestAnimationFrame(() => {
    scanRaf = 0
    updateVisiblePages()
  })
}

/**
 * Re-measure every mounted page after a zoom or container-width change.
 * Every page changes height, so the old scroll offset would land on a
 * different page — keep the one the user was looking at anchored.
 */
async function relayout() {
  if (pages.value.length === 0) return
  const anchor = currentPage.value
  cancelRenders()
  for (const entry of pages.value) {
    const page = pageProxies.get(entry.pageNumber)
    if (!page) continue
    const scale = computeScale(page)
    const viewport = page.getViewport({ scale })
    entry.scale = scale
    entry.width = Math.floor(viewport.width)
    entry.height = Math.floor(viewport.height)
    entry.rendered = false
  }
  effectiveZoom.value = pages.value[0]?.scale ?? 1
  await nextTick()
  scrollToPageElement(anchor)
  updateVisiblePages()
}

// ─── Page element registration & observation ────────────────────────────────

/**
 * A `null` ref callback means the element unmounted. Vue may mount the new
 * chunk's nodes before unmounting the old ones, so only drop the entry when
 * the page really left the list — otherwise a stale unmount would unregister
 * a freshly mounted element.
 */
function isMounted(pageNumber: number): boolean {
  return pages.value.some((p) => p.pageNumber === pageNumber)
}

function setPageEl(pageNumber: number, el: Element | null) {
  if (!el) {
    if (isMounted(pageNumber)) return
    pageEls.delete(pageNumber)
    pendingPages.delete(pageNumber)
    return
  }
  pageEls.set(pageNumber, el as HTMLElement)
}

function setCanvasEl(pageNumber: number, el: Element | null) {
  if (el) canvasEls.set(pageNumber, el as HTMLCanvasElement)
  else if (!isMounted(pageNumber)) canvasEls.delete(pageNumber)
}

function setTextEl(pageNumber: number, el: Element | null) {
  if (el) textEls.set(pageNumber, el as HTMLDivElement)
  else if (!isMounted(pageNumber)) textEls.delete(pageNumber)
}

function setCurrentPage(pageNumber: number) {
  currentPage.value = pageNumber
  // Don't fight the user while they are typing a page number.
  if (!pageInputFocused.value) pageInput.value = String(pageNumber)
}

// ─── Navigation ─────────────────────────────────────────────────────────────

function clampedPage(value: number): number {
  if (!Number.isFinite(value)) return currentPage.value
  return Math.min(Math.max(1, Math.floor(value)), Math.max(1, totalPages.value))
}

function scrollToPageElement(pageNumber: number) {
  const el = pageEls.get(pageNumber)
  if (!el) return
  // Deliberately instant: smooth-scrolling across a 25-page stack drags the
  // visible band over every page in between, which would rasterise the whole
  // chunk on the way to the target.
  el.scrollIntoView({ block: 'start' })
}

async function goToPage(value: number) {
  const next = clampedPage(value)
  pageInput.value = String(next)
  const targetChunk = chunkForPage(next, PDF_PAGE_CHUNK_SIZE)
  if (targetChunk !== chunkIndex.value) {
    chunkIndex.value = clampChunkIndex(targetChunk, totalPages.value, PDF_PAGE_CHUNK_SIZE)
    await buildChunk(next)
    return
  }
  setCurrentPage(next)
  scrollToPageElement(next)
}

function nextPage() { void goToPage(currentPage.value + 1) }
function prevPage() { void goToPage(currentPage.value - 1) }

function onPageInputCommit() {
  void goToPage(parseInt(pageInput.value, 10))
}

async function goToChunk(index: number) {
  const next = clampChunkIndex(index, totalPages.value, PDF_PAGE_CHUNK_SIZE)
  if (next === chunkIndex.value) return
  chunkIndex.value = next
  await buildChunk()
  // A new chunk starts at its first page — put the user at the top of it.
  scrollToPageElement(chunkRange(next, totalPages.value, PDF_PAGE_CHUNK_SIZE).start)
}

function prevChunk() { void goToChunk(chunkIndex.value - 1) }
function nextChunk() { void goToChunk(chunkIndex.value + 1) }

// ─── Zoom ───────────────────────────────────────────────────────────────────

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

// ─── Pinch-to-zoom (touch) ──────────────────────────────────────────────────
// The app disables native viewport pinch-zoom (user-scalable=no) so the
// gesture has to be handled here. While pinching we only apply a cheap CSS
// transform for immediate visual feedback — re-rasterising every page on
// every touchmove would be far too slow. The real zoom (and re-render) is
// committed once the gesture ends.
const pinching = ref(false)
const pinchScale = ref(1)
let pinchStartDist = 0
let pinchStartZoom = 1
const pinchOriginX = ref(0)
const pinchOriginY = ref(0)

function touchDistance(a: Touch, b: Touch): number {
  const dx = a.clientX - b.clientX
  const dy = a.clientY - b.clientY
  return Math.hypot(dx, dy)
}

function onTouchStart(e: TouchEvent) {
  const [a, b] = e.touches
  const wrapper = containerRef.value
  if (e.touches.length !== 2 || !a || !b || !wrapper) return
  pinching.value = true
  pinchStartDist = touchDistance(a, b)
  pinchStartZoom = effectiveZoom.value
  pinchScale.value = 1
  const rect = wrapper.getBoundingClientRect()
  pinchOriginX.value = (a.clientX + b.clientX) / 2 - rect.left + wrapper.scrollLeft
  pinchOriginY.value = (a.clientY + b.clientY) / 2 - rect.top + wrapper.scrollTop
}

function onTouchMove(e: TouchEvent) {
  const [a, b] = e.touches
  if (!pinching.value || e.touches.length !== 2 || !a || !b || pinchStartDist === 0) return
  e.preventDefault()
  pinchScale.value = touchDistance(a, b) / pinchStartDist
}

function onTouchEnd(e: TouchEvent) {
  if (!pinching.value || e.touches.length >= 2) return
  pinching.value = false
  const finalZoom = pinchStartZoom * pinchScale.value
  pinchScale.value = 1
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, finalZoom))
}

function onContainerResize() {
  // A height-only change (e.g. the panel resizing) doesn't affect the
  // fit-width scale, but it does change which pages are on screen.
  if (zoom.value !== FIT_WIDTH) {
    scheduleScan()
    return
  }
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    void relayout()
  })
}

watch(() => props.data, (bytes) => {
  if (bytes) void loadDocument(bytes)
  else void destroyDoc()
}, { immediate: false })

watch(zoom, () => { void relayout() })

onMounted(() => {
  if (props.data) void loadDocument(props.data)
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onContainerResize)
    resizeObserver.observe(containerRef.value)
  }
  // Capture phase: `scroll` doesn't bubble, but it does travel the capture
  // path — so one listener catches both the page scrolling (narrow layout)
  // and the panel scrolling (wide layout).
  window.addEventListener('scroll', scheduleScan, { capture: true, passive: true })
  window.addEventListener('resize', scheduleScan, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', scheduleScan, { capture: true })
  window.removeEventListener('resize', scheduleScan)
  if (resizeObserver) resizeObserver.disconnect()
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  if (scanRaf) cancelAnimationFrame(scanRaf)
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
            aria-label="Seite"
            :value="pageInput"
            :disabled="totalPages === 0"
            @input="(e) => (pageInput = (e.target as HTMLInputElement).value)"
            @focus="pageInputFocused = true"
            @blur="pageInputFocused = false"
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

    <!-- Chunk pagination: only documents longer than one chunk need it. -->
    <div v-if="paginated" class="chunk-bar">
      <Button
        icon="pi pi-angle-double-left"
        text
        size="small"
        aria-label="Vorherige Seiten"
        :disabled="!hasPrevChunk"
        @click="prevChunk"
      />
      <span class="chunk-label">{{ rangeLabel }}</span>
      <Button
        icon="pi pi-angle-double-right"
        text
        size="small"
        aria-label="Nächste Seiten"
        :disabled="!hasNextChunk"
        @click="nextChunk"
      />
    </div>

    <div
      ref="containerRef"
      class="canvas-wrapper"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
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

      <div
        class="page-list"
        :style="pinching ? {
          transform: `scale(${pinchScale})`,
          transformOrigin: `${pinchOriginX}px ${pinchOriginY}px`,
        } : undefined"
      >
        <div
          v-for="p in pages"
          :key="p.pageNumber"
          :ref="(el) => setPageEl(p.pageNumber, el as Element | null)"
          :data-page-number="p.pageNumber"
          class="page-item"
        >
          <div
            class="page-layer"
            :style="{ width: `${p.width}px`, height: `${p.height}px` }"
          >
            <canvas
              :ref="(el) => setCanvasEl(p.pageNumber, el as Element | null)"
              class="pdf-canvas"
              :class="{ 'is-rendered': p.rendered }"
            />
            <div
              :ref="(el) => setTextEl(p.pageNumber, el as Element | null)"
              class="textLayer"
            />
            <div v-if="!p.rendered" class="page-placeholder">
              <i class="pi pi-spin pi-spinner" />
            </div>
          </div>
          <div class="page-caption">Seite {{ p.pageNumber }}</div>
        </div>
      </div>
    </div>

    <!-- Repeated at the bottom so paging on doesn't require scrolling back up. -->
    <div v-if="paginated && pages.length > 0" class="chunk-bar chunk-bar--bottom">
      <Button
        icon="pi pi-angle-double-left"
        text
        size="small"
        label="Vorherige Seiten"
        :disabled="!hasPrevChunk"
        @click="prevChunk"
      />
      <span class="chunk-label">{{ rangeLabel }}</span>
      <Button
        icon="pi pi-angle-double-right"
        text
        size="small"
        label="Nächste Seiten"
        iconPos="right"
        :disabled="!hasNextChunk"
        @click="nextChunk"
      />
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* Height is not set here: the viewer fills its panel when that panel has
     a definite height, and otherwise grows with the rendered pages.
     `min-height: 0` lets the page stack shrink below its content size in
     the former case so it — and not the whole document — scrolls. */
  min-width: 0;
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

.chunk-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: var(--p-surface-section, var(--p-surface-card));
}
.chunk-bar--bottom {
  border-bottom: none;
  border-top: 1px solid var(--p-content-border-color);
}
.chunk-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.canvas-wrapper {
  position: relative;
  /* This is the page stack's scroll container whenever the viewer has a
     definite height (wide layout: the panel fills the viewport, so only
     the stack scrolls and toolbar/pagination stay pinned to the panel).
     With `flex-basis: auto` the wrapper falls back to its content height
     when the viewer is free to grow (narrow layout) — then nothing
     overflows vertically and the page itself scrolls as before.
     Horizontal overflow is scrolled here in both cases, so the sides of a
     zoomed-in page stay reachable. */
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: 0.5rem;
  background: var(--p-surface-ground, #2a2a2a);
  /* Allow one-finger panning natively, but keep two-finger pinch under our
     own control (the app disables native viewport zoom globally). */
  touch-action: pan-x pan-y;
}

/* All pages of the current chunk, one below the other. */
.page-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  /* `margin: auto` centers the stack while it fits the wrapper, but
     collapses to 0 once a page is wider than the wrapper so the left edge
     stays reachable by scrolling. `flex-shrink: 0` keeps the flex parent
     from squeezing the (fixed-size) pages. */
  margin: auto;
  flex-shrink: 0;
}

.page-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  /* When the whole page scrolls, a jumped-to page has to clear the app's
     sticky navbar. Layouts that scroll the panel itself override this via
     `--pdf-scroll-margin` — there is no navbar in the way. */
  scroll-margin-top: var(--pdf-scroll-margin, calc(var(--menubar-height, 3.5rem) + 0.5rem));
}

.page-caption {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.page-layer {
  position: relative;
  /* Size comes from the measured page viewport (inline style), so the
     placeholder box already occupies the final height and the scroll
     position doesn't jump once the canvas is rasterised. */
  flex-shrink: 0;
  background: white;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.pdf-canvas {
  display: block;
  background: white;
}
/* Hidden until rasterised — the placeholder shows instead. */
.pdf-canvas:not(.is-rendered) { visibility: hidden; }

.page-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color);
  pointer-events: none;
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
  z-index: 2;
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

<!--
  pdf.js appends helper nodes (a canvas for text measuring, a span for copy
  support) directly to <body>, outside this component — so they need an
  unscoped rule. Without it the inline canvas creates a line box that makes
  the document ~19px taller than the viewport, which shows up as a stray
  page scrollbar. Mirrors pdfjs-dist/web/pdf_viewer.css, which we don't
  import wholesale.
-->
<style>
#hiddenCopyElement,
.hiddenCanvasElement {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  display: none;
}
</style>
