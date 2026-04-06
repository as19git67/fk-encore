<script setup lang="ts">
import { ref, computed, onMounted, defineAsyncComponent } from 'vue'
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
const prevPhoto = computed(() => fullscreenIndex.value > 0 ? fullscreenPhotos.value[fullscreenIndex.value - 1] : null)
const nextPhoto = computed(() => fullscreenIndex.value < fullscreenPhotos.value.length - 1 ? fullscreenPhotos.value[fullscreenIndex.value + 1] : null)

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
  // Map TripMap's Photo[] back to PublicAlbumPhoto[] via id lookup
  const idSet = new Set(stopPhotos.map(p => p.id))
  fullscreenPhotos.value = album.value?.photos.filter(p => idSet.has(p.id)) ?? []
  fullscreenIndex.value = startIndex
  isFullscreen.value = true
}

function closeFullscreen() {
  isFullscreen.value = false
}

function handleKeydown(e: KeyboardEvent) {
  if (!isFullscreen.value) return
  if (e.key === 'Escape') closeFullscreen()
  if (e.key === 'ArrowLeft' && prevPhoto.value) fullscreenIndex.value--
  if (e.key === 'ArrowRight' && nextPhoto.value) fullscreenIndex.value++
}

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
</script>

<template>
  <div class="shared-album-view">
    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <Message v-if="error" severity="error">{{ error }}</Message>

    <template v-if="album">
      <div class="shared-header">
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

    <!-- Simple fullscreen overlay for public view -->
    <Teleport to="body">
      <div v-if="isFullscreen && currentPhoto" class="shared-fullscreen" @click.self="closeFullscreen">
        <button class="close-btn" @click="closeFullscreen"><i class="pi pi-times" /></button>
        <button v-if="prevPhoto" class="nav-btn nav-prev" @click="fullscreenIndex--"><i class="pi pi-chevron-left" /></button>
        <div class="fullscreen-image-container">
          <HeicImage
            :src="getPhotoUrl(currentPhoto.filename)"
            :alt="currentPhoto.original_name"
            objectFit="contain"
          />
        </div>
        <button v-if="nextPhoto" class="nav-btn nav-next" @click="fullscreenIndex++"><i class="pi pi-chevron-right" /></button>
        <div class="fullscreen-info">
          <span v-if="currentPhoto.location_name || currentPhoto.location_city">
            {{ [currentPhoto.location_name, currentPhoto.location_city].filter(Boolean).join(', ') }}
          </span>
          <span v-if="currentPhoto.taken_at">
            {{ new Date(currentPhoto.taken_at).toLocaleDateString() }}
          </span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.shared-album-view {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--p-surface-ground, #f8f9fa);
}

.shared-header {
  padding: 1.5rem 1rem;
  text-align: center;
  background: var(--p-surface-card, #fff);
  border-bottom: 1px solid var(--p-content-border-color, #dee2e6);
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

/* Fullscreen overlay */
.shared-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
}

.fullscreen-image-container {
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fullscreen-image-container :deep(.heic-image-container) {
  max-width: 90vw;
  max-height: 90vh;
}

.fullscreen-image-container :deep(img) {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
}

.close-btn {
  position: absolute;
  top: 1rem;
  right: 1rem;
  background: rgba(255, 255, 255, 0.15);
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
  z-index: 1;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.15);
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
  z-index: 1;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.nav-prev {
  left: 1rem;
}

.nav-next {
  right: 1rem;
}

.fullscreen-info {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 1rem;
  color: rgba(255, 255, 255, 0.8);
  font-size: 0.9rem;
  background: rgba(0, 0, 0, 0.5);
  padding: 0.5rem 1rem;
  border-radius: 999px;
  backdrop-filter: blur(4px);
}
</style>
