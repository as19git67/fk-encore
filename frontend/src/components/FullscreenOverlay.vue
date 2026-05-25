<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, useSlots } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import PhotoTransformEditor from './PhotoTransformEditor.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { useUserPhotoTransform, invalidateUserTransform } from '../composables/useUserPhotoTransform'
import { photoThumbnailSrc } from '../composables/useTransformedPhotosIndex'
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

const slots = useSlots()
const hasActionBar = computed(() => {
  if (slots['actions'] || slots['actions-before']) return true
  if (props.showDetailsButton !== false) return true
  if (props.canDelete) return true
  if (canEditTransform.value) return true
  return fullscreenSupported.value
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
  /** Fired when the user clicks the +N marker → parent opens review. */
  'open-group-review': []
}>()

// Per-user photo recipe — applies the caller's exposure/contrast/gamma
// to the fullscreen image via CSS filter. Crop is NOT applied here for
// the same layout-coupling reasons as in the sidebar preview; the full
// transformed render is available via /photos/:id/render?v=user for
// download / share workflows.
const currentPhotoId = computed(() => props.photo?.id ?? null)
const {
  recipe: userRecipe,
  cssFilter: userPhotoFilter,
  svgFilterMarkup: userSvgMarkup,
  buildRenderedUrl: buildUserRenderedUrl,
} = useUserPhotoTransform(currentPhotoId)

// When the user has a saved recipe, route the visible image through the
// server-render so the crop is reflected. Face-box overlays in the
// <slot/> still draw against image-natural coords and will appear
// misaligned over a cropped view — accepted trade-off; face tagging
// typically precedes cropping, and the user can clear their crop to
// restore the original face-box layout.
const fsImageSrc = computed(() => {
  // No width param → full-resolution rendered image. The server caches
  // it on first request; subsequent loads hit the cache.
  return buildUserRenderedUrl() ?? getPhotoUrl(props.photo.filename)
})

const fsImageStyle = computed(() =>
  userRecipe.value || !userPhotoFilter.value
    ? undefined
    : { filter: userPhotoFilter.value },
)

// Prev / next prefetch URLs. Pick the right one per-neighbour so the
// neighbour's rendered version is warm by the time the user navigates
// to it. Imports `photoThumbnailSrc` from the shared composable.
function neighbourPreloadSrc(p: Photo): string {
  return photoThumbnailSrc({
    photoId: p.id,
    filename: p.filename,
    userId: auth.user?.id,
  })
}

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

function onCurrentImageError() {
  // Stop waiting on a failed image so the overlay reveals whatever the
  // <img> ended up with instead of hanging on the spinner forever.
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
    if (target && target.closest('button, a, input, textarea, .fs-stack-badge, .fs-details-flyout, .fs-topbar, .fs-actions-bar')) return
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
  if (target && target.closest('button, a, input, textarea, .fs-stack-badge, .fs-details-flyout, .fs-topbar, .fs-actions-bar')) return
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
      // Real-fullscreen exit fires its own keydown on some browsers; the
      // fullscreenchange handler set a short suppression window for that.
      if (performance.now() < suppressEscUntil) return
      // Close the details flyout first if it is open; otherwise close the
      // whole fullscreen overlay.
      if (props.detailsActive) emit('show-details')
      else void closeOverlay()
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
  // Pause auto-advance whenever any modal / details overlay is on top
  // of the photo — the user is reading or editing, not consuming. The
  // timer resumes from a watcher when the overlay closes.
  if (transformEditorVisible.value) return
  if (props.detailsActive) return
  // Wait until the current photo has finished loading; the watcher on
  // `currentLoaded` reschedules once decoding is done.
  if (!currentLoaded.value) return
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
// Reschedule (or pause) when the editor / details overlay toggles.
watch(transformEditorVisible, () => scheduleIdleAdvance())
watch(() => props.detailsActive, () => scheduleIdleAdvance())
// Start the countdown only once the current photo is fully loaded.
watch(currentLoaded, () => scheduleIdleAdvance())

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

// ── Real browser fullscreen (Track N / #80) ────────────────────────────────
// The CSS overlay above is a "fake" fullscreen — it still leaves the
// browser chrome (URL bar, OS taskbar) visible. The Fullscreen API lifts
// the element to the real screen, hiding everything else. We toggle it
// on the outer overlay element so the toolbar / nav stays inside.
const overlayRef = ref<HTMLElement | null>(null)
const isRealFullscreen = ref(false)
const fullscreenSupported = ref(detectFullscreenSupport())

function detectFullscreenSupport(): boolean {
  if (typeof HTMLElement === 'undefined') return false
  const proto = HTMLElement.prototype as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>
    msRequestFullscreen?: () => Promise<void>
  }
  return Boolean(
    proto.requestFullscreen || proto.webkitRequestFullscreen || proto.msRequestFullscreen,
  )
}

function getFullscreenElement(): Element | null {
  const d = document as Document & {
    webkitFullscreenElement?: Element
    msFullscreenElement?: Element
  }
  return d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement || null
}

async function enterRealFullscreen() {
  const el = overlayRef.value as (HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>
    msRequestFullscreen?: () => Promise<void>
  }) | null
  if (!el) return
  try {
    if (el.requestFullscreen) await el.requestFullscreen()
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
    else if (el.msRequestFullscreen) await el.msRequestFullscreen()
  } catch (err) {
    console.warn('[FullscreenOverlay] requestFullscreen failed', err)
  }
}

async function exitRealFullscreen() {
  // Guard against calling exitFullscreen when there's nothing to exit —
  // the browser auto-exits when the fullscreen element leaves the DOM, so
  // by the time the component tears down the fullscreen stack is already
  // empty. Calling exitFullscreen() on a non-fullscreen document throws
  // "Document not active" in Chrome and can leave the browser in a
  // half-torn-down state that blocks input.
  if (!getFullscreenElement()) return
  const d = document as Document & {
    webkitExitFullscreen?: () => Promise<void>
    msExitFullscreen?: () => Promise<void>
  }
  try {
    if (d.exitFullscreen) await d.exitFullscreen()
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen()
    else if (d.msExitFullscreen) await d.msExitFullscreen()
  } catch (err) {
    console.warn('[FullscreenOverlay] exitFullscreen failed', err)
  }
}

async function toggleRealFullscreen() {
  if (isRealFullscreen.value) await exitRealFullscreen()
  else await enterRealFullscreen()
}

/**
 * Close the overlay, exiting real fullscreen first when active. Awaiting
 * the exit before emitting `close` keeps the unmount sequence ordered:
 * browser exits fullscreen → fullscreenchange fires → state settles →
 * parent unmounts us. Without this, the parent could remove the element
 * mid-exit and trip the browser's fullscreen state machine.
 */
async function closeOverlay() {
  if (isRealFullscreen.value) {
    try {
      await Promise.race([
        exitRealFullscreen(),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
    } catch {
      // ignored — we're closing anyway
    }
  }
  emit('close')
}

// When the browser leaves real fullscreen because the user pressed ESC,
// it still dispatches the keydown to JS on some browsers. Suppress the
// next ESC briefly so the overlay-close handler doesn't piggy-back on
// the same key press.
let suppressEscUntil = 0

function onFullscreenChange() {
  const wasFullscreen = isRealFullscreen.value
  isRealFullscreen.value = getFullscreenElement() === overlayRef.value
  if (wasFullscreen && !isRealFullscreen.value) {
    suppressEscUntil = performance.now() + 300
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  document.addEventListener('msfullscreenchange', onFullscreenChange)
})

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  document.removeEventListener('msfullscreenchange', onFullscreenChange)
  // No explicit exit attempt here — the browser auto-exits fullscreen
  // when the fullscreen element leaves the DOM, and `closeOverlay()`
  // already awaits the exit on the explicit close paths. Calling
  // exitFullscreen here would race the auto-exit and trip Chrome's
  // "Document not active" error.
})
</script>

<template>
  <Teleport to="body">
  <div ref="overlayRef" class="fullscreen-overlay" @click="closeOverlay">
    <!-- Preload neighbours only after current image has loaded -->
    <div v-if="currentLoaded" style="display: none">
      <HeicImage v-if="prevPhoto" :src="neighbourPreloadSrc(prevPhoto)" />
      <HeicImage v-if="nextPhoto" :src="neighbourPreloadSrc(nextPhoto)" />
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
           HeicImage slot) scales together with the image. Hidden until the
           current photo has decoded so the previously shown image doesn't
           linger on screen during navigation (#371). -->
      <div
        class="fs-zoom-wrapper"
        :class="{ 'fs-zoom-wrapper--loading': !currentLoaded }"
        :style="zoomTransformStyle"
      >
        <svg v-if="userSvgMarkup && !userRecipe" width="0" height="0" style="position: absolute; pointer-events: none">
          <defs v-html="userSvgMarkup"></defs>
        </svg>
        <div
          @load.capture="onCurrentImageLoad"
          @error.capture="onCurrentImageError"
          style="display: contents"
        >
          <HeicImage
            :src="fsImageSrc"
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

      <!-- Loading spinner shown while the current photo decodes (#371). -->
      <div v-if="!currentLoaded" class="fs-loading" aria-hidden="true">
        <i class="pi pi-spin pi-spinner" />
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

      <!-- Top bar: back + date/location (centered) + counter -->
      <div class="fs-topbar" @click.stop>
        <Button icon="pi pi-arrow-left" rounded text @click="closeOverlay" />

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

        <div class="fs-topbar-right">
          <span v-if="showCounter" class="fs-counter" aria-live="polite">
            {{ currentIndex }} / {{ totalCount }}
          </span>
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

      <!-- Vertical-centered prev/next arrows. Hidden on touch-only
           devices (mobile, tablet) where tap-half + swipe handle
           navigation; visible on hover-capable devices (desktop). -->
      <Button
        v-if="prevPhoto"
        icon="pi pi-chevron-left"
        class="fs-nav fs-nav-left"
        rounded text
        @click.stop="emit('prev')"
      />
      <Button
        v-if="nextPhoto"
        icon="pi pi-chevron-right"
        class="fs-nav fs-nav-right"
        rounded text
        @click.stop="emit('next')"
      />

      <!-- Bottom action bar: iOS-style centered icon row. Hidden when
           there are no actions to show (e.g. unauthenticated shared
           album with showDetailsButton=false). -->
      <div
        v-if="hasActionBar"
        class="fs-actions-bar"
        @click.stop
      >
        <!-- Slot for extra action buttons placed before the default ones
             (e.g. "set as cover" in the map-mode fullscreen). -->
        <slot name="actions-before" />
        <slot name="actions">
          <Button
            v-if="props.showDetailsButton !== false"
            icon="pi pi-info-circle"
            rounded text
            :severity="props.detailsActive ? 'primary' : 'secondary'"
            :class="{ 'fs-toolbar-btn--active': props.detailsActive }"
            @click="emit('show-details')"
            v-tooltip.top="(props.detailsActive ? 'Details schließen' : 'Details') + ' (I)'"
          />
          <Button
            v-if="canDelete"
            :icon="photo.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'"
            rounded text
            :severity="photo.curation_status === 'hidden' ? 'danger' : 'secondary'"
            @click="photo.curation_status === 'hidden' ? emit('restore', photo.id) : emit('hide', photo.id)"
            v-tooltip.top="(photo.curation_status === 'hidden' ? 'Wiederherstellen' : 'Ausblenden') + ' (X)'"
          />
          <Button
            v-if="canDelete"
            :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
            rounded text
            :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
            @click="emit('toggle-favorite', photo.id, photo.curation_status)"
            v-tooltip.top="(photo.curation_status === 'favorite' ? 'Favorit entfernen' : 'Als Favorit markieren') + ' (F)'"
          />
          <Button
            v-if="canEditTransform"
            icon="pi pi-sliders-h"
            rounded text
            severity="secondary"
            @click="transformEditorVisible = true"
            v-tooltip.top="'Schnitt &amp; Belichtung bearbeiten'"
          />
        </slot>
        <!-- Real browser fullscreen toggle (Track N / #80). Sits outside
             the `actions` slot so caller overrides still get it. -->
        <Button
          v-if="fullscreenSupported"
          :icon="isRealFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          rounded text
          severity="secondary"
          :class="{ 'fs-toolbar-btn--active': isRealFullscreen }"
          :aria-pressed="isRealFullscreen"
          :aria-label="isRealFullscreen ? 'Vollbild beenden' : 'Vollbild'"
          @click="toggleRealFullscreen"
          v-tooltip.top="isRealFullscreen ? 'Vollbild beenden (ESC)' : 'Vollbild'"
        />
      </div>

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

/* When the browser lifts this element to real fullscreen (Track N / #80),
   the rgba background lets the page underneath bleed through because the
   element no longer composites against anything. Force opaque black so
   the photo sits on a solid background. */
.fullscreen-overlay:fullscreen,
.fullscreen-overlay:-webkit-full-screen {
  background: #000;
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
  /* Fades in once the photo has loaded; see .fs-zoom-wrapper--loading. */
  transition: opacity 0.2s ease;
}

/* While the current photo decodes the wrapper is hidden instantly (no
   transition on the way out) so the stale image never flashes; the
   fade-in transition above runs only when the loading class is removed. */
.fs-zoom-wrapper--loading {
  opacity: 0;
  transition: none;
}

.fs-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
  color: #fff;
  font-size: 2.5rem;
  pointer-events: none;
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
  padding-inline: 1rem;
  background: var(--p-dialog-background);
  z-index: 10;
  gap: 0.5rem;
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

/* Right side of the topbar — holds the counter pill (or nothing). The
   fixed min-width matches the back button on the left so the center
   stays visually centered even when the counter is absent. */
.fs-topbar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 2em;
}

.fs-counter {
  font-size: 0.8em;
  color: var(--p-text-color, #fff);
  background: rgba(0, 0, 0, 0.35);
  border-radius: 999px;
  padding: 0.2em 0.65em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
    /* Mobile: arrows are hidden (touch uses tap/swipe), so the flyout
       can stretch the full width. Keeps clear of the bottom action bar
       (height ~3.5rem + 0.75rem margin). */
    top: calc(2.75em + 0.25rem);
    right: 0.5rem;
    left: 0.5rem;
    bottom: calc(5rem + env(safe-area-inset-bottom, 0px));
    width: auto;
    max-width: 480px;
    margin-left: auto;
  }
}

/* ── Prev/Next nav buttons ──────────────────────────────────────────────── */
/* Vertically centered at the image's left/right edge. Tap-half + swipe
   handle navigation on touch devices, so we hide the arrows there and
   only show them on hover-capable devices (desktop with a mouse). */
.fs-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  color: white !important;
  background: rgba(0, 0, 0, 0.4) !important;
  z-index: 10;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.fs-nav-left { left: 1rem; }
.fs-nav-right { right: 1rem; }

/* Reveal arrows on devices that can hover (typical desktop with mouse). */
@media (hover: hover) and (pointer: fine) {
  .fullscreen-content:hover .fs-nav,
  .fs-nav:focus-visible {
    opacity: 1;
  }
}

/* Always hide on coarse pointers / no-hover devices (phones, tablets). */
@media (hover: none), (pointer: coarse) {
  .fs-nav {
    display: none;
  }
}

/* ── Bottom action bar (iOS-style) ──────────────────────────────────────── */
.fs-actions-bar {
  position: absolute;
  left: 50%;
  bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.4em 0.75em;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  z-index: 10;
  max-width: calc(100vw - 2rem);
  overflow-x: auto;
  scrollbar-width: none;
}
.fs-actions-bar::-webkit-scrollbar { display: none; }

.fs-actions-bar :deep(.p-button-rounded) {
  width: 2.5em;
  height: 2.5em;
  color: #fff;
}

/* Highlighted state for toggle buttons (e.g. Details when open). */
.fs-actions-bar :deep(.fs-toolbar-btn--active) {
  background: rgba(255, 255, 255, 0.18);
}

@media (max-width: 768px) {
  /* Datum in TopBar kürzer */
  .fs-date-bar { font-size: 0.8em; }
}
</style>
