<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, useSlots } from 'vue'
import Button from 'primevue/button'
import Select from 'primevue/select'
import HeicImage from './HeicImage.vue'
import PhotoTransformEditor from './PhotoTransformEditor.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { useUserPhotoTransform, invalidateUserTransform } from '../composables/useUserPhotoTransform'
import { photoThumbnailSrc } from '../composables/useTransformedPhotosIndex'
import { useAuthStore } from '../stores/auth'
import type { GalleryGridGroup } from '../api/gallery'
import { formatPhotoDateCompact, formatLocationLabel, toLocalIsoDate } from '../utils/dateFormat'
import { shouldArmSlideshow, slideshowReachedEnd, isDayChange, shouldShowCaption, type SlideshowState } from '../utils/slideshow'
import {
  SLIDESHOW_INTERVAL_OPTIONS_MS,
  loadSlideshowIntervalMs,
  saveSlideshowIntervalMs,
  formatSlideshowIntervalLabel,
  DEFAULT_SLIDESHOW_INTERVAL_MS,
} from '../utils/slideshowInterval'

const props = withDefaults(defineProps<{
  photo: Photo
  prevPhoto: Photo | null
  nextPhoto: Photo | null
  canDelete?: boolean
  /** Control visibility of the details (ⓘ) button. Default: true. */
  showDetailsButton?: boolean
  /** When true the details icon switches to a close icon (✕). Default: false. */
  detailsActive?: boolean
  /**
   * When true, briefly slide in a date banner whenever navigation crosses
   * into a different day (e.g. the map slideshow running through a whole
   * trip), so the day change is recognisable. Default: false.
   */
  markDayChanges?: boolean
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
   * When > 0, the slideshow is available (play/pause button + `S` shortcut).
   * The value is the *default* interval; the actual gap between photos is the
   * user's per-browser setting, adjustable via the toolbar interval button
   * (see utils/slideshowInterval). 0 (default) disables the slideshow.
   */
  autoAdvanceMs?: number
  /**
   * Set by the shared-album guest view. Keeps the action toolbar as the
   * floating bottom pill in landscape instead of flowing it into the
   * topbar — the in-header layout is reserved for the signed-in app.
   */
  guest?: boolean
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
  markDayChanges: false,
})

const showCounter = computed(() => props.totalCount > 0 && props.currentIndex > 0)

const slots = useSlots()
const hasActionBar = computed(() => {
  if (slots['actions'] || slots['actions-before']) return true
  if (props.showDetailsButton !== false) return true
  if (props.canDelete) return true
  if (canEditTransform.value) return true
  if (canSlideshow.value) return true
  return fullscreenSupported.value
})

// ── Split-detail layout (Track AF / #434) ───────────────────────────────────
// The details never overlay the photo. Whenever a details panel is provided
// and toggled open we split the screen — in every orientation and on every
// device, no desktop/phone distinction:
//   • portrait  → photo on the upper half (object-fit: contain) with the
//                 metadata flowing below it; the whole pane scrolls as one.
//   • landscape → photo on the left, metadata on the right (width capped at
//                 ~an iPhone 16 Pro screen) scrolling independently.
// Portrait vs. landscape is handled entirely in CSS via the size-independent
// `(orientation: …)` media query, so no JS viewport tracking is needed.
const hasDetailsSlot = computed(() => Boolean(slots['details-flyout']))
const splitMode = computed(() => props.detailsActive && hasDetailsSlot.value)

// Touch navigation inside the split photo pane. A horizontal swipe or a tap
// on the left/right half of the image navigates to the prev/next photo;
// vertical gestures fall through so the pane keeps scrolling natively.
const photoTouchStartX = ref(0)
const photoTouchStartY = ref(0)

function handlePhotoTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1) return
  photoTouchStartX.value = e.touches[0]!.clientX
  photoTouchStartY.value = e.touches[0]!.clientY
}

function handlePhotoTouchEnd(e: TouchEvent) {
  if (!e.changedTouches.length) return
  const t = e.changedTouches[0]!
  const dx = t.clientX - photoTouchStartX.value
  const dy = t.clientY - photoTouchStartY.value
  const movement = Math.hypot(dx, dy)

  // Tap (no real movement): use the half of the photo pane the user
  // touched — left half = previous, right half = next.
  if (movement < 10) {
    // Suppress the synthetic click the browser fires for this tap so the
    // pane's @click handler (for mouse users) doesn't navigate twice.
    suppressNextClickUntil = performance.now() + 500
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (t.clientX < rect.left + rect.width / 2) {
      if (props.prevPhoto) emit('prev')
    } else {
      if (props.nextPhoto) emit('next')
    }
    return
  }

  // Horizontal-dominant swipe of at least 40 px → prev/next.
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
    if (dx > 0 && props.prevPhoto) emit('prev')
    else if (dx < 0 && props.nextPhoto) emit('next')
  }
}

// Mouse click on the split photo pane (desktop): navigate by the touched
// half, mirroring the touch behaviour. Touch taps are filtered out via the
// suppression window set in handlePhotoTouchEnd.
function handlePhotoClick(e: MouseEvent) {
  if (performance.now() < suppressNextClickUntil) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  if (e.clientX < rect.left + rect.width / 2) {
    if (props.prevPhoto) emit('prev')
  } else {
    if (props.nextPhoto) emit('next')
  }
}

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
  // In split mode the photo lives in its own pane and the panes scroll
  // natively — don't engage swipe-nav / pinch-zoom on the photo.
  if (splitMode.value) return
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
  // Let native scrolling run inside the split panes (don't preventDefault).
  if (splitMode.value) return
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
  if (splitMode.value) return
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
  if (splitMode.value) return
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
  } else if (e.key === 's' || e.key === 'S') {
    // Start / pause the slideshow (only where one is available).
    if (!canSlideshow.value) return
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    e.stopImmediatePropagation()
    e.preventDefault()
    togglePlay()
  }
}
onMounted(() => window.addEventListener('keydown', handleKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown, true))

// ── Slideshow (play / pause) ────────────────────────────────────────────────
// The slideshow never auto-starts. The user toggles it with the toolbar
// play/pause button (shown whenever `autoAdvanceMs` > 0). While `playing`, the
// overlay emits `next` every `autoAdvanceMs`; any pointer or keyboard
// interaction resets the interval (so it advances once the user is idle
// again), and it stops automatically once the last photo is reached.
let idleTimer: ReturnType<typeof setTimeout> | null = null
const playing = ref(false)
/** True when the slideshow can be offered at all (caller enabled it). */
const canSlideshow = computed(() => (props.autoAdvanceMs ?? 0) > 0)
// User-specific interval between photos (localStorage, default 5 s). The
// `autoAdvanceMs` prop only switches the slideshow on; the actual delay is
// this stored value, adjustable via the toolbar.
const intervalMs = ref(
  loadSlideshowIntervalMs(
    (props.autoAdvanceMs ?? 0) > 0 ? props.autoAdvanceMs : DEFAULT_SLIDESHOW_INTERVAL_MS,
  ),
)
/** Dropdown options: [{ label: '5s', value: 5000 }, …]. */
const intervalOptions = SLIDESHOW_INTERVAL_OPTIONS_MS.map((ms) => ({
  label: formatSlideshowIntervalLabel(ms),
  value: ms,
}))

function clearIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleAdvance() {
  clearIdleTimer()
  const state: SlideshowState = {
    playing: playing.value,
    autoAdvanceMs: canSlideshow.value ? intervalMs.value : 0,
    hasNext: props.nextPhoto != null,
    currentLoaded: currentLoaded.value,
  }
  // No more photos ahead → stop and flip the button back to "play".
  if (slideshowReachedEnd(state)) { playing.value = false; return }
  if (!shouldArmSlideshow(state)) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (props.nextPhoto) emit('next')
  }, intervalMs.value)
}

function togglePlay() {
  playing.value = !playing.value
}

/** Apply a chosen slideshow interval and persist it (per browser). */
function selectInterval(ms: number) {
  intervalMs.value = ms
  saveSlideshowIntervalMs(ms)
}

function bumpIdleTimer() {
  if (!canSlideshow.value) return
  scheduleIdleAdvance()
}

watch(intervalMs, () => scheduleIdleAdvance())
watch(playing, () => scheduleIdleAdvance())
watch(() => props.photo.id, () => scheduleIdleAdvance())
watch(() => props.autoAdvanceMs, () => scheduleIdleAdvance())
watch(() => props.nextPhoto, () => scheduleIdleAdvance())
// Editing a photo stops the slideshow (so the play/pause icon stays correct);
// the user restarts it after closing the editor. The details flyout, by
// contrast, lets the slideshow keep running.
watch(transformEditorVisible, (open) => { if (open) playing.value = false })
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

// ── Day-change banner (map slideshow) ───────────────────────────────────────
// When `markDayChanges` is set, briefly slide a date label in whenever
// navigation moves into a different day, so a slideshow running across a whole
// trip makes the day boundary recognisable — without pausing the playback.
const dayBannerText = ref('')
const dayBannerVisible = ref(false)
let dayBannerTimer: ReturnType<typeof setTimeout> | null = null
let lastDayKey: string | null = null

function dayKeyOf(photo: Photo): string {
  return toLocalIsoDate(new Date(photo.taken_at || photo.created_at))
}

function showDayBanner(photo: Photo) {
  dayBannerText.value = new Date(photo.taken_at || photo.created_at).toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  dayBannerVisible.value = true
  if (dayBannerTimer !== null) clearTimeout(dayBannerTimer)
  dayBannerTimer = setTimeout(() => {
    dayBannerVisible.value = false
    dayBannerTimer = null
  }, 2500)
}

watch(() => props.photo.id, () => {
  if (!props.markDayChanges) return
  const key = dayKeyOf(props.photo)
  // Announce only a *change* — never the photo the overlay opened on.
  if (isDayChange(lastDayKey, key)) showDayBanner(props.photo)
  lastDayKey = key
})

onMounted(() => {
  if (props.markDayChanges) lastDayKey = dayKeyOf(props.photo)
})
onUnmounted(() => {
  if (dayBannerTimer !== null) clearTimeout(dayBannerTimer)
})

function formatDate(photo: Photo) {
  // Same compact format the detail sidebar uses (e.g. "14.01.2026, 09:38")
  // — the long-weekday form was overflowing the topbar on narrow viewports.
  return formatPhotoDateCompact(photo.taken_at || photo.created_at)
}

/** The photo's description, trimmed — shown as the slideshow caption. */
const descriptionText = computed(() => (props.photo.description ?? '').trim())

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

    <!-- Top-centre overlay stack, above the image: the (transient) day-change
         banner and, while the slideshow runs, the photo's description as a
         single ellipsised line. Stacked so they never overlap. -->
    <div class="fs-top-overlays">
      <Transition name="fs-top-overlay">
        <div v-if="markDayChanges && dayBannerVisible" class="fs-day-banner" aria-live="polite">
          {{ dayBannerText }}
        </div>
      </Transition>
      <Transition name="fs-top-overlay">
        <div
          v-if="shouldShowCaption(playing, splitMode, photo.description)"
          class="fs-caption"
          :title="descriptionText"
        >
          {{ descriptionText }}
        </div>
      </Transition>
    </div>

    <div
      ref="contentRef"
      class="fullscreen-content"
      :class="{ 'fullscreen-content--split': splitMode, 'fullscreen-content--guest': guest }"
      @click.stop="handleContentClick"
      @touchstart="handleTouchStart"
      @touchend="handleTouchEnd"
      @touchcancel="handleTouchCancel"
    >
      <!-- Split layout (Track AF / #434): photo + metadata side by
           side (landscape) or stacked (portrait), no overlay. Used on every
           device when the details are open. -->
      <div v-if="splitMode" class="fs-split">
        <div
          class="fs-split-photo"
          @touchstart="handlePhotoTouchStart"
          @touchend="handlePhotoTouchEnd"
          @click="handlePhotoClick"
        >
          <svg v-if="userSvgMarkup && !userRecipe" width="0" height="0" style="position: absolute; pointer-events: none">
            <defs v-html="userSvgMarkup"></defs>
          </svg>
          <HeicImage
            :src="fsImageSrc"
            :alt="photo.original_name"
            objectFit="contain"
            :staticSlot="false"
            :imageStyle="fsImageStyle"
          >
            <slot />
          </HeicImage>
        </div>
        <div
          class="fs-split-details"
          @click.stop
          @touchstart.stop
          @touchend.stop
          @touchmove.stop
          @wheel.stop
        >
          <slot name="details-flyout" />
        </div>
      </div>

      <!-- Zoom wrapper: CSS transform applied here so the face box (in the
           HeicImage slot) scales together with the image. Hidden until the
           current photo has decoded so the previously shown image doesn't
           linger on screen during navigation (#371). -->
      <div
        v-if="!splitMode"
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
      <div v-if="!currentLoaded && !splitMode" class="fs-loading" aria-hidden="true">
        <i class="pi pi-spin pi-spinner" />
      </div>

      <!-- Group marker (Track I): shown when the current photo is part
           of a similar-photo group that the user hasn't reviewed yet.
           Once the group is reviewed the marker disappears — mirrors
           VirtualGallery's `slot.group && !slot.group.reviewed` gate.
           Tap → open review dialog. -->
      <button
        v-if="group && !group.reviewed"
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

        <!-- Action bar: an iOS-style icon row. In portrait it floats
             centered at the bottom of the overlay (position: fixed). In
             landscape (split or normal) it instead flows inline here in the
             topbar — only the buttons, dropping its own pill so the topbar
             background shows through (see `.fs-actions-bar` styles). Hidden
             when there are no actions to show (e.g. unauthenticated shared
             album). -->
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
          <!-- Slideshow interval (per-browser): compact dropdown of 3–30 s. -->
          <Select
            v-if="canSlideshow"
            :model-value="intervalMs"
            :options="intervalOptions"
            option-label="label"
            option-value="value"
            class="fs-interval-select"
            :aria-label="'Diashow-Intervall'"
            v-tooltip.top="'Diashow-Intervall'"
            @update:model-value="selectInterval"
          />
          <!-- Slideshow play/pause. Outside the `actions` slot so caller
               overrides still get it. The icon always shows what the click
               does: ▶ to start, ⏸ while running. Never auto-starts. -->
          <Button
            v-if="canSlideshow"
            :icon="playing ? 'pi pi-pause' : 'pi pi-play'"
            rounded text
            :severity="playing ? 'primary' : 'secondary'"
            :class="{ 'fs-toolbar-btn--active': playing }"
            :aria-pressed="playing"
            :aria-label="(playing ? 'Diashow pausieren' : 'Diashow starten') + ' (S)'"
            @click="togglePlay"
            v-tooltip.top="(playing ? 'Diashow pausieren' : 'Diashow starten') + ' (S)'"
          />
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
        v-if="$slots['details-flyout'] && !splitMode"
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

/* ── Split-detail layout (Track AF / #434) ──────────────────────────────── */
/* Re-enable native scrolling/selection: the split panes scroll and the
   metadata contains editable fields, so the overlay's touch lock is lifted. */
.fullscreen-content--split {
  touch-action: auto;
  -webkit-touch-callout: default;
  user-select: auto;
}

.fs-split {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  /* Portrait: the whole pane scrolls as one so the photo can be pushed
     off-screen to reveal more metadata (#434). */
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  background: var(--p-content-background);
  /* Stop mobile WebKit/Blink "text auto-inflation": in a tall scroll
     container it otherwise scales up individual text blocks (description
     placeholder, location label, filename/size) to inconsistent sizes. */
  text-size-adjust: 100%;
  -webkit-text-size-adjust: 100%;
}

.fs-split-photo {
  flex: 0 0 50vh;
  height: 50vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  /* Keep the image clear of the overlaid topbar. */
  padding-top: 2.75em;
  box-sizing: border-box;
  /* Let vertical scrolling fall through to the pane while we capture
     horizontal swipes for prev/next navigation. Suppress the iOS
     long-press image menu and text selection so taps/swipes stay clean. */
  touch-action: pan-y;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
}

/* Make HeicImage's contain box fill the photo pane. */
.fs-split-photo :deep(.heic-image-container),
.fs-split-photo :deep(.image-wrapper) {
  width: 100%;
  height: 100%;
}
.fs-split-photo :deep(.image-content-wrapper) {
  max-height: 100%;
}

.fs-split-details {
  flex: 1 0 auto;
  background: var(--p-content-background);
  color: var(--p-text-color);
  /* Clear the floating action bar pinned to the bottom of the overlay. */
  padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0px));
}

/* Navigation in split mode is via swipe / tap-half (touch) or the keyboard
   arrows (desktop), so hide the on-screen prev/next chevrons that would
   otherwise overlap the metadata column. */
.fullscreen-content--split .fs-nav {
  display: none;
}

/* Landscape (size-independent): photo on the left, metadata scrolls
   independently on the right with a capped width. */
@media (orientation: landscape) {
  .fullscreen-content--split .fs-split {
    flex-direction: row;
    overflow: hidden;
  }
  .fullscreen-content--split .fs-split-photo {
    flex: 1 1 0;
    width: auto;
    height: 100%;
    min-width: 0;
  }
  .fullscreen-content--split .fs-split-details {
    flex: 1 1 0;
    /* Cap the metadata column at roughly an iPhone 16 Pro screen width so it
       doesn't sprawl on wide/desktop landscape viewports; the photo absorbs
       the freed space. */
    max-width: 402px;
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    /* Clear the overlaid topbar that spans the full width. */
    padding-top: 2.75em;
  }
  /* Move the action buttons up into the topbar: drop the floating pill and
     flow them inline as a flex item between the date (center) and the counter
     (right). The topbar already supplies a background, so only the buttons
     move — matching the rest of the topbar.

     Applies in landscape to the split view (details open) for everyone, and
     to the normal fullscreen view for the signed-in app only: the floating
     bottom pill wastes horizontal space and overlaps wide landscape photos,
     whereas the topbar has room to spare. The shared-album guest view keeps
     the floating pill in its normal fullscreen (`--guest`). Portrait keeps
     the floating pill everywhere — the selector is scoped to
     `(orientation: landscape)` by the enclosing media query. */
  .fullscreen-content--split .fs-actions-bar,
  .fullscreen-content:not(.fullscreen-content--guest) .fs-actions-bar {
    position: static;
    transform: none;
    flex: 0 0 auto;
    padding: 0;
    background: none;
    backdrop-filter: none;
    border-radius: 0;
    max-width: none;
    overflow: visible;
  }
  /* The pill-icon colour is white for the dark floating bar; on the (light in
     light theme) topbar background that would be invisible, so fall back to
     the themed text colour like the back button. */
  .fullscreen-content--split .fs-actions-bar :deep(.p-button-rounded),
  .fullscreen-content:not(.fullscreen-content--guest) .fs-actions-bar :deep(.p-button-rounded) {
    color: var(--p-text-color);
  }
  .fullscreen-content--split .fs-actions-bar :deep(.fs-toolbar-btn--active),
  .fullscreen-content:not(.fullscreen-content--guest) .fs-actions-bar :deep(.fs-toolbar-btn--active) {
    background: var(--p-content-hover-background);
  }
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
  /* Offset below the opaque topbar (height 2.75em) so it never covers the
     photo — the wrapper otherwise spans the full viewport (inset: 0) and the
     top of the image disappears behind the bar. Especially visible in
     landscape where the photo fills the full height. Mirrors the split view's
     `padding-top: 2.75em`; using `top` (not padding) keeps the offset fixed
     while the wrapper is zoom-scaled. */
  top: 2.75em;
  right: 0;
  bottom: 0;
  left: 0;
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
  /* Keep the back button / counter clear of rounded corners, the notch and
     the Dynamic Island. In landscape iOS reports a non-zero left/right safe
     area; max() keeps the default 1rem everywhere else. Requires
     viewport-fit=cover (set in index.html). */
  padding-left: max(1rem, env(safe-area-inset-left, 0px));
  padding-right: max(1rem, env(safe-area-inset-right, 0px));
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

/* Top-centre overlay stack, just under the topbar, over the image. Holds the
   day-change banner and the slideshow description caption, centred and
   stacked so they never overlap. Non-interactive so it never blocks taps. */
.fs-top-overlays {
  position: absolute;
  top: 4.25em;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5em;
  max-width: calc(100vw - 2em);
  pointer-events: none;
}

/* Shared pill look for both top overlays. Single line, ellipsised — the
   translucent backdrop keeps the text readable over any photo. */
.fs-day-banner,
.fs-caption {
  max-width: 100%;
  padding: 0.5em 1.1em;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
}
.fs-day-banner { font-size: 1em; font-weight: 600; }
.fs-caption { font-size: 0.95em; }

.fs-top-overlay-enter-active,
.fs-top-overlay-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fs-top-overlay-enter-from,
.fs-top-overlay-leave-to {
  opacity: 0;
  transform: translateY(-0.6em);
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

/* Slideshow interval: compact dropdown that sits among the toolbar buttons.
   Value sits on the left, the caret on the right edge (close to the play
   button) with a gap between the two. */
.fs-interval-select {
  width: 4.25em;
  background: rgba(0, 0, 0, 0.35);
  border: none;
  border-radius: 999px;
}
.fs-interval-select :deep(.p-select-label) {
  flex: 1 1 auto;
  padding: 0.2em 0 0.2em 0.7em;
  font-size: 0.8em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-color, #fff);
}
.fs-interval-select :deep(.p-select-dropdown) {
  width: auto;
  padding: 0 0.35em 0 0;
  color: var(--p-text-color, #fff);
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
  /* Fixed (not absolute) so it stays pinned to the bottom of the viewport
     even though it now lives inside the topbar in the DOM. The overlay is
     teleported to <body> with no transformed ancestors, so fixed resolves
     against the viewport. In landscape split mode this is overridden to flow
     inline within the topbar. */
  position: fixed;
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
