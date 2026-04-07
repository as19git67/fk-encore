<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Photo, type CurationStatus } from '../api/photos'
import { formatPhotoDate, formatLocationLabel } from '../utils/dateFormat'

const props = defineProps<{
  photo: Photo
  prevPhoto: Photo | null
  nextPhoto: Photo | null
  canDelete?: boolean
  /** Optional slot content rendered inside the fullscreen image (e.g. face box) */
}>()

const emit = defineEmits<{
  'close': []
  'prev': []
  'next': []
  'toggle-favorite': [id: number, status: CurationStatus]
  'hide': [id: number]
  'restore': [id: number]
  'show-details': []
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
    // Stop parent useGalleryKeyboard from also handling the event
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.key === 'ArrowLeft' && props.prevPhoto) emit('prev')
    else if (e.key === 'ArrowRight' && props.nextPhoto) emit('next')
    else if (e.key === 'Escape') emit('close')
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
          <slot name="topbar-actions">
            <Button
              icon="pi pi-info-circle" rounded text severity="secondary"
              @click="emit('show-details')"
              v-tooltip.bottom="'Details'"
            />
            <Button
              v-if="canDelete"
              :icon="photo.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'"
              rounded text
              :severity="photo.curation_status === 'hidden' ? 'danger' : 'secondary'"
              @click="photo.curation_status === 'hidden' ? emit('restore', photo.id) : emit('hide', photo.id)"
            />
            <Button
              v-if="canDelete"
              :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              rounded text
              :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
              @click="emit('toggle-favorite', photo.id, photo.curation_status)"
            />
          </slot>
        </div>
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
  justify-content: center;
}

.fs-info-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.3;
}

.fs-date-bar {
  color: rgba(255,255,255,0.85);
  font-size: 0.9em;
}

.fs-location-bar {
  color: rgba(255,255,255,0.6);
  font-size: 0.75em;
  display: flex;
  align-items: center;
  gap: 0.3em;
}

.fs-toolbar {
  display: flex;
  gap: 0.25em;
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
