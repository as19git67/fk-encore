<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
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

function asPhoto(p: PublicAlbumPhoto): Photo {
  return { ...p, user_id: 0, hash: undefined, curation_status: 'visible' as const, ai_quality_details: undefined }
}
const currentPhotoAsPhoto = computed(() => currentPhoto.value ? asPhoto(currentPhoto.value) : null)
const prevPhotoAsPhoto = computed(() => {
  const idx = fullscreenIndex.value - 1
  return idx >= 0 ? asPhoto(fullscreenPhotos.value[idx]!) : null
})
const nextPhotoAsPhoto = computed(() => {
  const idx = fullscreenIndex.value + 1
  return idx < fullscreenPhotos.value.length ? asPhoto(fullscreenPhotos.value[idx]!) : null
})

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

// ── Info formatting ─────────────────────────────────────────────────────────

function formatLocation(photo: PublicAlbumPhoto): string {
  return formatLocationLabel(photo)
}

function formatDate(photo: PublicAlbumPhoto): string {
  return formatPhotoDate(photo.taken_at)
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

    <!-- Fullscreen overlay (reuses shared FullscreenOverlay component) -->
    <FullscreenOverlay
      v-if="isFullscreen && currentPhotoAsPhoto"
      :photo="currentPhotoAsPhoto"
      :prevPhoto="prevPhotoAsPhoto"
      :nextPhoto="nextPhotoAsPhoto"
      :canDelete="false"
      @close="closeFullscreen"
      @prev="goPrev"
      @next="goNext"
    >
      <template #topbar-actions><!-- no action buttons in shared view --></template>
      <template #bottom-bar>
        <div class="fs-info-bar">
          <div class="fs-info-text">
            <div v-if="currentPhoto && formatLocation(currentPhoto)" class="fs-info-location">
              <i class="pi pi-map-marker" /> {{ formatLocation(currentPhoto) }}
            </div>
            <div v-if="currentPhoto && formatDate(currentPhoto)" class="fs-info-date">
              {{ formatDate(currentPhoto) }}
            </div>
          </div>
          <div v-if="fullscreenPhotos.length > 1" class="fs-info-counter">
            {{ photoCounter }}
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

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-col), 1fr));
  gap: var(--grid-gap-compact);
  padding: var(--grid-gap-compact);
}

.grid-item {
  aspect-ratio: 1;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
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

/* ── Fullscreen bottom info bar (rendered via FullscreenOverlay slot) ──── */

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

@media (max-width: 768px) {
  .fs-info-bar {
    padding: 0.6rem 0.75rem;
  }

  .fs-info-location {
    font-size: 0.85rem;
  }
}
</style>
