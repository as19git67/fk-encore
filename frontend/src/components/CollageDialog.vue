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
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'
import Message from 'primevue/message'
import Popover from 'primevue/popover'
import Textarea from 'primevue/textarea'
import SelectButton from 'primevue/selectbutton'
import { getPhotoDetailsBatch, getPhotoUrl, type Photo } from '../api/photos'
import {
  collageLayouts,
  collageObjectPosition,
  coverCropRect,
  swapOrder,
  type CollageLayout,
} from '../utils/collageLayouts'
import {
  COLLAGE_TEXT_FONTS,
  collageFontPreset,
  clampUnit,
  defaultTextOverlay,
  wrapLines,
  type CollageTextOverlay,
} from '../utils/collageText'

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
  textEnabled.value = false
  textOverlay.value = defaultTextOverlay()
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

// ── Text overlay (one caption laid over the whole collage) ──────────────────
// Positioned by its normalized centre so it survives layout switches and
// renders identically in the preview and the exported JPEG. A press starts a
// drag; a tap (no movement) opens the editor popover anchored to the text.
const textEnabled = ref(false)
const textOverlay = ref<CollageTextOverlay>(defaultTextOverlay())
const textPopover = ref<InstanceType<typeof Popover> | null>(null)
const textElRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const textDragging = ref(false)
let textStartX = 0
let textStartY = 0
let textMoved = false
let stageRect: DOMRect | null = null

const ALIGN_OPTIONS = [
  { label: 'Links', value: 'left', icon: 'pi pi-align-left' },
  { label: 'Zentriert', value: 'center', icon: 'pi pi-align-center' },
  { label: 'Rechts', value: 'right', icon: 'pi pi-align-right' },
]

// Font size as a `cqh` length so the preview scales with the rendered stage
// height — the same fraction the export applies to the canvas height.
const overlayFontSize = computed(
  () => `${collageFontPreset(textOverlay.value.fontKey).heightFraction * 100}cqh`,
)

const overlayDisplayText = computed(() =>
  textOverlay.value.text.trim() ? textOverlay.value.text : 'Text eingeben …',
)

function addText(ev: MouseEvent) {
  textEnabled.value = true
  textOverlay.value = defaultTextOverlay()
  void nextTick(() => {
    if (textElRef.value) textPopover.value?.show(ev, textElRef.value)
  })
}

function removeText() {
  textEnabled.value = false
  textPopover.value?.hide()
}

function onTextPointerDown(ev: PointerEvent) {
  if (ev.button != null && ev.button !== 0) return
  // Keep the press off the photo cells underneath — text owns this gesture.
  ev.stopPropagation()
  const stage = stageRef.value
  if (!stage) return
  stageRect = stage.getBoundingClientRect()
  textStartX = ev.clientX
  textStartY = ev.clientY
  textMoved = false
  textDragging.value = true
  window.addEventListener('pointermove', onTextPointerMove)
  window.addEventListener('pointerup', onTextPointerUp)
  window.addEventListener('pointercancel', onTextPointerUp)
}

function onTextPointerMove(ev: PointerEvent) {
  if (!textDragging.value || !stageRect) return
  if (!textMoved) {
    const moved = Math.hypot(ev.clientX - textStartX, ev.clientY - textStartY)
    if (moved < 6) return
    textMoved = true
    // A drag has begun — close the editor so it doesn't hang at the old anchor.
    textPopover.value?.hide()
  }
  ev.preventDefault()
  textOverlay.value.x = clampUnit((ev.clientX - stageRect.left) / stageRect.width)
  textOverlay.value.y = clampUnit((ev.clientY - stageRect.top) / stageRect.height)
}

function onTextPointerUp() {
  window.removeEventListener('pointermove', onTextPointerMove)
  window.removeEventListener('pointerup', onTextPointerUp)
  window.removeEventListener('pointercancel', onTextPointerUp)
  textDragging.value = false
  stageRect = null
  // `textMoved` is consumed by the click handler that follows a tap so a drag
  // doesn't also open the editor; a genuine tap leaves it false → click opens.
}

function onTextClick(ev: MouseEvent) {
  if (textMoved) {
    textMoved = false
    return
  }
  textPopover.value?.toggle(ev, textElRef.value)
}

function drawTextOverlay(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const overlay = textOverlay.value
  const text = overlay.text.trim()
  if (!text) return
  const fontPx = collageFontPreset(overlay.fontKey).heightFraction * height
  if (!(fontPx > 0)) return
  ctx.font = `700 ${fontPx}px ${TEXT_FONT_STACK}`
  ctx.textBaseline = 'alphabetic'
  const maxWidth = width * 0.9
  const lines = wrapLines(overlay.text, maxWidth, (s) => ctx.measureText(s).width)
  const lineHeight = fontPx * 1.25
  const blockHeight = lineHeight * lines.length
  const blockWidth = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0)
  const cx = clampUnit(overlay.x) * width
  const cy = clampUnit(overlay.y) * height

  // Horizontal anchor mirrors the shrink-to-fit, centred preview box: each
  // line aligns within a block whose centre sits at `cx`.
  ctx.textAlign = overlay.align
  const anchorX =
    overlay.align === 'left'
      ? cx - blockWidth / 2
      : overlay.align === 'right'
        ? cx + blockWidth / 2
        : cx

  // Dark stroke + white fill keeps the caption legible over any photo.
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, fontPx * 0.08)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
  ctx.fillStyle = '#ffffff'

  // First baseline ≈ top of the block + one ascent (~0.8em).
  let baseline = cy - blockHeight / 2 + fontPx * 0.8
  for (const line of lines) {
    if (line) {
      ctx.strokeText(line, anchorX, baseline)
      ctx.fillText(line, anchorX, baseline)
    }
    baseline += lineHeight
  }
}

// Matches the preview overlay font (app default = Inter), bold.
const TEXT_FONT_STACK = "'Inter', system-ui, -apple-system, sans-serif"

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

  if (textEnabled.value) {
    // Wait for the web font so the caption isn't drawn with a fallback face.
    try {
      await (document as Document & { fonts?: FontFaceSet }).fonts?.ready
    } catch {
      /* fonts API unavailable — fall back to whatever is loaded */
    }
    drawTextOverlay(ctx, width, height)
  }

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
  window.removeEventListener('pointermove', onTextPointerMove)
  window.removeEventListener('pointerup', onTextPointerUp)
  window.removeEventListener('pointercancel', onTextPointerUp)
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
        Zum Tauschen ein Foto auf ein anderes ziehen.<template v-if="textEnabled">
          Den Text ziehen zum Verschieben, antippen zum Bearbeiten.</template>
      </p>
      <div
        ref="stageRef"
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

        <!-- Free text overlay laid over the whole collage. Drag to position
             (initially centred), tap to open the editor popover. -->
        <div
          v-if="textEnabled"
          ref="textElRef"
          class="collage-text-overlay"
          :class="{
            'collage-text-overlay--empty': !textOverlay.text.trim(),
            'collage-text-overlay--dragging': textDragging,
          }"
          :style="{
            left: `${textOverlay.x * 100}%`,
            top: `${textOverlay.y * 100}%`,
            fontSize: overlayFontSize,
            textAlign: textOverlay.align,
          }"
          @pointerdown="onTextPointerDown"
          @click="onTextClick"
        >{{ overlayDisplayText }}</div>
      </div>
    </div>

    <!-- Text editor popover (anchored to the overlay) -->
    <Popover ref="textPopover">
      <div class="collage-text-editor">
        <Textarea
          v-model="textOverlay.text"
          auto-resize
          rows="2"
          placeholder="Text über die Collage …"
          class="collage-text-editor__area"
        />
        <div class="collage-text-editor__field">
          <span class="collage-text-editor__label">Schriftgröße</span>
          <SelectButton
            v-model="textOverlay.fontKey"
            :options="COLLAGE_TEXT_FONTS"
            option-label="label"
            option-value="key"
            :allow-empty="false"
            aria-label="Schriftgröße"
          />
        </div>
        <div class="collage-text-editor__field">
          <span class="collage-text-editor__label">Ausrichtung</span>
          <SelectButton
            v-model="textOverlay.align"
            :options="ALIGN_OPTIONS"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            aria-label="Ausrichtung"
          >
            <template #option="{ option }">
              <i :class="option.icon" :title="option.label" aria-hidden="true" />
            </template>
          </SelectButton>
        </div>
        <div class="collage-text-editor__actions">
          <Button
            label="Entfernen"
            icon="pi pi-trash"
            severity="danger"
            text
            size="small"
            @click="removeText"
          />
          <Button
            label="Fertig"
            icon="pi pi-check"
            text
            size="small"
            @click="textPopover?.hide()"
          />
        </div>
      </div>
    </Popover>

    <template #footer>
      <div class="collage-footer">
        <Button
          v-if="step === 'editor'"
          class="collage-footer__back"
          icon="pi pi-arrow-left"
          label="Zurück"
          severity="secondary"
          text
          v-tooltip.top="'Zurück'"
          @click="backToLayouts"
        />
        <Button
          v-if="step === 'editor' && !textEnabled"
          class="collage-footer__text"
          icon="pi pi-pencil"
          label="Text"
          severity="secondary"
          outlined
          v-tooltip.top="'Text hinzufügen'"
          @click="addText"
        />
        <span class="collage-footer-spacer" />
        <Button
          class="collage-footer__cancel"
          icon="pi pi-times"
          label="Abbrechen"
          severity="secondary"
          text
          v-tooltip.top="'Abbrechen'"
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
  /* Establishes the query container so the overlay font can size in `cqh`
     (% of the stage height), matching the export's fraction-of-canvas math. */
  container-type: size;
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

/* ── Text overlay ─────────────────────────────────────────────────────────── */
.collage-text-overlay {
  position: absolute;
  transform: translate(-50%, -50%);
  max-width: 90%;
  margin: 0;
  padding: 0.05em 0.15em;
  color: #fff;
  font-weight: 700;
  line-height: 1.25;
  /* Legible over any photo: soft dark halo around white glyphs. */
  text-shadow:
    0 1px 3px rgba(0, 0, 0, 0.7),
    0 0 2px rgba(0, 0, 0, 0.85);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  cursor: move;
  user-select: none;
  touch-action: none;
  z-index: 5;
}
.collage-text-overlay--empty {
  font-style: italic;
  opacity: 0.85;
}
.collage-text-overlay--dragging {
  outline: 2px dashed rgba(255, 255, 255, 0.85);
  outline-offset: 2px;
}

/* ── Text editor popover ──────────────────────────────────────────────────── */
.collage-text-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(20rem, 80vw);
}
.collage-text-editor__area {
  width: 100%;
  resize: vertical;
}
.collage-text-editor__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.collage-text-editor__label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.collage-text-editor__actions {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
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

/* On narrow screens the footer has little horizontal room. Hide button labels
   and keep only the icons so everything fits in one row. The tooltip still
   shows the full label on hover/long-press. */
@media (max-width: 480px) {
  .collage-footer__back :deep(.p-button-label),
  .collage-footer__text :deep(.p-button-label),
  .collage-footer__cancel :deep(.p-button-label) {
    display: none;
  }
}
</style>
