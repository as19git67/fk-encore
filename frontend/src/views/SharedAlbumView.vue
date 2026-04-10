<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import { getPublicAlbum, getPhotoUrl, type PublicAlbumResponse, type PublicAlbumPhoto, type Photo } from '../api/photos'
import { formatPhotoDate, formatLocationLabel } from '../utils/dateFormat'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))

const route = useRoute()
const album = ref<PublicAlbumResponse | null>(null)
const loading = ref(true)
const error = ref('')

/** Cast PublicAlbumPhoto[] to Photo[] for components that expect full Photo type */
function asPhotos(photos: PublicAlbumPhoto[]): Photo[] {
  return photos.map(p => ({
    ...p,
    user_id: 0,
    hash: undefined,
    curation_status: 'visible' as const,
    ai_quality_details: undefined,
    description: p.description,
  }))
}

const albumPhotosAsPhoto = computed<Photo[]>(() => album.value ? asPhotos(album.value.photos) : [])

// Fullscreen state — uses full Photo type so FullscreenOverlay works directly
const isFullscreen = ref(false)
const fullscreenIndex = ref(0)
const fullscreenPhotos = ref<Photo[]>([])

const currentPhoto = computed<Photo | null>(() => fullscreenPhotos.value[fullscreenIndex.value] ?? null)
const prevPhoto = computed<Photo | null>(() => {
  const idx = fullscreenIndex.value - 1
  return idx >= 0 ? (fullscreenPhotos.value[idx] ?? null) : null
})
const nextPhoto = computed<Photo | null>(() => {
  const idx = fullscreenIndex.value + 1
  return idx < fullscreenPhotos.value.length ? (fullscreenPhotos.value[idx] ?? null) : null
})
const hasPrev = computed(() => fullscreenIndex.value > 0)
const hasNext = computed(() => fullscreenIndex.value < fullscreenPhotos.value.length - 1)
const photoCounter = computed(() => `${fullscreenIndex.value + 1} / ${fullscreenPhotos.value.length}`)

function openFullscreen(photo: Photo) {
  const photos = albumPhotosAsPhoto.value
  fullscreenPhotos.value = photos
  fullscreenIndex.value = photos.findIndex(p => p.id === photo.id)
  if (fullscreenIndex.value < 0) fullscreenIndex.value = 0
  isFullscreen.value = true
}

function handleMapFullscreen(stopPhotos: Photo[], startIndex: number) {
  // stopPhotos come directly from TripMap and are already Photo[] — use as-is
  // to preserve the stop's photo ordering (and keep startIndex valid).
  fullscreenPhotos.value = stopPhotos
  fullscreenIndex.value = startIndex
  isFullscreen.value = true
}

function closeFullscreen() {
  isFullscreen.value = false
  showInfo.value = false
}

// ── Info panel (slides up from bottom, photo shrinks to 60%) ────────────────

const showInfo = ref(false)
function toggleInfo() {
  showInfo.value = !showInfo.value
}

/** Per-photo description (only — no album fallback). */
const currentDescription = computed<string>(() => {
  return currentPhoto.value?.description?.trim() ?? ''
})

/** Maps URL — Apple Maps on Apple devices, Google Maps elsewhere. */
const isApple = /iPhone|iPad|iPod|Mac/.test(navigator.userAgent)
const currentMapUrl = computed<string | null>(() => {
  const p = currentPhoto.value
  if (!p || p.latitude == null || p.longitude == null) return null
  if (isApple) {
    const q = formatSharedLocation(p)
    return `https://maps.apple.com/?ll=${p.latitude},${p.longitude}&q=${encodeURIComponent(q || `${p.latitude},${p.longitude}`)}`
  }
  return `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`
})

// Reset panel when leaving fullscreen by other means (e.g., swipe to close)
watch(isFullscreen, (open) => {
  if (!open) showInfo.value = false
})

function goPrev() {
  if (hasPrev.value) fullscreenIndex.value--
}

function goNext() {
  if (hasNext.value) fullscreenIndex.value++
}

// ── Keyboard navigation ─────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
  if (!isFullscreen.value) return
  if (e.key === 'Escape') closeFullscreen()
  if (e.key === 'ArrowLeft') goPrev()
  if (e.key === 'ArrowRight') goNext()
}

// ── Info formatting ─────────────────────────────────────────────────────────

/**
 * Build a location label, removing duplicate segments.
 * Nominatim often returns `location_name` already containing the city
 * (e.g. "Josef-Haubrich-Hof 5, Köln"), which would otherwise produce
 * "Josef-Haubrich-Hof 5, Köln, Köln" when concatenated with location_city.
 */
function formatSharedLocation(photo: Photo): string {
  const parts = formatLocationLabel(photo).split(', ')
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const p of parts) {
    const key = p.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(p.trim())
  }
  return deduped.join(', ')
}

function formatDate(photo: Photo): string {
  return formatPhotoDate(photo.taken_at || photo.created_at)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  const token = route.params.token as string
  if (!token) {
    error.value = 'Kein gültiger Link'
    loading.value = false
    return
  }
  try {
    album.value = await getPublicAlbum(token)
  } catch (err: any) {
    error.value = err.message || 'Album konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="shared-album-view">
    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <Message v-if="error" severity="error">{{ error }}</Message>

    <template v-if="album">
      <div v-if="album.display_mode !== 'map'" class="shared-header">
        <h1 class="title">{{ album.name }}</h1>
        <p v-if="album.description" class="description">{{ album.description }}</p>
        <span class="meta">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            · {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
      </div>

      <!-- Map mode -->
      <TripMap
        v-if="album.display_mode === 'map' && album.photos.length > 0"
        :photos="albumPhotosAsPhoto"
        :albumName="album.name"
        :albumDescription="album.description"
        @open-fullscreen="handleMapFullscreen"
      />

      <!-- Grid mode -->
      <div v-else class="photo-grid-scroll">
        <div class="photo-grid">
          <div
            v-for="photo in albumPhotosAsPhoto"
            :key="photo.id"
            class="grid-item"
            @click="openFullscreen(photo)"
          >
            <HeicImage
              :src="getPhotoUrl(photo.filename, 400)"
              :alt="photo.original_name"
              objectFit="cover"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- Fullscreen overlay (reuses shared FullscreenOverlay component) -->
    <FullscreenOverlay
      v-if="isFullscreen && currentPhoto"
      :photo="currentPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="false"
      @close="closeFullscreen"
      @prev="goPrev"
      @next="goNext"
      @show-details="toggleInfo"
    >
      <template #topbar-center>
        <div v-if="currentPhoto" class="shared-fs-info-center">
          <div class="shared-fs-date">{{ formatDate(currentPhoto) }}</div>
          <div v-if="formatSharedLocation(currentPhoto)" class="shared-fs-location">
            <i class="pi pi-map-marker" />
            {{ formatSharedLocation(currentPhoto) }}
          </div>
        </div>
      </template>
      <template #bottom-bar>
        <div v-if="fullscreenPhotos.length > 1 && !showInfo" class="fs-counter-pill">
          {{ photoCounter }}
        </div>
        <div
          class="shared-album-info-panel"
          :class="{ 'is-open': showInfo }"
          @click.stop
          @touchstart.stop
          @touchend.stop
          @touchmove.stop
        >
          <div v-if="currentPhoto" class="info-panel-content">
            <div class="info-row info-date">
              <i class="pi pi-calendar" />
              <span>{{ formatDate(currentPhoto) }}</span>
            </div>
            <div v-if="formatSharedLocation(currentPhoto)" class="info-row info-location">
              <i class="pi pi-map-marker" />
              <a v-if="currentMapUrl" :href="currentMapUrl" target="_blank" rel="noopener" class="info-location-link">
                {{ formatSharedLocation(currentPhoto) }}
              </a>
              <span v-else>{{ formatSharedLocation(currentPhoto) }}</span>
            </div>
            <div v-if="currentDescription" class="info-row info-description">
              <i class="pi pi-align-left" />
              <p>{{ currentDescription }}</p>
            </div>
          </div>
        </div>
      </template>
    </FullscreenOverlay>
  </div>
</template>

<style scoped>
.shared-album-view {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  background: var(--p-surface-ground, #f8f9fa);
}

.shared-header {
  padding: 1.5rem 1rem;
  text-align: center;
  background: var(--p-surface-card, #fff);
  border-bottom: 1px solid var(--p-content-border-color, #dee2e6);
  flex-shrink: 0;
}

.shared-header .title {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
}

.shared-header .description {
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
}

.shared-header .meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.photo-grid-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--grid-gap-compact);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-col), 1fr));
  gap: var(--grid-gap-compact);
}

@media (max-width: 768px) {
  .photo-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--spacing-sm, 4px);
  }

  .photo-grid-scroll {
    padding: var(--spacing-sm, 4px);
  }
}

.grid-item {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
  background: var(--p-content-hover-background, #eee);
}

.grid-item :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

@media (hover: hover) {
  .grid-item:hover {
    opacity: 0.85;
  }
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

/* ── Fullscreen topbar-center override (dedup city) ─────────────────────── */

.shared-fs-info-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.3;
}

.shared-fs-date {
  color: rgba(255, 255, 255, 0.85);
  font-size: 0.9em;
}

.shared-fs-location {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.75em;
  display: flex;
  align-items: center;
  gap: 0.3em;
}

/* ── Counter pill, styled like the nav buttons but horizontally centered ─ */

.fs-counter-pill {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  background: rgba(0, 0, 0, 0.4);
  padding: 0.5rem 0.9rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
  z-index: 10;
  backdrop-filter: blur(6px);
  pointer-events: none;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .fs-counter-pill {
    top: auto;
    bottom: 4rem;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.5);
    padding: 0.75rem 1rem;
  }
}

/* ── Info panel (slides up from bottom, 40% height) ─────────────────────── */

.shared-album-info-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40dvh;
  background: rgba(18, 18, 18, 0.96);
  backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.92);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  transform: translateY(100%);
  transition: transform 0.3s ease;
  z-index: 11;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
  padding-bottom: calc(1.25rem + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
}

.shared-album-info-panel.is-open {
  transform: translateY(0);
}

.info-panel-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 48rem;
  margin: 0 auto;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 0.95rem;
  line-height: 1.4;
}

.info-row .pi {
  margin-top: 0.15rem;
  opacity: 0.6;
  flex-shrink: 0;
  font-size: 0.95rem;
}

.info-row > span,
.info-row > p {
  margin: 0;
  min-width: 0;
  word-wrap: break-word;
}

.info-date {
  color: rgba(255, 255, 255, 0.95);
  font-weight: 500;
}

.info-location {
  color: rgba(255, 255, 255, 0.8);
}

.info-location-link {
  color: rgba(120, 180, 255, 0.95);
  text-decoration: none;
}

.info-location-link:active {
  opacity: 0.7;
}

.info-description {
  color: rgba(255, 255, 255, 0.75);
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .shared-album-info-panel {
    padding: 1rem 1rem;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }

  .info-panel-content {
    gap: 0.75rem;
  }

  .info-row {
    font-size: 0.9rem;
  }
}
</style>

<!--
  Global style: reach into FullscreenOverlay's .fullscreen-content to shrink
  the photo to 60% height while the info panel is open. Scoped via :has() on
  the info panel class, so it only activates when SharedAlbumView has injected
  the panel — no effect on logged-in user views.
-->
<style>
.fullscreen-content:has(> .shared-album-info-panel.is-open) {
  padding-bottom: 40dvh;
  transition: padding-bottom 0.3s ease;
}

/* Hide nav buttons while info panel is open to avoid overlap */
.fullscreen-overlay:has(.shared-album-info-panel.is-open) .fs-nav {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
</style>
