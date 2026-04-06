<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import { getPublicAlbum, getPhotoUrl, type PublicAlbumResponse, type PublicAlbumPhoto, type Photo } from '../api/photos'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))

const route = useRoute()
const album = ref<PublicAlbumResponse | null>(null)
const loading = ref(true)
const error = ref('')

// Fullscreen state
const isFullscreen = ref(false)
const fullscreenIndex = ref(0)
const fullscreenPhotos = ref<PublicAlbumPhoto[]>([])

const currentPhoto = computed(() => fullscreenPhotos.value[fullscreenIndex.value] ?? null)
const hasPrev = computed(() => fullscreenIndex.value > 0)
const hasNext = computed(() => fullscreenIndex.value < fullscreenPhotos.value.length - 1)
const photoCounter = computed(() => `${fullscreenIndex.value + 1} / ${fullscreenPhotos.value.length}`)

/** Cast PublicAlbumPhoto[] to Photo[] for components that expect full Photo type */
function asPhotos(photos: PublicAlbumPhoto[]): Photo[] {
  return photos.map(p => ({
    ...p,
    user_id: 0,
    hash: undefined,
    curation_status: 'visible' as const,
    ai_quality_details: undefined,
  }))
}

const albumPhotosAsPhoto = computed(() => album.value ? asPhotos(album.value.photos) : [])

function openFullscreen(photo: PublicAlbumPhoto, photos: PublicAlbumPhoto[]) {
  fullscreenPhotos.value = photos
  fullscreenIndex.value = photos.findIndex(p => p.id === photo.id)
  if (fullscreenIndex.value < 0) fullscreenIndex.value = 0
  isFullscreen.value = true
}

function handleMapFullscreen(stopPhotos: Photo[], startIndex: number) {
  const idSet = new Set(stopPhotos.map(p => p.id))
  fullscreenPhotos.value = album.value?.photos.filter(p => idSet.has(p.id)) ?? []
  fullscreenIndex.value = startIndex
  isFullscreen.value = true
}

function closeFullscreen() {
  isFullscreen.value = false
}

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

// ── Touch swipe ─────────────────────────────────────────────────────────────

let touchStartX = 0
let touchStartY = 0
let touchStartTime = 0

function handleTouchStart(e: TouchEvent) {
  const touch = e.touches[0]
  if (!touch) return
  touchStartX = touch.clientX
  touchStartY = touch.clientY
  touchStartTime = Date.now()
}

function handleTouchEnd(e: TouchEvent) {
  const touch = e.changedTouches[0]
  if (!touch) return

  const dx = touch.clientX - touchStartX
  const dy = touch.clientY - touchStartY
  const dt = Date.now() - touchStartTime

  // Must be a horizontal swipe: fast enough, far enough, more horizontal than vertical
  if (dt > 500 || Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return

  if (dx < 0) goNext()
  else goPrev()
}

// ── Info formatting ─────────────────────────────────────────────────────────

function formatLocation(photo: PublicAlbumPhoto): string {
  return [photo.location_name, photo.location_city, photo.location_country]
    .filter(Boolean)
    .join(', ')
}

function formatDate(photo: PublicAlbumPhoto): string {
  const d = photo.taken_at ? new Date(photo.taken_at) : null
  if (!d) return ''
  return d.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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
      <div :class="['shared-header', { 'shared-header--compact': album.display_mode === 'map' }]">
        <h1 class="title">{{ album.name }}</h1>
        <template v-if="album.display_mode !== 'map'">
          <p v-if="album.description" class="description">{{ album.description }}</p>
          <span class="meta">
            {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
            <template v-if="album.oldest_photo_at && album.newest_photo_at">
              · {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
            </template>
          </span>
        </template>
      </div>

      <!-- Map mode -->
      <TripMap
        v-if="album.display_mode === 'map' && album.photos.length > 0"
        :photos="albumPhotosAsPhoto"
        @open-fullscreen="handleMapFullscreen"
      />

      <!-- Grid mode -->
      <div v-else class="photo-grid">
        <div
          v-for="photo in album.photos"
          :key="photo.id"
          class="grid-item"
          @click="openFullscreen(photo, album!.photos)"
        >
          <HeicImage
            :src="getPhotoUrl(photo.filename, 400)"
            :alt="photo.original_name"
            objectFit="cover"
          />
        </div>
      </div>
    </template>

    <!-- Fullscreen overlay -->
    <Teleport to="body">
      <div
        v-if="isFullscreen && currentPhoto"
        class="shared-fullscreen"
        @touchstart.passive="handleTouchStart"
        @touchend.passive="handleTouchEnd"
      >
        <!-- Close button -->
        <button class="fs-close" @click="closeFullscreen"><i class="pi pi-times" /></button>

        <!-- Image area -->
        <div class="fs-image" @click.self="closeFullscreen">
          <HeicImage
            :key="currentPhoto.id"
            :src="getPhotoUrl(currentPhoto.filename)"
            :alt="currentPhoto.original_name"
            objectFit="contain"
          />
        </div>

        <!-- Navigation arrows (desktop) -->
        <button v-if="hasPrev" class="fs-nav fs-nav--prev" @click="goPrev">
          <i class="pi pi-chevron-left" />
        </button>
        <button v-if="hasNext" class="fs-nav fs-nav--next" @click="goNext">
          <i class="pi pi-chevron-right" />
        </button>

        <!-- Bottom info bar -->
        <div class="fs-info-bar">
          <div class="fs-info-text">
            <div v-if="formatLocation(currentPhoto)" class="fs-info-location">
              <i class="pi pi-map-marker" /> {{ formatLocation(currentPhoto) }}
            </div>
            <div v-if="formatDate(currentPhoto)" class="fs-info-date">
              {{ formatDate(currentPhoto) }}
            </div>
          </div>
          <div v-if="fullscreenPhotos.length > 1" class="fs-info-counter">
            {{ photoCounter }}
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.shared-album-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
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

.shared-header--compact {
  padding: 0.5rem 1rem;
}

.shared-header .title {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
}

.shared-header--compact .title {
  font-size: 1.1rem;
  margin: 0;
}

.shared-header .description {
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
}

.shared-header .meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px;
  padding: 4px;
}

.grid-item {
  aspect-ratio: 1;
  overflow: hidden;
  cursor: pointer;
  border-radius: 4px;
}

.grid-item :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

.grid-item:hover {
  opacity: 0.85;
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

/* ── Fullscreen overlay ─────────────────────────────────────────────────── */

.shared-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: #000;
  display: flex;
  flex-direction: column;
  user-select: none;
  -webkit-user-select: none;
}

.fs-image {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  min-height: 0;
}

.fs-image :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

.fs-image :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Close button */
.fs-close {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 10;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: white;
  font-size: 1.25rem;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}

.fs-close:hover {
  background: rgba(255, 255, 255, 0.25);
}

/* Navigation arrows */
.fs-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: white;
  font-size: 1.5rem;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  transition: background 0.15s;
}

.fs-nav:hover {
  background: rgba(255, 255, 255, 0.25);
}

.fs-nav--prev { left: 0.75rem; }
.fs-nav--next { right: 0.75rem; }

/* Bottom info bar - full width, no radius */
.fs-info-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
  padding: 0.75rem 1rem;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.9);
  flex-shrink: 0;
}

.fs-info-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  flex: 1;
}

.fs-info-location {
  font-size: 0.95rem;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.fs-info-location .pi {
  font-size: 0.85rem;
  opacity: 0.7;
}

.fs-info-date {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.6);
}

.fs-info-counter {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  flex-shrink: 0;
  padding-left: 1rem;
}

/* Mobile: hide arrow buttons, swipe handles navigation */
@media (max-width: 768px) {
  .fs-nav {
    display: none;
  }

  .fs-info-bar {
    padding: 0.6rem 0.75rem;
  }

  .fs-info-location {
    font-size: 0.85rem;
  }
}
</style>
