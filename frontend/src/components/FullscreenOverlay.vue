<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { formatPhotoDate, formatLocationLabel } from '../utils/dateFormat'

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

// ── Touch-Swipe für mobile Navigation ────────────────────────────────────────
const touchStartX = ref(0)
const touchStartY = ref(0)

function handleTouchStart(e: TouchEvent) {
  touchStartX.value = e.touches[0]!.clientX
  touchStartY.value = e.touches[0]!.clientY
}

function handleTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0]!.clientX - touchStartX.value
  const dy = e.changedTouches[0]!.clientY - touchStartY.value
  // Nur horizontal wischen auswerten, wenn x-Bewegung dominiert
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
    if (dx > 0 && props.prevPhoto) emit('prev')
    else if (dx < 0 && props.nextPhoto) emit('next')
  }
}

// ── Body-Scroll sperren während Fullscreen ──────────────────────────────────
onMounted(() => { document.body.style.overflow = 'hidden' })
onUnmounted(() => { document.body.style.overflow = '' })

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
  return formatPhotoDate(photo.taken_at || photo.created_at)
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

    <div class="fullscreen-content" @click.stop @touchstart="handleTouchStart" @touchend="handleTouchEnd">
      <div @load.capture="onCurrentImageLoad" style="display: contents">
        <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" objectFit="contain">
          <!-- Allow caller to inject overlays (e.g. face box) -->
          <slot />
        </HeicImage>
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
