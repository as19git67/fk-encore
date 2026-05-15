<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import PhotoTransformEditor from './PhotoTransformEditor.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { useUserPhotoTransform, invalidateUserTransform } from '../composables/useUserPhotoTransform'
import { useAuthStore } from '../stores/auth'
import type { GalleryGridGroup } from '../api/gallery'
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
  /** 1-based index of the current photo in the navigated set. When
   *  provided together with `totalCount > 0`, the overlay renders an
   *  "X / N" pill between the prev/next nav buttons. */
  currentIndex?: number
  totalCount?: number
  /**
   * Similar-photo-group context for the currently shown photo, when
   * the photo is part of a group. Drives the `+N`-marker that tells
   * the user that more siblings exist and offers a one-click jump
   * to the review dialog (Track I, see docs/ai-auto-pick.md).
   * Null/undefined → no marker rendered.
   */
  group?: GalleryGridGroup | null
  /** Optional slot content rendered inside the fullscreen image (e.g. face box) */
  /**
   * When > 0, auto-advance to the next photo this many milliseconds
   * after the last user interaction. Any touch, click, mouse move, or
   * key press resets the timer. Setting to 0 (default) disables the
   * slideshow behaviour entirely.
   */
  autoAdvanceMs?: number
}>(), {
  // Vue 3 coerces a Boolean prop that the parent didn't pass to `false`
  // (NOT `undefined`), which collapses `props.showDetailsButton !== false`
  // — so an unbound `showDetailsButton` would silently hide the ⓘ button
  // and mute the I keyboard shortcut. Defaulting to `true` here makes the
  // useful behaviour the default; callers wanting the icon hidden still
  // pass `:show-details-button="false"` explicitly.
  showDetailsButton: true,
  autoAdvanceMs: 0,
  currentIndex: 0,
  totalCount: 0,
})

const showCounter = computed(() => props.totalCount > 0 && props.currentIndex > 0)

const emit = defineEmits<{
  'close': []
  'prev': []
  'next': []
  'toggle-favorite': [id: number, status: CurationStatus]
  'hide': [id: number]
  'restore': [id: number]
  'show-details': []
  'toggle-cover': [id: number]
  /** Fired when the user clicks the +N marker → parent opens review. */
  'open-group-review': []
}>()

// Per-user photo recipe — applies the caller's exposure/contrast/gamma
// to the fullscreen image via CSS filter. Crop is NOT applied here for
// the same layout-coupling reasons as in the sidebar preview; the full
// transformed render is available via /photos/:id/render?v=user for
// download / share workflows.
const currentPhotoId = computed(() => props.photo?.id ?? null)
const { cssFilter: userPhotoFilter, svgFilterMarkup: userSvgMarkup } =
  useUserPhotoTransform(currentPhotoId)
const fsImageStyle = computed(() => (userPhotoFilter.value ? { filter: userPhotoFilter.value } : undefined))

// Editor trigger — accessible from inside the fullscreen view too, not
// just from the desktop sidebar's quick-actions row.
const auth = useAuthStore()
const canEditTransform = computed(() => auth.hasPermission('photos.upload'))
const transformEditorVisible = ref(false)
function onTransformSaved() {
  invalidateUserTransform(props.photo.id)
}

// Track-I marker semantics — mirrors VirtualGallery's badge logic.
const isAiHidingSiblings = computed(() => {
  const g = props.group
  if (!g) return false
  if (g.reviewed) return false
  return g.ai_confidence === 'high'
})
const groupBadgeTitle = computed(() => {
  const g = props.group
  if (!g) return ''
  if (isAiHidingSiblings.value) {
    return `${g.member_count - 1} ähnliche Fotos werden ausgeblendet – klicken zum Anzeigen`
  }
  if (g.ai_confidence === 'medium') return 'KI-Vorschlag mit mittlerer Sicherheit – bitte prüfen'
  if (g.ai_confidence === 'low') return 'KI-Vorschlag mit niedriger Sicherheit'
  return `${g.member_count} ähnliche Fotos`
})

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
  // Always prevent default so iOS Safari doesn't re-acquire the gesture.
  // The listener is registered { passive: false } so this call is permitted.
  // Without it, a 1-finger swipe at zoom=1 fires touchcancel instead of touchend.
  e.preventDefault()
  if (e.touches.length === 2) {
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
    const dx = e.touches[0]!.clientX - touchStartX.value
    const dy = e.touches[0]!.clientY - touchStartY.value
    panX.value = panStartX.value + dx
    panY.value = panStartY.value + dy
  }
}

function handleTouchEnd(e: TouchEvent) {
  // Don't swipe / tap-navigate between photos when zoomed in
  if (zoomLevel.value > 1) return
  if (!e.changedTouches.length) return

  const touch = e.changedTouches[0]!
  const dx = touch.clientX - touchStartX.value
  const dy = touch.clientY - touchStartY.value
  const movement = Math.hypot(dx, dy)

  // Tap (essentially no movement): treat the side of the screen as a
  // direction — left half = previous, right half = next. Skips the
  // emit when the target is interactive (button / link / topbar) so
  // toolbar taps don't double up as navigation.
  if (movement < 10) {
    const target = e.target as HTMLElement | null
    if (target && target.closest('button, a, input, textarea, .fs-stack-badge, .fs-details-flyout, .fs-topbar')) return
    if (touch.clientX < window.innerWidth / 2) {
      if (props.prevPhoto) emit('prev')
    } else {
      if (props.nextPhoto) emit('next')
    }
    // Suppress the synthetic click event the browser is about to fire
    // for the same gesture — otherwise the click handler below would
    // advance the photo twice.
    suppressNextClickUntil = performance.now() + 500
    return
  }

  // Swipe: keep horizontal-dominant gestures with at least 40 px of
  // travel as the explicit prev/next signal.
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
    if (dx > 0 && props.prevPhoto) emit('prev')
    else if (dx < 0 && props.nextPhoto) emit('next')
  }
}

let suppressNextClickUntil = 0

function handleContentClick(e: MouseEvent) {
  if (zoomLevel.value > 1) return
  if (performance.now() < suppressNextClickUntil) return
  const target = e.target as HTMLElement | null
  // Skip the navigation when the click landed on an interactive
  // element — its own @click handler should take precedence.
  if (target && target.closest('button, a, input, textarea, .fs-stack-badge, .fs-details-flyout, .fs-topbar')) return
  if (e.clientX < window.innerWidth / 2) {
    if (props.prevPhoto) emit('prev')
  } else {
    if (props.nextPhoto) emit('next')
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

// ── Idle auto-advance (slideshow) ───────────────────────────────────────────
// When `autoAdvanceMs` > 0 the overlay auto-emits `next` after the user
// has been idle for that long. Any pointer or keyboard interaction
// resets the timer.
let idleTimer: ReturnType<typeof setTimeout> | null = null

function clearIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleAdvance() {
  clearIdleTimer()
  if (!props.autoAdvanceMs || props.autoAdvanceMs <= 0) return
  if (!props.nextPhoto) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (props.nextPhoto) emit('next')
  }, props.autoAdvanceMs)
}

function bumpIdleTimer() {
  if (!props.autoAdvanceMs || props.autoAdvanceMs <= 0) return
  scheduleIdleAdvance()
}

watch(() => props.photo.id, () => scheduleIdleAdvance())
watch(() => props.autoAdvanceMs, () => scheduleIdleAdvance())
watch(() => props.nextPhoto, () => scheduleIdleAdvance())

onMounted(() => {
  scheduleIdleAdvance()
  window.addEventListener('pointerdown', bumpIdleTimer, true)
  window.addEventListener('pointermove', bumpIdleTimer, true)
  window.addEventListener('keydown', bumpIdleTimer, true)
  window.addEventListener('wheel', bumpIdleTimer, true)
})

onUnmounted(() => {
  clearIdleTimer()
  window.removeEventListener('pointerdown', bumpIdleTimer, true)
  window.removeEventListener('pointermove', bumpIdleTimer, true)
  window.removeEventListener('keydown', bumpIdleTimer, true)
  window.removeEventListener('wheel', bumpIdleTimer, true)
})

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
      @click.stop="handleContentClick"
      @touchstart="handleTouchStart"
      @touchend="handleTouchEnd"
      @touchcancel="handleTouchCancel"
    >
      <!-- Zoom wrapper: CSS transform applied here so the face box (in the
           HeicImage slot) scales together with the image. -->
      <div class="fs-zoom-wrapper" :style="zoomTransformStyle">
        <svg v-if="userSvgMarkup" width="0" height="0" style="position: absolute; pointer-events: none">
          <defs v-html="userSvgMarkup"></defs>
        </svg>
        <div @load.capture="onCurrentImageLoad" style="display: contents">
          <HeicImage
            :src="getPhotoUrl(photo.filename)"
            :alt="photo.original_name"
            objectFit="contain"
            :staticSlot="true"
            :imageStyle="fsImageStyle"
          >
            <!-- Allow caller to inject overlays (e.g. face box) -->
            <slot />
          </HeicImage>
        </div>
      </div>

      <!-- Group marker (Track I): shown when the current photo is part
           of a similar-photo group. Tap → open review dialog. -->
      <button
        v-if="group"
        class="fs-stack-badge"
        :class="{
          'fs-stack-badge--ai-medium': group.ai_confidence === 'medium',
          'fs-stack-badge--ai-low': group.ai_confidence === 'low',
        }"
        :title="groupBadgeTitle"
        @click.stop="emit('open-group-review')"
      >
        <i v-if="isAiHidingSiblings" class="pi pi-eye-slash" />
        <i v-else class="pi pi-images" />
        <span class="fs-stack-badge-count">+{{ group.member_count - 1 }}</span>
      </button>

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
            <Button
              v-if="canEditTransform"
              icon="pi pi-sliders-h"
              rounded text
              severity="secondary"
              @click="transformEditorVisible = true"
              v-tooltip.bottom="'Schnitt &amp; Belichtung bearbeiten'"
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

      <!-- Prev / Next buttons + counter pill on the same vertical
           axis. The counter only renders when the parent supplies a
           non-zero `total-count`. -->
      <Button
        v-if="prevPhoto"
        icon="pi pi-chevron-left"
        class="fs-nav fs-nav-left"
        rounded text
        @click="emit('prev')"
      />
      <div v-if="showCounter" class="fs-nav-counter" aria-live="polite">
        {{ currentIndex }} / {{ totalCount }}
      </div>
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

  <!-- Editor dialog — hosted here so it works from inside fullscreen
       even though the sidebar's quick-actions row is hidden there. -->
  <PhotoTransformEditor
    v-if="canEditTransform"
    v-model:visible="transformEditorVisible"
    :photo-id="photo.id"
    :photo-filename="photo.filename"
    @saved="onTransformSaved"
    @deleted="onTransformSaved"
  />
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

/* ── Group marker (Track I) ───────────────────────────────────────────── */
.fs-stack-badge {
  position: absolute;
  top: 64px;
  left: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0,0,0,0.65);
  color: #fff;
  font-size: 0.85rem;
  font-weight: 700;
  padding: 6px 12px;
  border: none;
  border-radius: 14px;
  cursor: pointer;
  transition: background 0.15s;
}
.fs-stack-badge:hover,
.fs-stack-badge:focus-visible {
  background: rgba(0,0,0,0.85);
  outline: none;
}
.fs-stack-badge--ai-medium {
  background: var(--p-orange-500, #f97316);
}
.fs-stack-badge--ai-medium:hover {
  background: var(--p-orange-600, #ea580c);
}
.fs-stack-badge--ai-low {
  background: rgba(0,0,0,0.5);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.25);
}
.fs-stack-badge-count {
  line-height: 1;
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
  padding-inline: 2rem;
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
    /* Keep clear of the bottom nav buttons: button bottom at 4rem, button
       height ~2.5rem (1rem icon + 2×0.75rem padding), plus 0.5rem gap. */
    bottom: calc(7rem + env(safe-area-inset-bottom, 0px));
    width: auto;
    max-width: 480px;
    margin-left: auto;
  }
}

/* ── Prev/Next nav buttons ──────────────────────────────────────────────── */
.fs-nav {
  position: absolute;
  bottom: 0;
  color: white !important;
  background: rgba(0,0,0,0.4) !important;
  z-index: 10;
}

.fs-nav-left { left: 1rem; }
.fs-nav-right { right: 1rem; }

/* Photo counter pill on the centre-line between the nav buttons. */
.fs-nav-counter {
  position: absolute;
  bottom: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 999px;
  padding: 0.35rem 0.85rem;
  font-size: 0.85rem;
  font-weight: 500;
  z-index: 10;
  pointer-events: none;
  white-space: nowrap;
  backdrop-filter: blur(6px);
}

@media (max-width: 768px) {
  .fs-nav {
    /* Auf Mobile immer sichtbar, größere Tappfläche */
    opacity: 1;
    background: rgba(0, 0, 0, 0.5) !important;
    padding: 0.75rem !important;
  }
  .fs-nav-left { left: 0.5rem; }
  .fs-nav-right { right: 0.5rem; }

  /* Datum in TopBar kürzer */
  .fs-date-bar { font-size: 0.8em; }
}
</style>
