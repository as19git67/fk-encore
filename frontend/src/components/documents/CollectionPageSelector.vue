<script setup lang="ts">
/**
 * Choosing which pages of one document reach the Sammelmappe's PDF.
 *
 * The pages are rendered in the browser, from the document's own bytes, rather
 * than asked of the backend page by page: the viewer already ships pdfjs, the
 * document is one request, and a per-page thumbnail endpoint would mean
 * rasterizing on the server for a decision the user makes in a few seconds.
 *
 * Thumbnails are drawn lazily: the grid stands as soon as the page count is
 * known, every page as a placeholder of its proportions, and the pages
 * scrolled into view are rendered first — the rest follow in the background,
 * one at a time, so a 60-page contract is usable after the first screenful
 * rather than after the last page.
 *
 * The selection is stored the other way round from how it reads here — the API
 * keeps the *excluded* pages, because a document whose page count changes
 * (a re-scan, a re-OCR) must keep meaning "all of it" rather than silently
 * freezing at the pages that existed when the folder was built.
 *
 * Only the round badge toggles a page. A tap on the page itself opens it large,
 * because a thumbnail is often too small to tell the cover letter from the
 * terms — and looking must not change the selection. The large preview can be
 * zoomed further and renders the page at the size it is shown.
 *
 * The search reads the PDF's text layer (all pages, on the first search) and
 * marks hits in the grid and in the large preview — so the page with the
 * account number can be found without paging through all of them.
 *
 * The large preview is also where areas get blacked out: with „Schwärzen" on,
 * dragging a rectangle over the page adds a box. Boxes are kept relative to
 * the page as shown (0..1), so they mean the same at any render size. They
 * change only the folder's PDF — the server re-renders such a page as an
 * image with the boxes burnt in, so the text under them is gone there; the
 * document in the archive stays as it is.
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import { fetchDocumentBytes } from '../../api/documents'
import type { PageRedaction } from '../../api/collections'
import {
  buildPageText,
  countMatches,
  matchRects,
  normalizeQuery,
  type PdfPageText,
  type PdfTextRun,
} from '../../utils/pdfTextSearch'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{
  visible: boolean
  documentId: number
  title: string
  /** 1-based page numbers currently left out. */
  excludedPages: number[]
  /** Rectangles currently blacked out. */
  redactions: PageRedaction[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', value: { excludedPages: number[]; redactions: PageRedaction[] }): void
}>()

/** Thumbnail widths in CSS pixels the zoom steps through. */
const ZOOM_STEPS = [96, 132, 180, 240, 320] as const
const DEFAULT_ZOOM_INDEX = 1
/** Rendered once at the widest step, so zooming in never shows a blurry page. */
const THUMB_RENDER_WIDTH: number = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
const ZOOM_STORAGE_KEY = 'collection-page-selector-zoom'
/** Height / width of an A4 page: the placeholder until a page says otherwise. */
const A4_ASPECT = 297 / 210

const loading = ref(false)
const error = ref('')
const pageCount = ref(0)
const pageNumbers = computed(() => Array.from({ length: pageCount.value }, (_, i) => i + 1))
/** Height / width per page (index = page - 1). */
const aspects = ref<number[]>([])
/** Rendered thumbnails by page number. */
const thumbs = ref<Record<number, string>>({})
const excluded = ref<Set<number>>(new Set())
const redactions = ref<PageRedaction[]>([])

const selectedCount = computed(() => pageCount.value - excluded.value.size)
const allSelected = computed(() => excluded.value.size === 0)

function aspectOf(page: number): number {
  return aspects.value[page - 1] ?? A4_ASPECT
}

// ─── Thumbnail zoom ──────────────────────────────────────────────────────────
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

onBeforeUnmount(() => void releasePdf())

async function releasePdf() {
  loadToken++
  const old = pdf
  pdf = null
  previewCache.clear()
  visibleThumbs.clear()
  failedThumbs.clear()
  thumbObserver?.disconnect()
  thumbObserver = null
  pageTexts.value = null
  textLoading.value = false
  loading.value = false
  if (old) await old.destroy()
}

async function renderPage(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNo: number,
  width: number,
): Promise<{ url: string; aspect: number }> {
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
  return { url: canvas.toDataURL('image/jpeg', 0.85), aspect: base.height / base.width }
}

async function load() {
  await releasePdf()
  const token = loadToken
  loading.value = true
  error.value = ''
  pageCount.value = 0
  aspects.value = []
  thumbs.value = {}
  try {
    const bytes = await fetchDocumentBytes(props.documentId)
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise
    if (token !== loadToken) {
      await doc.destroy()
      return
    }
    pdf = doc
    // Page one's proportions stand in for every page until it is rendered —
    // scans of one document almost always share them.
    const first = (await doc.getPage(1)).getViewport({ scale: 1 })
    if (token !== loadToken) return
    aspects.value = Array.from({ length: doc.numPages }, () => first.height / first.width)
    pageCount.value = doc.numPages
    loading.value = false
    await nextTick()
    observeThumbs()
    void pumpThumbs(token)
  } catch (err: any) {
    if (token !== loadToken) return
    error.value =
      err?.message ?? 'Seitenvorschau konnte nicht erzeugt werden — das Dokument ist kein PDF.'
  } finally {
    if (token === loadToken) loading.value = false
  }
}

// ─── Lazy thumbnails ─────────────────────────────────────────────────────────
const gridEl = ref<HTMLElement | null>(null)
/** Pages currently in (or near) the grid's viewport. */
const visibleThumbs = new Set<number>()
const failedThumbs = new Set<number>()
let thumbObserver: IntersectionObserver | null = null
let pumping = false

function observeThumbs() {
  thumbObserver?.disconnect()
  thumbObserver = null
  if (typeof IntersectionObserver === 'undefined' || !gridEl.value) return
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page)
        if (entry.isIntersecting) visibleThumbs.add(page)
        else visibleThumbs.delete(page)
      }
      void pumpThumbs(loadToken)
    },
    { root: gridEl.value, rootMargin: '200px 0px' },
  )
  for (const el of gridEl.value.querySelectorAll<HTMLElement>('[data-page]')) {
    thumbObserver.observe(el)
  }
}

/** The next page to draw: the first visible one still missing, else the first missing at all. */
function nextThumb(): number | null {
  const missing = (page: number) => !thumbs.value[page] && !failedThumbs.has(page)
  const visible = [...visibleThumbs].filter(missing).sort((a, b) => a - b)
  if (visible.length > 0) return visible[0]!
  for (let page = 1; page <= pageCount.value; page++) {
    if (missing(page)) return page
  }
  return null
}

/** Draw thumbnails one at a time until all are there; re-entrant calls are no-ops. */
async function pumpThumbs(token: number) {
  if (pumping) return
  pumping = true
  try {
    while (token === loadToken && pdf) {
      const page = nextThumb()
      if (page === null) break
      try {
        const { url, aspect } = await renderPage(pdf, page, THUMB_RENDER_WIDTH)
        if (token !== loadToken) return
        thumbs.value[page] = url
        aspects.value[page - 1] = aspect
      } catch {
        failedThumbs.add(page)
      }
    }
  } finally {
    pumping = false
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
  excluded.value = new Set(pageNumbers.value)
}

// ─── Text search ─────────────────────────────────────────────────────────────
const SEARCH_DEBOUNCE_MS = 200
const query = ref('')
const term = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    term.value = normalizeQuery(value)
  }, SEARCH_DEBOUNCE_MS)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/** Text of every page, read on the first search (index = page - 1). */
const pageTexts = shallowRef<PdfPageText[] | null>(null)
const textLoading = ref(false)

watch(term, (value) => {
  if (value && !pageTexts.value && !textLoading.value) void loadText(loadToken)
})

async function loadText(token: number) {
  const doc = pdf
  if (!doc) return
  textLoading.value = true
  try {
    const texts: PdfPageText[] = []
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const runs: PdfTextRun[] = []
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue
        // Text space → page as shown (rotation and crop box applied).
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
        const fontHeight = Math.hypot(tx[2], tx[3])
        runs.push({
          str: item.str,
          x: tx[4] / viewport.width,
          y: (tx[5] - fontHeight) / viewport.height,
          w: (item.width * viewport.scale) / viewport.width,
          // A little below the baseline too, where descenders sit.
          h: (fontHeight * 1.2) / viewport.height,
        })
      }
      texts.push(buildPageText(runs))
      if (token !== loadToken) return
    }
    pageTexts.value = texts
  } catch {
    if (token === loadToken) pageTexts.value = []
  } finally {
    if (token === loadToken) textLoading.value = false
  }
}

/** Hits per page for the current term (index = page - 1). */
const hitCounts = computed<number[]>(() => {
  const texts = pageTexts.value
  if (!term.value || !texts) return []
  return texts.map((text) => countMatches(text, term.value))
})
const hitPages = computed(() => pageNumbers.value.filter((page) => (hitCounts.value[page - 1] ?? 0) > 0))
const hitTotal = computed(() => hitCounts.value.reduce((sum, n) => sum + n, 0))
const hasText = computed(() => !!pageTexts.value?.some((text) => text.text.trim().length > 0))
const searchSummary = computed(() => {
  if (!term.value) return ''
  if (textLoading.value || !pageTexts.value) return 'Text wird gelesen …'
  if (!hasText.value) return 'Das PDF enthält keinen durchsuchbaren Text.'
  if (hitTotal.value === 0) return 'Kein Treffer'
  const pages = hitPages.value.length
  return `${hitTotal.value} Treffer auf ${pages} ${pages === 1 ? 'Seite' : 'Seiten'}`
})

function hitsOn(page: number): number {
  return hitCounts.value[page - 1] ?? 0
}

/** Open the next (or previous) page with a hit, counting from the page open now. */
function jumpToHit(delta: 1 | -1) {
  const pages = hitPages.value
  if (pages.length === 0) return
  const from = previewPage.value ?? (delta > 0 ? 0 : pageCount.value + 1)
  const target =
    delta > 0
      ? (pages.find((page) => page > from) ?? pages[0]!)
      : ([...pages].reverse().find((page) => page < from) ?? pages[pages.length - 1]!)
  void openPreview(target)
}

const previewHitRects = computed(() => {
  const page = previewPage.value
  const texts = pageTexts.value
  if (page === null || !texts || !term.value) return []
  const text = texts[page - 1]
  return text ? matchRects(text, term.value) : []
})

// ─── Redaction ───────────────────────────────────────────────────────────────
/** Smaller than this (relative) is a click, not a box. */
const MIN_BOX = 0.005

const redactMode = ref(false)
/** The box being dragged, in the same relative units. */
const draft = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const canvasEl = ref<HTMLElement | null>(null)

function boxesOn(page: number): Array<{ box: PageRedaction; index: number }> {
  const out: Array<{ box: PageRedaction; index: number }> = []
  redactions.value.forEach((box, index) => {
    if (box.page === page) out.push({ box, index })
  })
  return out
}

function boxStyle(box: Pick<PageRedaction, 'x' | 'y' | 'w' | 'h'>) {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  }
}

const draftBox = computed(() => {
  const d = draft.value
  if (!d) return null
  return {
    x: Math.min(d.x0, d.x1),
    y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0),
    h: Math.abs(d.y1 - d.y0),
  }
})

function relativePoint(event: PointerEvent): { x: number; y: number } | null {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect || rect.width === 0 || rect.height === 0) return null
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  }
}

function onDrawStart(event: PointerEvent) {
  if (!redactMode.value || previewPage.value === null || event.button !== 0) return
  const point = relativePoint(event)
  if (!point) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  draft.value = { x0: point.x, y0: point.y, x1: point.x, y1: point.y }
}

function onDrawMove(event: PointerEvent) {
  if (!draft.value) return
  const point = relativePoint(event)
  if (!point) return
  draft.value = { ...draft.value, x1: point.x, y1: point.y }
}

function onDrawEnd() {
  const box = draftBox.value
  draft.value = null
  if (!box || previewPage.value === null) return
  if (box.w < MIN_BOX || box.h < MIN_BOX) return
  redactions.value = [...redactions.value, { page: previewPage.value, ...box }]
}

function removeRedaction(index: number) {
  redactions.value = redactions.value.filter((_, i) => i !== index)
}

const previewBoxCount = computed(() =>
  previewPage.value === null ? 0 : boxesOn(previewPage.value).length,
)

// ─── Large preview ───────────────────────────────────────────────────────────
/** Magnification over "whole page fits" the large preview steps through. */
const PREVIEW_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const
/** Share of the window height the page may take at 100 %. */
const PREVIEW_FIT_HEIGHT = 0.62
/** Upper bound for a rendered page, in device pixels across. */
const PREVIEW_MAX_RENDER_WIDTH = 4000
const PREVIEW_RENDER_DEBOUNCE_MS = 150

const previewPage = ref<number | null>(null)
const previewUrl = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref('')
const previewZoomIndex = ref(0)
const previewZoom = computed(() => PREVIEW_ZOOM_STEPS[previewZoomIndex.value]!)
/** Cache of rendered pages, keyed `page@width`. */
const previewCache = new Map<string, string>()
const frameEl = ref<HTMLElement | null>(null)
const frameWidth = ref(0)
let frameObserver: ResizeObserver | null = null

const previewOpen = computed({
  get: () => previewPage.value !== null,
  set: (open: boolean) => {
    if (!open) closePreview()
  },
})

/** CSS width of the page at 100 %: as wide as the frame, as tall as the window allows. */
const fitWidth = computed(() => {
  if (previewPage.value === null || frameWidth.value === 0) return 0
  const maxHeight = window.innerHeight * PREVIEW_FIT_HEIGHT
  return Math.floor(Math.min(frameWidth.value, maxHeight / aspectOf(previewPage.value)))
})
const shownWidth = computed(() => Math.round(fitWidth.value * previewZoom.value))
const renderWidth = computed(() =>
  Math.min(PREVIEW_MAX_RENDER_WIDTH, Math.round(shownWidth.value * (window.devicePixelRatio || 1))),
)

watch(frameEl, (el) => {
  frameObserver?.disconnect()
  frameObserver = null
  if (!el) return
  frameWidth.value = el.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  frameObserver = new ResizeObserver(() => {
    frameWidth.value = el.clientWidth
  })
  frameObserver.observe(el)
})
onBeforeUnmount(() => frameObserver?.disconnect())

let previewTimer: ReturnType<typeof setTimeout> | null = null
watch([previewPage, renderWidth], ([page, width]) => {
  if (previewTimer) clearTimeout(previewTimer)
  if (page === null || width === 0) return
  const cached = previewCache.get(`${page}@${width}`)
  if (cached) {
    previewUrl.value = cached
    previewLoading.value = false
    return
  }
  // Zooming: debounce, so stepping 100 → 400 % renders once, not three times.
  previewTimer = setTimeout(() => void renderPreview(page, width), PREVIEW_RENDER_DEBOUNCE_MS)
})
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
})

async function renderPreview(page: number, width: number) {
  const doc = pdf
  if (!doc) return
  previewLoading.value = true
  try {
    const { url } = await renderPage(doc, page, width)
    if (doc !== pdf) return
    previewCache.set(`${page}@${width}`, url)
    if (previewPage.value === page && renderWidth.value === width) previewUrl.value = url
  } catch (err: any) {
    if (previewPage.value === page) previewError.value = err?.message ?? 'Seite konnte nicht geladen werden.'
  } finally {
    if (previewPage.value === page || previewPage.value === null) previewLoading.value = false
  }
}

async function openPreview(page: number) {
  const changed = previewPage.value !== page
  previewPage.value = page
  previewError.value = ''
  // Show the thumbnail right away; the sharp page replaces it when ready.
  if (changed) previewUrl.value = thumbs.value[page] ?? null
  if (term.value && hitsOn(page) > 0) {
    await nextTick()
    frameEl.value?.querySelector('.cps-hit')?.scrollIntoView({ block: 'center', inline: 'center' })
  }
}

function closePreview() {
  draft.value = null
  redactMode.value = false
  previewPage.value = null
  previewUrl.value = null
  previewLoading.value = false
}

function stepPreview(delta: number) {
  if (previewPage.value === null) return
  const next = previewPage.value + delta
  if (next < 1 || next > pageCount.value) return
  void openPreview(next)
}

function zoomPreview(delta: number) {
  previewZoomIndex.value = Math.max(
    0,
    Math.min(PREVIEW_ZOOM_STEPS.length - 1, previewZoomIndex.value + delta),
  )
}

/** Arrow keys page through the preview — unless they are moving a text cursor. */
function onPreviewKeydown(event: KeyboardEvent) {
  if (previewPage.value === null) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
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

const previewIncluded = computed({
  get: () => previewPage.value !== null && !excluded.value.has(previewPage.value),
  set: (included: boolean) => {
    const page = previewPage.value
    if (page === null || included === !excluded.value.has(page)) return
    togglePage(page)
  },
})

function close() {
  emit('update:visible', false)
}

// Last in setup: with `immediate` this runs right away, and everything it
// reaches (the caches, the search and redaction state) must exist by then.
watch(
  () => [props.visible, props.documentId] as const,
  ([visible]) => {
    if (!visible) {
      closePreview()
      previewZoomIndex.value = 0
      void releasePdf()
      return
    }
    excluded.value = new Set(props.excludedPages)
    redactions.value = props.redactions.map((r) => ({ ...r }))
    void load()
  },
  { immediate: true },
)

function save() {
  emit('save', {
    excludedPages: [...excluded.value].sort((a, b) => a - b),
    redactions: redactions.value,
  })
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
      <span>PDF wird geladen …</span>
    </div>

    <template v-else-if="pageCount > 0">
      <div class="cps-search">
        <IconField class="cps-search-field">
          <InputIcon class="pi pi-search" />
          <InputText
            v-model="query"
            type="search"
            placeholder="Im Text suchen"
            aria-label="Im Text des Dokuments suchen"
            fluid
          />
        </IconField>
        <template v-if="term">
          <span class="cps-search-summary" aria-live="polite">{{ searchSummary }}</span>
          <Button
            icon="pi pi-chevron-up"
            text
            rounded
            size="small"
            aria-label="Vorheriger Treffer"
            :disabled="hitPages.length === 0"
            @click="jumpToHit(-1)"
          />
          <Button
            icon="pi pi-chevron-down"
            text
            rounded
            size="small"
            aria-label="Nächster Treffer"
            :disabled="hitPages.length === 0"
            @click="jumpToHit(1)"
          />
        </template>
      </div>

      <div class="cps-toolbar">
        <span class="cps-count">
          {{ selectedCount }} von {{ pageCount }}
          {{ pageCount === 1 ? 'Seite' : 'Seiten' }} ausgewählt<template v-if="redactions.length > 0">
            · {{ redactions.length }} {{ redactions.length === 1 ? 'Schwärzung' : 'Schwärzungen' }}</template>
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

      <ul ref="gridEl" class="cps-grid" :style="{ '--cps-thumb': `${thumbWidth}px` }">
        <li v-for="page in pageNumbers" :key="page" :data-page="page">
          <div
            class="cps-page"
            :class="{
              'cps-page--off': excluded.has(page),
              'cps-page--hit': hitsOn(page) > 0,
              'cps-page--miss': term && pageTexts && hitsOn(page) === 0,
            }"
          >
            <button
              type="button"
              class="cps-open"
              :aria-label="`Seite ${page} groß anzeigen`"
              @click="openPreview(page)"
            >
              <span class="cps-canvas" :style="{ aspectRatio: `1 / ${aspectOf(page)}` }">
                <img v-if="thumbs[page]" :src="thumbs[page]" alt="" />
                <span v-else class="cps-placeholder" aria-hidden="true">
                  <i class="pi pi-spin pi-spinner" />
                </span>
                <span
                  v-for="{ box, index } in boxesOn(page)"
                  :key="index"
                  class="cps-box"
                  :style="boxStyle(box)"
                  aria-hidden="true"
                />
              </span>
            </button>
            <button
              type="button"
              class="cps-badge"
              role="checkbox"
              :aria-checked="!excluded.has(page)"
              :aria-label="`Seite ${page} im PDF`"
              @click="togglePage(page)"
            >
              <i :class="excluded.has(page) ? 'pi pi-times' : 'pi pi-check'" aria-hidden="true" />
            </button>
            <span class="cps-label" aria-hidden="true">{{ page }}</span>
            <span v-if="hitsOn(page) > 0" class="cps-hits" aria-hidden="true">
              <i class="pi pi-search" /> {{ hitsOn(page) }}
            </span>
            <span v-else-if="boxesOn(page).length > 0" class="cps-redacted" aria-hidden="true">
              <i class="pi pi-eye-slash" /> {{ boxesOn(page).length }}
            </span>
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
    :header="previewPage !== null ? `Seite ${previewPage} von ${pageCount}` : ''"
  >
    <div class="cps-preview">
      <div class="cps-preview-bar">
        <div class="cps-preview-group">
          <Button
            icon="pi pi-chevron-left"
            text
            rounded
            size="small"
            aria-label="Vorherige Seite"
            :disabled="previewPage === null || previewPage <= 1"
            @click="stepPreview(-1)"
          />
          <span class="cps-preview-pos">{{ previewPage }}&hairsp;/&hairsp;{{ pageCount }}</span>
          <Button
            icon="pi pi-chevron-right"
            text
            rounded
            size="small"
            aria-label="Nächste Seite"
            :disabled="previewPage === null || previewPage >= pageCount"
            @click="stepPreview(1)"
          />
        </div>
        <div class="cps-preview-group">
          <Button
            icon="pi pi-search-minus"
            text
            rounded
            size="small"
            aria-label="Verkleinern"
            :disabled="previewZoomIndex === 0"
            @click="zoomPreview(-1)"
          />
          <span class="cps-preview-pos">{{ Math.round(previewZoom * 100) }}&nbsp;%</span>
          <Button
            icon="pi pi-search-plus"
            text
            rounded
            size="small"
            aria-label="Vergrößern"
            :disabled="previewZoomIndex === PREVIEW_ZOOM_STEPS.length - 1"
            @click="zoomPreview(1)"
          />
        </div>
        <div class="cps-preview-group cps-preview-search">
          <IconField class="cps-search-field">
            <InputIcon class="pi pi-search" />
            <InputText
              v-model="query"
              type="search"
              size="small"
              placeholder="Suchen"
              aria-label="Im Text des Dokuments suchen"
              fluid
            />
          </IconField>
          <template v-if="term">
            <span class="cps-preview-pos" aria-live="polite">
              {{ previewPage !== null ? hitsOn(previewPage) : 0 }}
            </span>
            <Button
              icon="pi pi-chevron-up"
              text
              rounded
              size="small"
              aria-label="Seite mit vorherigem Treffer"
              :disabled="hitPages.length === 0"
              @click="jumpToHit(-1)"
            />
            <Button
              icon="pi pi-chevron-down"
              text
              rounded
              size="small"
              aria-label="Seite mit nächstem Treffer"
              :disabled="hitPages.length === 0"
              @click="jumpToHit(1)"
            />
          </template>
        </div>
      </div>

      <Message v-if="redactMode" severity="info" size="small" :closable="false">
        Rechteck aufziehen, um einen Bereich zu schwärzen. Im PDF der Mappe ist der Text darunter
        dann entfernt; das Dokument selbst bleibt unverändert.
      </Message>
      <Message v-if="previewError" severity="warn" :closable="false">{{ previewError }}</Message>

      <div ref="frameEl" class="cps-preview-frame">
        <div
          v-if="previewUrl"
          ref="canvasEl"
          class="cps-preview-canvas"
          :class="{ 'cps-preview-canvas--draw': redactMode }"
          :style="shownWidth ? { width: `${shownWidth}px` } : undefined"
          @pointerdown="onDrawStart"
          @pointermove="onDrawMove"
          @pointerup="onDrawEnd"
          @pointercancel="draft = null"
        >
          <img
            :src="previewUrl"
            :alt="previewPage !== null ? `Seite ${previewPage}` : ''"
            class="cps-preview-img"
            draggable="false"
          />
          <span
            v-for="(rect, i) in previewHitRects"
            :key="`hit-${i}`"
            class="cps-hit"
            :style="boxStyle(rect)"
            aria-hidden="true"
          />
          <template v-if="previewPage !== null">
            <div
              v-for="{ box, index } in boxesOn(previewPage)"
              :key="index"
              class="cps-box"
              :style="boxStyle(box)"
            >
              <button
                v-if="redactMode"
                type="button"
                class="cps-box-remove"
                aria-label="Schwärzung entfernen"
                @pointerdown.stop
                @click="removeRedaction(index)"
              >
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </div>
          </template>
          <div v-if="draftBox" class="cps-box cps-box--draft" :style="boxStyle(draftBox)" />
        </div>
        <ProgressSpinner v-if="previewLoading" class="cps-preview-spinner" style="width: 36px; height: 36px" />
      </div>
    </div>
    <template #footer>
      <div class="cps-preview-include">
        <Checkbox v-model="previewIncluded" binary input-id="cps-preview-include" />
        <label for="cps-preview-include">Seite übernehmen</label>
      </div>
      <span class="cps-preview-spacer" />
      <Button
        icon="pi pi-eye-slash"
        label="Schwärzen"
        :outlined="!redactMode"
        :severity="redactMode ? undefined : 'secondary'"
        :badge="previewBoxCount > 0 ? String(previewBoxCount) : undefined"
        :aria-pressed="redactMode"
        :disabled="!previewUrl"
        @click="redactMode = !redactMode"
      />
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
.cps-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.cps-search-field {
  flex: 1 1 12rem;
  min-width: 0;
}
.cps-search-summary {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.cps-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
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
.cps-canvas {
  position: relative;
  display: block;
  width: 100%;
}
.cps-canvas img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.cps-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
}
.cps-page--off {
  border-color: var(--p-content-border-color);
}
.cps-page--off img {
  opacity: 0.35;
  filter: grayscale(1);
}
/* A hit outranks the selection colour: finding the page is the point. */
.cps-page--hit {
  box-shadow: 0 0 0 3px rgba(255, 200, 0, 0.9);
}
.cps-page--miss {
  opacity: 0.55;
}
/* A redaction box: black in both themes, because that is what the PDF gets. */
.cps-box {
  position: absolute;
  background: #000; /* audit-ok: the redaction is black in the PDF, whatever the theme */
}
.cps-box--draft {
  background: rgba(0, 0, 0, 0.55);
  outline: 2px dashed var(--p-primary-color);
}
/* A search hit: a translucent marker over the page, light or dark theme alike. */
.cps-hit {
  position: absolute;
  pointer-events: none;
  background: rgba(255, 200, 0, 0.4);
  border-radius: 2px;
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
/* Labels float on the page thumbnail, not on a themed surface: the dark scrim
   gives them their own background in both themes, so the text stays white. */
.cps-label,
.cps-redacted,
.cps-hits {
  pointer-events: none;
  position: absolute;
  bottom: 6px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: var(--text-sm);
  background: rgba(0, 0, 0, 0.55);
  color: #fff; /* audit-ok: white on the fixed dark scrim above, not on a theme surface */
}
.cps-label {
  left: 6px;
}
.cps-redacted,
.cps-hits {
  right: 6px;
}

.cps-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* Room between the page and the buttons below it. */
  padding-bottom: var(--space-3);
}
.cps-preview-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1) var(--space-3);
}
.cps-preview-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.cps-preview-search {
  flex: 1 1 14rem;
  justify-content: flex-end;
  min-width: 0;
}
.cps-preview-pos {
  min-width: 2.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* Scrolls once the page is zoomed past what fits. A block with an auto
   margin centres the page while it fits and keeps its left edge reachable
   once it does not — a centred grid item would overflow to both sides. */
.cps-preview-frame {
  position: relative;
  display: block;
  min-height: 200px;
  max-height: 62dvh;
  overflow: auto;
  overscroll-behavior: contain;
}
.cps-preview-canvas {
  position: relative;
  margin-inline: auto;
  user-select: none;
}
.cps-preview-canvas--draw {
  cursor: crosshair;
  touch-action: none;
}
.cps-box-remove {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 22px;
  height: 22px;
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
.cps-box-remove::before {
  content: '';
  position: absolute;
  inset: -8px;
}
.cps-box-remove:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.cps-preview-img {
  display: block;
  width: 100%;
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
.cps-preview-include {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}
.cps-preview-spacer {
  flex: 1 1 auto;
}
</style>
