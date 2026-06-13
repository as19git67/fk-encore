<script setup lang="ts">
/**
 * Collage creator dialog.
 *
 * Opened from the gallery / album select-bar when 2..9 photos are selected.
 * Two steps:
 *   1. Layout picker — three layout variants for the current photo count;
 *      tapping one advances to the editor.
 *   2. Editor — the chosen layout rendered large, each placeholder filled
 *      with a photo. Faces are nudged toward the visible centre
 *      of every cell using the gallery's `auto_crop` focal point (the same
 *      algorithm as the thumbnail grid, see `collageObjectPosition` /
 *      `coverCropRect`). Two photos can be swapped by dragging one onto the
 *      other (pointer-based, works on touch + mouse). The share button
 *      renders the collage to a JPEG and hands it to the Web Share API
 *      (falling back to a download where unsupported).
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'
import Message from 'primevue/message'
import { getPhotoDetailsBatch, getPhotoUrl, type Photo } from '../api/photos'
import {
  collageLayouts,
  collageObjectPosition,
  coverCropRect,
  swapOrder,
  type CollageLayout,
} from '../utils/collageLayouts'

const props = defineProps<{
  visible: boolean
  photoIds: number[]
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

interface CollagePhoto {
  id: number
  filename: string
  autoCrop?: { x: number; y: number } | null
  url: string
  img: HTMLImageElement
}

type Step = 'layouts' | 'editor'

const step = ref<Step>('layouts')
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const photos = ref<CollagePhoto[]>([])
const selectedLayout = ref<CollageLayout | null>(null)
// `order[cellIndex]` = index into `photos` shown in that cell.
const order = ref<number[]>([])
const sharing = ref(false)

const layouts = computed(() => collageLayouts(photos.value.length))

// Pixel long-edge of the exported JPEG; cells inherit their share of it.
const EXPORT_LONG_EDGE = 2000
const GAP_FRACTION = 0.006 // gap between cells, fraction of the long edge

function close() {
  emit('update:visible', false)
}

function isHeic(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.heic') || lower.endsWith('.heif')
}

// Mirrors HeicImage.vue: Safari decodes HEIC natively, everyone else needs
// the server-side `?convert=true` JPEG. We retry once with convert on error
// to cover the UA-detection blind spots noted there.
function resolveSrc(filename: string, convert: boolean): string {
  const base = getPhotoUrl(filename, 1600)
  if (!convert) return base
  return `${base}${base.includes('?') ? '&' : '?'}convert=true`
}

function loadImage(filename: string): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
    const wantConvert = isHeic(filename) && !isSafari
    let triedConvert = wantConvert
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve({ img, url: img.src })
    img.onerror = () => {
      if (isHeic(filename) && !triedConvert) {
        triedConvert = true
        img.src = resolveSrc(filename, true)
        return
      }
      reject(new Error(`Bild konnte nicht geladen werden: ${filename}`))
    }
    img.src = resolveSrc(filename, wantConvert)
  })
}

async function loadPhotos() {
  loading.value = true
  errorMsg.value = null
  photos.value = []
  selectedLayout.value = null
  order.value = []
  step.value = 'layouts'
  const ids = props.photoIds.slice()
  try {
    const { photos: details } = await getPhotoDetailsBatch(ids)
    const byId = new Map<number, Photo>(details.map((p) => [p.id, p]))
    // Preserve the selection order; drop any id the server didn't return.
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is Photo => !!p)
    const loaded = await Promise.all(
      ordered.map(async (p) => {
        const { img, url } = await loadImage(p.filename)
        return {
          id: p.id,
          filename: p.filename,
          autoCrop: p.auto_crop ?? null,
          url,
          img,
        } satisfies CollagePhoto
      }),
    )
    photos.value = loaded
    order.value = loaded.map((_, i) => i)
  } catch (err) {
    errorMsg.value =
      err instanceof Error ? err.message : 'Die Fotos konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function pickLayout(layout: CollageLayout) {
  selectedLayout.value = layout
  order.value = photos.value.map((_, i) => i)
  step.value = 'editor'
}

function backToLayouts() {
  step.value = 'layouts'
  selectedLayout.value = null
}

function photoForCell(cellIndex: number): CollagePhoto | undefined {
  const photoIndex = order.value[cellIndex]
  return photoIndex == null ? undefined : photos.value[photoIndex]
}

function cellStyle(cell: { x: number; y: number; w: number; h: number }) {
  return {
    left: `${cell.x * 100}%`,
    top: `${cell.y * 100}%`,
    width: `${cell.w * 100}%`,
    height: `${cell.h * 100}%`,
  }
}

function imgStyle(photo: CollagePhoto | undefined) {
  if (!photo) return {}
  return { objectPosition: collageObjectPosition(photo.autoCrop) }
}

// ── Drag & drop (pointer-based, swaps two cells) ────────────────────────────
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)
const dragging = ref(false)
const ghostStyle = ref<Record<string, string>>({})
const ghostUrl = ref<string | null>(null)
let startX = 0
let startY = 0

function cellIndexAtPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)
  const cellEl = el?.closest<HTMLElement>('[data-cell-index]')
  if (!cellEl) return null
  const idx = Number(cellEl.dataset.cellIndex)
  return Number.isFinite(idx) ? idx : null
}

function onCellPointerDown(cellIndex: number, ev: PointerEvent) {
  if (ev.button != null && ev.button !== 0) return
  dragFrom.value = cellIndex
  dragging.value = false
  startX = ev.clientX
  startY = ev.clientY
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function onPointerMove(ev: PointerEvent) {
  if (dragFrom.value == null) return
  if (!dragging.value) {
    const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY)
    if (moved < 8) return
    dragging.value = true
    ghostUrl.value = photoForCell(dragFrom.value)?.url ?? null
  }
  ev.preventDefault()
  const size = 96
  ghostStyle.value = {
    left: `${ev.clientX - size / 2}px`,
    top: `${ev.clientY - size / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
  }
  dragOver.value = cellIndexAtPoint(ev.clientX, ev.clientY)
}

function onPointerUp(ev: PointerEvent) {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  const from = dragFrom.value
  if (dragging.value && from != null) {
    const target = cellIndexAtPoint(ev.clientX, ev.clientY)
    if (target != null && target !== from) {
      order.value = swapOrder(order.value, from, target)
    }
  }
  dragFrom.value = null
  dragOver.value = null
  dragging.value = false
  ghostUrl.value = null
}

// ── Render to JPEG + share ──────────────────────────────────────────────────
async function buildCollageBlob(): Promise<Blob> {
  const layout = selectedLayout.value
  if (!layout) throw new Error('Kein Layout ausgewählt.')
  const aspect = layout.aspect
  const width = aspect >= 1 ? EXPORT_LONG_EDGE : Math.round(EXPORT_LONG_EDGE * aspect)
  const height = aspect >= 1 ? Math.round(EXPORT_LONG_EDGE / aspect) : EXPORT_LONG_EDGE
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas wird nicht unterstützt.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  const gap = Math.round(EXPORT_LONG_EDGE * GAP_FRACTION)
  layout.cells.forEach((cell, i) => {
    const photo = photoForCell(i)
    if (!photo) return
    const dx = cell.x * width + gap / 2
    const dy = cell.y * height + gap / 2
    const dw = cell.w * width - gap
    const dh = cell.h * height - gap
    if (dw <= 0 || dh <= 0) return
    const { naturalWidth, naturalHeight } = photo.img
    const src = coverCropRect(naturalWidth, naturalHeight, dw / dh, photo.autoCrop)
    ctx.drawImage(photo.img, src.sx, src.sy, src.sw, src.sh, dx, dy, dw, dh)
  })

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG konnte nicht erzeugt werden.'))),
      'image/jpeg',
      0.92,
    )
  })
}

async function shareCollage() {
  if (sharing.value) return
  sharing.value = true
  errorMsg.value = null
  try {
    const blob = await buildCollageBlob()
    const file = new File([blob], `collage-${Date.now()}.jpg`, { type: 'image/jpeg' })
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean
    }
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Collage' })
      } catch (err) {
        // User cancelled the share sheet — not an error worth surfacing.
        if (err instanceof DOMException && err.name === 'AbortError') return
        throw err
      }
    } else {
      // No Web Share API (or no file sharing) → download the JPEG.
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    errorMsg.value =
      err instanceof Error ? err.message : 'Die Collage konnte nicht erstellt werden.'
  } finally {
    sharing.value = false
  }
}

const dialogHeader = computed(() =>
  step.value === 'layouts' ? 'Layout wählen' : 'Collage bearbeiten',
)

watch(
  () => props.visible,
  (visible) => {
    if (visible) void loadPhotos()
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="dialogHeader"
    :style="{ width: '92vw', maxWidth: '900px' }"
    :dismissable-mask="true"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div v-if="loading" class="collage-loading">
      <ProgressSpinner style="width: 3rem; height: 3rem" />
      <span>Fotos werden geladen …</span>
    </div>

    <Message v-else-if="errorMsg" severity="error" :closable="false">
      {{ errorMsg }}
    </Message>

    <!-- Step 1: layout picker -->
    <div v-else-if="step === 'layouts'" class="collage-picker">
      <p class="collage-hint">
        Wähle ein Layout für deine {{ photos.length }} Fotos.
      </p>
      <div class="collage-variants">
        <button
          v-for="layout in layouts"
          :key="layout.id"
          type="button"
          class="collage-variant"
          @click="pickLayout(layout)"
        >
          <div class="collage-variant-canvas" :style="{ aspectRatio: String(layout.aspect) }">
            <div
              v-for="(cell, i) in layout.cells"
              :key="i"
              class="collage-variant-cell"
              :style="cellStyle(cell)"
            >
              <img
                v-if="photos[i]"
                :src="photos[i]!.url"
                :style="imgStyle(photos[i])"
                alt=""
                draggable="false"
              />
            </div>
          </div>
          <span class="collage-variant-name">{{ layout.name }}</span>
        </button>
      </div>
    </div>

    <!-- Step 2: editor -->
    <div v-else-if="step === 'editor' && selectedLayout" class="collage-editor">
      <p class="collage-hint">
        Zum Tauschen ein Foto auf ein anderes ziehen.
      </p>
      <div
        class="collage-stage"
        :style="{ aspectRatio: String(selectedLayout.aspect) }"
      >
        <div
          v-for="(cell, i) in selectedLayout.cells"
          :key="i"
          class="collage-cell"
          :class="{
            'collage-cell--over': dragOver === i && dragFrom !== i,
            'collage-cell--source': dragging && dragFrom === i,
          }"
          :data-cell-index="i"
          :style="cellStyle(cell)"
          @pointerdown="onCellPointerDown(i, $event)"
        >
          <img
            v-if="photoForCell(i)"
            :src="photoForCell(i)!.url"
            :style="imgStyle(photoForCell(i))"
            alt=""
            draggable="false"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <div class="collage-footer">
        <Button
          v-if="step === 'editor'"
          label="Zurück"
          icon="pi pi-arrow-left"
          severity="secondary"
          text
          @click="backToLayouts"
        />
        <span class="collage-footer-spacer" />
        <Button
          label="Abbrechen"
          icon="pi pi-times"
          severity="secondary"
          text
          @click="close"
        />
        <Button
          v-if="step === 'editor'"
          label="Teilen"
          icon="pi pi-share-alt"
          :loading="sharing"
          @click="shareCollage"
        />
      </div>
    </template>

    <!-- Floating drag ghost -->
    <Teleport to="body">
      <div v-if="dragging && ghostUrl" class="collage-ghost" :style="ghostStyle">
        <img :src="ghostUrl" alt="" draggable="false" />
      </div>
    </Teleport>
  </Dialog>
</template>

<style scoped>
.collage-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 2rem 0;
  color: var(--p-text-muted-color);
}

.collage-hint {
  margin: 0 0 1rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.collage-variants {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}

.collage-variant {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.4rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-border-radius, 8px);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.collage-variant:hover {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--p-primary-color) inset;
}

.collage-variant-canvas {
  position: relative;
  width: 100%;
  background: var(--p-content-hover-background);
  border-radius: 4px;
  overflow: hidden;
}
.collage-variant-cell {
  position: absolute;
  padding: 1px;
}
.collage-variant-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 2px;
}
.collage-variant-name {
  text-align: center;
  font-size: 0.8rem;
  color: var(--p-text-color);
}

.collage-stage {
  position: relative;
  width: 100%;
  max-height: 65vh;
  margin: 0 auto;
  background: var(--p-content-hover-background);
  border-radius: 4px;
  overflow: hidden;
  touch-action: none;
}
.collage-cell {
  position: absolute;
  padding: 2px;
  cursor: grab;
  touch-action: none;
}
.collage-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 2px;
  pointer-events: none;
  user-select: none;
}
.collage-cell--over img {
  outline: 3px solid var(--p-primary-color);
  outline-offset: -3px;
}
.collage-cell--source {
  opacity: 0.4;
}

.collage-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}
.collage-footer-spacer {
  flex: 1;
}

.collage-ghost {
  position: fixed;
  z-index: 2000;
  pointer-events: none;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  opacity: 0.9;
}
.collage-ghost img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
