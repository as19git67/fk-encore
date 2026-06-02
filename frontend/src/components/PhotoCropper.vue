<script setup lang="ts">
/**
 * Interactive crop overlay. Phase 5b of the AI photo-transforms feature.
 *
 * Shows the full original image (with the live colour recipe applied),
 * dims the outside-crop area, and lets the user pan the crop rectangle
 * + drag any of 8 handles to resize. Optional aspect-ratio constraint
 * keeps the chosen ratio while resizing. Coordinates are normalised
 * (0..1) so the value is independent of the rendered preview size.
 *
 * Math:
 *   - Image is rendered with `object-fit: contain` inside the wrapper.
 *     The rendered image's pixel rect is derived from the wrapper's
 *     own pixel rect + the image's aspect ratio. All hit-testing
 *     happens against that rendered-image rect.
 *   - Drag deltas are converted from container px → normalised image
 *     units via 1/renderedWidth and 1/renderedHeight.
 *   - Aspect-ratio constraint (when active) locks the ratio: corner
 *     drags adjust both dims; edge drags adjust the other dim
 *     proportionally and re-centre around the opposite edge.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import type { PhotoTransformCrop } from '../utils/photoTransformRecipe'
import { computeNextCrop, type CropHandle } from '../utils/photoCropDrag'
import { containFit, cropToWrapper } from '../utils/cropperFit'

const props = defineProps<{
  src: string
  crop: PhotoTransformCrop
  /** Pixel aspect ratio of the image. Used to lay out the wrapper. */
  imageAspect: number
  /** Crop aspect ratio (w/h) to lock to. null = free crop. */
  aspectRatio: number | null
  /** CSS to apply to the image element (filters, etc). */
  imgStyle?: CSSProperties
}>()

const emit = defineEmits<{
  (e: 'update:crop', v: PhotoTransformCrop): void
}>()

const wrapper = ref<HTMLDivElement | null>(null)
const dragging = ref(false)

// Measured wrapper size. The image is `object-fit: contain` inside the
// wrapper; when the wrapper's aspect doesn't match the image's (e.g. a
// portrait image in a wider cell, where `width: 100%` makes the wrapper wider
// than the image), the image is letterboxed/pillarboxed. We map the crop
// overlay onto the *rendered image* rect so it never spills into those bars.
const wrapperW = ref(0)
const wrapperH = ref(0)
let resizeObserver: ResizeObserver | null = null

function measureWrapper() {
  const el = wrapper.value
  if (!el) return
  wrapperW.value = el.clientWidth
  wrapperH.value = el.clientHeight
}

/** Rendered image rect inside the wrapper, as fractions of the wrapper. */
const fit = computed(() => containFit(wrapperW.value, wrapperH.value, props.imageAspect))

onMounted(() => {
  measureWrapper()
  if (typeof ResizeObserver !== 'undefined' && wrapper.value) {
    resizeObserver = new ResizeObserver(measureWrapper)
    resizeObserver.observe(wrapper.value)
  }
})

// Pointer-state for the active drag.
interface DragState {
  handle: CropHandle
  startCrop: PhotoTransformCrop
  startX: number
  startY: number
  rectWidth: number  // rendered image width in px
  rectHeight: number // rendered image height in px
}
let active: DragState | null = null

const handleList: Exclude<CropHandle, 'body'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

// Crop rect mapped from image coords onto the rendered-image rect inside the
// wrapper (accounts for letterbox/pillarbox).
const rectFrac = computed(() => cropToWrapper(props.crop, fit.value))

const rectStyle = computed<CSSProperties>(() => ({
  left: `${rectFrac.value.left * 100}%`,
  top: `${rectFrac.value.top * 100}%`,
  width: `${rectFrac.value.width * 100}%`,
  height: `${rectFrac.value.height * 100}%`,
}))

// Dim overlay — four absolutely-positioned strips around the crop rect. Uses
// the mapped rect so the dimming (and the bright crop window) align with the
// visible image; the inert letterbox bars get dimmed too, which is invisible
// against the dark background.
const dimStyles = computed(() => {
  const { left, top, width, height } = rectFrac.value
  return {
    top: { top: 0, left: 0, right: 0, height: `${top * 100}%` },
    bottom: { left: 0, right: 0, bottom: 0, top: `${(top + height) * 100}%` },
    left: {
      top: `${top * 100}%`,
      bottom: `${(1 - top - height) * 100}%`,
      left: 0,
      width: `${left * 100}%`,
    },
    right: {
      top: `${top * 100}%`,
      bottom: `${(1 - top - height) * 100}%`,
      right: 0,
      width: `${(1 - left - width) * 100}%`,
    },
  } as Record<'top' | 'bottom' | 'left' | 'right', Record<string, string | number>>
})

function startDrag(handle: CropHandle, ev: PointerEvent) {
  if (!wrapper.value) return
  const rect = renderedImageRect()
  if (!rect) return
  active = {
    handle,
    startCrop: { ...props.crop },
    startX: ev.clientX,
    startY: ev.clientY,
    rectWidth: rect.width,
    rectHeight: rect.height,
  }
  dragging.value = true
  ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
  ev.preventDefault()
}

function onPointerMove(ev: PointerEvent) {
  if (!active) return
  const dx = (ev.clientX - active.startX) / active.rectWidth
  const dy = (ev.clientY - active.startY) / active.rectHeight
  const next = computeNextCrop(active.handle, active.startCrop, dx, dy, props.aspectRatio)
  if (next) emit('update:crop', next)
}

function endDrag(ev: PointerEvent) {
  if (!active) return
  ;(ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId)
  active = null
  dragging.value = false
}

/**
 * Keyboard shortcuts. The cropper has tabindex=0 so it accepts focus.
 *   Arrow keys           pan by 1 % of the image dimension
 *   Shift + Arrow keys   pan by 5 %
 *   Alt + Arrow keys     resize from the SE handle (width/height)
 *   Shift + Alt + Arrow  resize from the SE handle by 5 %
 *   Home / End           jump crop to left / right edge
 *   PageUp / PageDown    jump crop to top / bottom edge
 *
 * Aspect-ratio lock is respected the same way it is during a mouse drag.
 */
function onKeydown(ev: KeyboardEvent) {
  const step = ev.shiftKey ? 0.05 : 0.01
  const ratio = props.aspectRatio
  const start = props.crop
  let dx = 0
  let dy = 0
  let handle: CropHandle = 'body'

  switch (ev.key) {
    case 'ArrowLeft':
      dx = -step
      break
    case 'ArrowRight':
      dx = step
      break
    case 'ArrowUp':
      dy = -step
      break
    case 'ArrowDown':
      dy = step
      break
    case 'Home':
      dx = -1
      break
    case 'End':
      dx = 1
      break
    case 'PageUp':
      dy = -1
      break
    case 'PageDown':
      dy = 1
      break
    default:
      return
  }

  if (ev.altKey && (ev.key.startsWith('Arrow'))) {
    handle = 'se'
  }

  const next = computeNextCrop(handle, start, dx, dy, ratio)
  if (next) {
    ev.preventDefault()
    emit('update:crop', next)
  }
}

/**
 * The rendered image's pixel rectangle inside the wrapper. The image is
 * `object-fit: contain`, so when the wrapper aspect differs from the image
 * aspect the image is letterboxed/pillarboxed — derive the real image rect
 * from the wrapper rect and the contained-fit fractions. Used to convert drag
 * deltas (screen px) into normalised image units.
 */
function renderedImageRect(): DOMRect | null {
  const r = wrapper.value?.getBoundingClientRect()
  if (!r) return null
  const f = fit.value
  return new DOMRect(
    r.left + f.ox * r.width,
    r.top + f.oy * r.height,
    f.ow * r.width,
    f.oh * r.height,
  )
}

onBeforeUnmount(() => {
  active = null
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    class="cropper-wrap"
    ref="wrapper"
    tabindex="0"
    :style="{ aspectRatio: String(imageAspect) }"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @keydown="onKeydown"
  >
    <img
      :src="src"
      alt=""
      class="cropper-img"
      :style="imgStyle"
      draggable="false"
    />

    <!-- Darken outside-crop areas -->
    <div class="dim" :style="dimStyles.top"></div>
    <div class="dim" :style="dimStyles.bottom"></div>
    <div class="dim" :style="dimStyles.left"></div>
    <div class="dim" :style="dimStyles.right"></div>

    <!-- Crop rectangle -->
    <div
      class="crop-rect"
      :class="{ dragging }"
      :style="rectStyle"
      @pointerdown="startDrag('body', $event)"
    >
      <!-- Rule-of-thirds grid (visible always; brighter while dragging) -->
      <div class="rot-grid" :class="{ active: dragging }">
        <div class="rot-line v1"></div>
        <div class="rot-line v2"></div>
        <div class="rot-line h1"></div>
        <div class="rot-line h2"></div>
      </div>

      <!-- Handles -->
      <div
        v-for="h in handleList"
        :key="h"
        :class="['handle', `handle-${h}`]"
        @pointerdown.stop="startDrag(h, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * Cropper fits its allocated parent cell. The parent is expected to
 * provide a bounded box (e.g. via grid-template-rows /
 * grid-template-columns + minmax). max-width / max-height: 100 %
 * combined with the inline aspect-ratio on the wrapper means the
 * browser picks the largest size that respects both axes and the
 * aspect — i.e. a contain-fit inside the cell.
 *
 * The 0.5 rem reservation on each axis leaves room for the corner
 * handles (positioned at -7 px relative to .cropper-wrap) so they
 * never poke through the parent's overflow:hidden bound when the
 * cropper exactly fills the cell.
 */
.cropper-wrap {
  position: relative;
  max-width: calc(100% - 1rem);
  max-height: calc(100% - 1rem);
  width: 100%;
  margin: 0 auto;
  background: rgba(0, 0, 0, 0.05);
  user-select: none;
  touch-action: none;
  outline: none;
}

.cropper-wrap:focus-visible {
  outline: 2px solid var(--p-primary-color, #6366f1);
  outline-offset: 2px;
}

.cropper-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  pointer-events: none;
}

.dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

.crop-rect {
  position: absolute;
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  cursor: move;
}

.crop-rect.dragging {
  border-color: var(--p-primary-color, #6366f1);
}

.rot-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}

.rot-grid.active {
  opacity: 0.6;
}

.rot-line {
  position: absolute;
  background: rgba(255, 255, 255, 0.7);
}

.rot-line.v1,
.rot-line.v2 {
  top: 0;
  bottom: 0;
  width: 1px;
}

.rot-line.v1 {
  left: 33.333%;
}

.rot-line.v2 {
  left: 66.666%;
}

.rot-line.h1,
.rot-line.h2 {
  left: 0;
  right: 0;
  height: 1px;
}

.rot-line.h1 {
  top: 33.333%;
}

.rot-line.h2 {
  top: 66.666%;
}

.handle {
  position: absolute;
  width: 14px;
  height: 14px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(0, 0, 0, 0.4);
  border-radius: 2px;
}

.handle-nw { top: -7px; left: -7px; cursor: nwse-resize; }
.handle-ne { top: -7px; right: -7px; cursor: nesw-resize; }
.handle-se { bottom: -7px; right: -7px; cursor: nwse-resize; }
.handle-sw { bottom: -7px; left: -7px; cursor: nesw-resize; }
.handle-n { top: -7px; left: 50%; margin-left: -7px; cursor: ns-resize; }
.handle-s { bottom: -7px; left: 50%; margin-left: -7px; cursor: ns-resize; }
.handle-e { top: 50%; right: -7px; margin-top: -7px; cursor: ew-resize; }
.handle-w { top: 50%; left: -7px; margin-top: -7px; cursor: ew-resize; }
</style>
