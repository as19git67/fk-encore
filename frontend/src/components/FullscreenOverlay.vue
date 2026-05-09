<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { formatPhotoDateCompact, formatLocationLabel } from '../utils/dateFormat'

const props = withDefaults(defineProps<{
  photo: Photo
  prevPhoto: Photo | null
  nextPhoto: Photo | null
  canDelete?: boolean
  /** Control visibility of the details (ⓘ) button. Default: true. */
  showDetailsButton?: boolean
  /** When true the details icon switches to a close icon (✕). Default: false. */
  detailsActive?: boolean
  /** Optional slot content rendered inside the fullscreen image (e.g. face box) */
}>(), {
  // Vue 3 coerces a Boolean prop that the parent didn't pass to `false`
  // (NOT `undefined`), which collapses `props.showDetailsButton !== false`
  // — so an unbound `showDetailsButton` would silently hide the ⓘ button
  // and mute the I keyboard shortcut. Defaulting to `true` here makes the
  // useful behaviour the default; callers wanting the icon hidden still
  // pass `:show-details-button="false"` explicitly.
  showDetailsButton: true,
})

const emit = defineEmits<{
  'close': []
  'prev': []
  'next': []
  'toggle-favorite': [id: number, status: CurationStatus]
  'hide': [id: number]
  'restore': [id: number]
  'show-details': []
  'toggle-cover': [id: number]
}>()

// ── Preload erst nach Laden des aktuellen Bildes ────────────────────────────
const currentLoaded = ref(false)
watch(() => props.photo.id, () => { currentLoaded.value = false })

function onCurrentImageLoad() {
  currentLoaded.value = true
}

// ── Pinch-to-zoom & Touch-Swipe ─────────────────────────────────────────────
const zoomLevel = ref(1)
const panX = ref(0)
const panY = ref(0)

const zoomTransformStyle = computed(() => {
  if (zoomLevel.value === 1 && panX.value === 0 && panY.value === 0) return {}
  return {
    transform: `translate(${panX.value}px, ${panY.value}px) scale(${zoomLevel.value})`,
  }
})

// State for swipe (1-finger)
const touchStartX = ref(0)
const touchStartY = ref(0)
const panStartX = ref(0)
const panStartY = ref(0)

// State for pinch (2-finger)
let pinchStartDist = 0
let pinchStartZoom = 1
let pinchStartCenterX = 0
let pinchStartCenterY = 0
let pinchStartPanX = 0
let pinchStartPanY = 0
let elemCenterX = 0
let elemCenterY = 0

// Double-tap to reset zoom
let lastTapTime = 0
let lastTapX = 0
let lastTapY = 0

function getDist(t1: Touch, t2: Touch): number {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
}

function getMid(t1: Touch, t2: Touch): { x: number; y: number } {
  return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
}

function resetZoom() {
  zoomLevel.value = 1
  panX.value = 0
  panY.value = 0
}

// When the photo changes, reset zoom to show the full image.
watch(() => props.photo.id, resetZoom)

const contentRef = ref<HTMLElement | null>(null)

function handleTouchStart(e: TouchEvent) {
  if (e.touches.length === 1) {
    const t = e.touches[0]!
    touchStartX.value = t.clientX
    touchStartY.value = t.clientY
    panStartX.value = panX.value
    panStartY.value = panY.value

    // Double-tap to reset zoom
    const now = Date.now()
    const dx = t.clientX - lastTapX
    const dy = t.clientY - lastTapY
    if (now - lastTapTime < 300 && Math.hypot(dx, dy) < 40) {
      resetZoom()
      lastTapTime = 0
    } else {
      lastTapTime = now
      lastTapX = t.clientX
      lastTapY = t.clientY
    }
  } else if (e.touches.length === 2) {
    const t1 = e.touches[0]!
    const t2 = e.touches[1]!
    pinchStartDist = getDist(t1, t2)
    pinchStartZoom = zoomLevel.value
    pinchStartPanX = panX.value
    pinchStartPanY = panY.value
    const mid = getMid(t1, t2)
    pinchStartCenterX = mid.x
    pinchStartCenterY = mid.y

    // Compute element center for correct scale origin math
    const rect = contentRef.value?.getBoundingClientRect()
    elemCenterX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    elemCenterY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
  }
}

function handleTouchMove(e: TouchEvent) {
  if (e.touches.length === 2) {
    e.preventDefault()
    const t1 = e.touches[0]!
    const t2 = e.touches[1]!
    const currentDist = getDist(t1, t2)
    const mid = getMid(t1, t2)

    const newZoom = Math.min(5, Math.max(1, pinchStartZoom * (currentDist / pinchStartDist)))
    zoomLevel.value = newZoom

    // Keep the pinch centre fixed: derive the pan that achieves this.
    // With transform translate(px,py) scale(z) and transformOrigin: center:
    //   screenPos = elemCenter + (localPos * z) + (px, py)
    // localPos of the initial pinch centre (accounting for the pan at pinch start):
    //   localPinchX = (pinchStartCenterX - elemCenterX - pinchStartPanX) / pinchStartZoom
    const localPinchX = (pinchStartCenterX - elemCenterX - pinchStartPanX) / pinchStartZoom
    const localPinchY = (pinchStartCenterY - elemCenterY - pinchStartPanY) / pinchStartZoom

    // New pan to make that local point appear at the current midpoint:
    panX.value = mid.x - elemCenterX - localPinchX * newZoom
    panY.value = mid.y - elemCenterY - localPinchY * newZoom
  } else if (e.touches.length === 1 && zoomLevel.value > 1) {
    // Pan when zoomed in
    e.preventDefault()
    const dx = e.touches[0]!.clientX - touchStartX.value
    const dy = e.touches[0]!.clientY - touchStartY.value
    panX.value = panStartX.value + dx
    panY.value = panStartY.value + dy
  }
}

function handleTouchEnd(e: TouchEvent) {
  // Don't swipe between photos when zoomed in
  if (zoomLevel.value > 1) return

  const dx = e.changedTouches[0]!.clientX - touchStartX.value
  const dy = e.changedTouches[0]!.clientY - touchStartY.value
  // Nur horizontal wischen auswerten, wenn x-Bewegung dominiert
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
    if (dx > 0 && props.prevPhoto) emit('prev')
    else if (dx < 0 && props.nextPhoto) emit('next')
  }
}

function handleTouchCancel() {
  // Reset pinch state; keep whatever zoom the user had reached
  pinchStartDist = 0
}

// Attach touchmove with passive:false so preventDefault() works in iOS Safari.
onMounted(() => {
  document.body.style.overflow = 'hidden'
  const el = contentRef.value
  if (el) {
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
  }
})
onUnmounted(() => {
  document.body.style.overflow = ''
  const el = contentRef.value
  if (el) {
    el.removeEventListener('touchmove', handleTouchMove)
  }
})

// ── Keyboard navigation ─────────────────────────────────────────────────────
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape') {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.key === 'ArrowLeft' && props.prevPhoto) emit('prev')
    else if (e.key === 'ArrowRight' && props.nextPhoto) emit('next')
    else if (e.key === 'Escape') {
      // Close the details flyout first if it is open; otherwise close the
      // whole fullscreen overlay.
      if (props.detailsActive) emit('show-details')
      else emit('close')
    }
  } else if (e.key === 'f' || e.key === 'F') {
    // Skip the hotkey while typing in an input (e.g. description textarea).
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.stopImmediatePropagation()
    e.preventDefault()
    emit('toggle-favorite', props.photo.id, props.photo.curation_status)
  } else if (e.key === 'x' || e.key === 'X') {
    if (!props.canDelete) return
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.stopImmediatePropagation()
    e.preventDefault()
    if (props.photo.curation_status === 'hidden') emit('restore', props.photo.id)
    else emit('hide', props.photo.id)
  } else if (e.key === 'i' || e.key === 'I') {
    if (props.showDetailsButton === false) return
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.stopImmediatePropagation()
    e.preventDefault()
    emit('show-details')
  } else if (e.key === 'c' || e.key === 'C') {
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.stopImmediatePropagation()
    e.preventDefault()
    emit('toggle-cover', props.photo.id)
  }
}
onMounted(() => window.addEventListener('keydown', handleKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown, true))

function formatDate(photo: Photo) {
  // Same compact format the detail sidebar uses (e.g. "14.01.2026, 09:38")
  // — the long-weekday form was overflowing the topbar on narrow viewports.
  return formatPhotoDateCompact(photo.taken_at || photo.created_at)
}

function locationLabel(photo: Photo) {
  return formatLocationLabel(photo)
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
// `F` = toggle favorite, `X` = hide / restore, `I` = toggle details flyout,
// `C` = toggle album cover. All implemented in the window-level
// capture-phase `handleKeydown` above so they work regardless of which
// element currently has focus — users don't have to Tab to the toolbar to
// trigger the action. The native Space/Enter activation of the focused
// toolbar buttons (@click handlers) also continues to work.
</script>

<template>
  <Teleport to="body">
  <div class="fullscreen-overlay" @click="emit('close')">
    <!-- Preload neighbours only after current image has loaded -->
    <div v-if="currentLoaded" style="display: none">
      <HeicImage v-if="prevPhoto" :src="getPhotoUrl(prevPhoto.filename)" />
      <HeicImage v-if="nextPhoto" :src="getPhotoUrl(nextPhoto.filename)" />
    </div>

    <div
      ref="contentRef"
      class="fullscreen-content"
      @click.stop
      @touchstart="handleTouchStart"
      @touchend="handleTouchEnd"
      @touchcancel="handleTouchCancel"
    >
      <!-- Zoom wrapper: CSS transform applied here so the face box (in the
           HeicImage slot) scales together with the image. -->
      <div class="fs-zoom-wrapper" :style="zoomTransformStyle">
        <div @load.capture="onCurrentImageLoad" style="display: contents">
          <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" objectFit="contain">
            <!-- Allow caller to inject overlays (e.g. face box) -->
            <slot />
          </HeicImage>
        </div>
      </div>

      <!-- Top bar -->
      <div class="fs-topbar">
        <Button icon="pi pi-arrow-left" rounded text @click="emit('close')" />

        <div class="fs-center">
          <!-- Slot for custom center content (e.g. person name + rename btn) -->
          <slot name="topbar-center">
            <div class="fs-info-center">
              <div class="fs-date-bar">{{ formatDate(photo) }}</div>
              <div v-if="locationLabel(photo)" class="fs-location-bar">
                <i class="pi pi-map-marker" />
                {{ locationLabel(photo) }}
              </div>
            </div>
          </slot>
        </div>

        <div class="fs-toolbar">
          <!-- Slot for extra action buttons placed before the default ones
               (e.g. "set as cover" in the map-mode fullscreen). -->
          <slot name="topbar-actions-before" />
          <slot name="topbar-actions">
            <Button
              v-if="props.showDetailsButton !== false"
              icon="pi pi-info-circle"
              rounded text
              :severity="props.detailsActive ? 'primary' : 'secondary'"
              :class="{ 'fs-toolbar-btn--active': props.detailsActive }"
              @click="emit('show-details')"
              v-tooltip.bottom="(props.detailsActive ? 'Details schließen' : 'Details') + ' (I)'"
            />
            <Button
              v-if="canDelete"
              :icon="photo.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'"
              rounded text
              :severity="photo.curation_status === 'hidden' ? 'danger' : 'secondary'"
              @click="photo.curation_status === 'hidden' ? emit('restore', photo.id) : emit('hide', photo.id)"
              v-tooltip.bottom="(photo.curation_status === 'hidden' ? 'Wiederherstellen' : 'Ausblenden') + ' (X)'"
            />
            <Button
              v-if="canDelete"
              :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              rounded text
              :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
              @click="emit('toggle-favorite', photo.id, photo.curation_status)"
              v-tooltip.bottom="(photo.curation_status === 'favorite' ? 'Favorit entfernen' : 'Als Favorit markieren') + ' (F)'"
            />
          </slot>
        </div>
      </div>

      <!-- Details flyout (right side). Stays mounted across photo changes so
           the embedded content's state (scroll position etc.) is preserved;
           only the data reactively updates. Leaves room for the right nav
           arrow so it remains clickable while the flyout is open. -->
      <div
        v-if="$slots['details-flyout']"
        class="fs-details-flyout"
        :class="{ 'fs-details-flyout--open': props.detailsActive }"
        @click.stop
        @touchstart.stop
        @touchend.stop
        @touchmove.stop
        @wheel.stop
      >
        <slot name="details-flyout" />
      </div>

      <!-- Prev / Next buttons -->
      <Button
        v-if="prevPhoto"
        icon="pi pi-chevron-left"
        class="fs-nav fs-nav-left"
        rounded text
        @click="emit('prev')"
      />
      <Button
        v-if="nextPhoto"
        icon="pi pi-chevron-right"
        class="fs-nav fs-nav-right"
        rounded text
        @click="emit('next')"
      />

      <!-- Optional bottom bar slot (e.g. location info in shared albums) -->
      <slot name="bottom-bar" />
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.fullscreen-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.92);
  z-index: var(--z-fullscreen);
  display: flex;
  align-items: center;
  justify-content: center;
}

.fullscreen-content {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Prevent iOS from consuming touch events for native scroll/zoom.
     The flyout sets touch-action: auto to opt back in for scrolling. */
  touch-action: none;
  /* Prevent the iOS long-press image context menu which cancels touch sequences. */
  -webkit-touch-callout: none;
  user-select: none;
}

/* ── Zoom wrapper ───────────────────────────────────────────────────────── */
.fs-zoom-wrapper {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* transform applied via :style binding */
  transform-origin: center center;
  will-change: transform;
}

/* ── Top bar ────────────────────────────────────────────────────────────── */
.fs-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2.75em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-inline: 0.5em;
  background: var(--p-dialog-background);
  z-index: 10;
}

.fs-center {
  display: flex;
  align-items: center;
  gap: 0.5em;
  flex: 1;
  min-width: 0;
  justify-content: center;
}

.fs-info-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.3;
  min-width: 0;
  max-width: 100%;
}

.fs-date-bar {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.fs-location-bar {
  opacity: 0.7;
  font-size: 0.75em;
  display: flex;
  align-items: center;
  gap: 0.3em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.fs-topbar :deep(.p-button-rounded) {
  width: 2em;
  height: 2em;
}

.fs-toolbar {
  display: flex;
  gap: 0.25em;
}

/* Highlighted state for toolbar toggle buttons (e.g. Details when open). */
.fs-toolbar :deep(.fs-toolbar-btn--active) {
  background: rgba(255, 255, 255, 0.12);
}

/* ── Details flyout ─────────────────────────────────────────────────────── */
.fs-details-flyout {
  position: absolute;
  top: calc(2.75em + 0.5rem);
  /* Leave room for the right navigation button which sits at right:1rem
     and is ~2em wide, so the flyout stops before it. */
  right: calc(1rem + 2.5em + 0.5rem);
  bottom: 1rem;
  width: min(380px, calc(100vw - 1rem - 2.5em - 1rem));
  background: var(--p-content-background, #fff);
  color: var(--p-text-color, #222);
  border: 1px solid var(--p-content-border-color, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  overflow-y: auto;
  overflow-x: hidden;
  z-index: 9;
  transform: translateX(12px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: transform 0.18s ease, opacity 0.18s ease;
  /* Allow native scroll within the flyout despite touch-action:none on parent */
  touch-action: auto;
}

.fs-details-flyout--open {
  transform: translateX(0);
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

@media (max-width: 768px) {
  .fs-details-flyout {
    /* Mobile: right-nav button lives at the bottom, so the flyout can
       stretch closer to the right edge. */
    top: calc(2.75em + 0.25rem);
    right: 0.5rem;
    left: 0.5rem;
    /* Keep clear of the bottom nav buttons (~4rem + safe-area + padding) */
    bottom: calc(4rem + env(safe-area-inset-bottom, 0px) + 0.75rem);
    width: auto;
    max-width: 480px;
    margin-left: auto;
  }
}

/* ── Prev/Next nav buttons ──────────────────────────────────────────────── */
.fs-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  color: white !important;
  background: rgba(0,0,0,0.4) !important;
  z-index: 10;
}

.fs-nav-left { left: 1rem; }
.fs-nav-right { right: 1rem; }

@media (max-width: 768px) {
  .fs-nav {
    /* Auf Mobile immer sichtbar, größere Tappfläche */
    opacity: 1;
    top: auto;
    bottom: 4rem;
    transform: none;
    background: rgba(0, 0, 0, 0.5) !important;
    padding: 0.75rem !important;
  }
  .fs-nav-left { left: 0.5rem; }
  .fs-nav-right { right: 0.5rem; }

  /* Datum in TopBar kürzer */
  .fs-date-bar { font-size: 0.8em; }
}
</style>
