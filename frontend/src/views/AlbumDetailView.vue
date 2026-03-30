<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import { getAlbum, getPhotoUrl, updateAlbumUserSettings, type AlbumWithPhotos } from '../api/photos'

const route = useRoute()
const albumId = Number(route.params.id)

const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)

const viewOptions = [
  { label: 'Alle', value: 'all' },
  { label: 'Favoriten', value: 'favorites' }
]

const hideModeOptions = [
  { label: 'Meine ausgeblendeten', value: 'mine' },
  { label: 'Alle ausgeblendeten', value: 'all' }
]

async function loadData() {
  loading.value = true
  try {
    album.value = await getAlbum(albumId)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Albums'
  } finally {
    loading.value = false
  }
}

async function handleSettingsChange() {
  if (!album.value?.settings) return
  try {
    await updateAlbumUserSettings(albumId, album.value.settings)
    // After changing settings, re-fetch album to get filtered photo list from server
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Einstellungen'
  }
}

const selectedPhoto = computed(() => {
  if (selectedIndex.value < 0 || !album.value) return null
  return album.value.photos[selectedIndex.value] || null
})

onMounted(loadData)

// Reuse observer logic for performance
const visiblePhotoIds = ref(new Set<number>())
const gridScrollRef = ref<HTMLElement | null>(null)
let photoObserver: IntersectionObserver | null = null

function setupObserver() {
  photoObserver?.disconnect()
  visiblePhotoIds.value = new Set()
  if (!gridScrollRef.value) return

  photoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.photoId)
        if (entry.isIntersecting) visiblePhotoIds.value.add(id)
        else visiblePhotoIds.value.delete(id)
      }
    },
    { root: gridScrollRef.value, rootMargin: '200px' }
  )
  for (const el of gridScrollRef.value.querySelectorAll('[data-photo-id]')) {
    photoObserver.observe(el)
  }
}

watch([album, gridScrollRef], () => {
  if (album.value && gridScrollRef.value) {
    nextTick(setupObserver)
  }
})
</script>

<template>
  <div class="album-detail-view">
    <div v-if="album" class="subheader">
      <div class="header">
        <div class="header-left">
          <h1>{{ album.name }}</h1>
          <span class="role-badge" :class="album.role">{{ album.role }}</span>
        </div>
        <div class="controls" v-if="album.settings">
          <div class="control-group">
            <label>Ansicht:</label>
            <SelectButton
              v-model="album.settings.active_view"
              :options="viewOptions"
              optionLabel="label"
              optionValue="value"
              @change="handleSettingsChange"
            />
          </div>
          <div class="control-group">
            <label>Ausblenden:</label>
            <SelectButton
              v-model="album.settings.hide_mode"
              :options="hideModeOptions"
              optionLabel="label"
              optionValue="value"
              @change="handleSettingsChange"
            />
          </div>
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && !album" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <div v-if="album" class="album-layout">
      <div class="photo-grid-scroll" ref="gridScrollRef">
        <div v-if="album.photos.length === 0" class="info-text">
          Keine Fotos in dieser Ansicht.
        </div>
        <div v-else class="photo-grid">
          <div
            v-for="(photo, idx) in album.photos"
            :key="photo.id"
            :data-photo-id="photo.id"
            class="photo-item"
            :class="{ selected: idx === selectedIndex }"
            @click="selectedIndex = idx"
          >
            <div class="photo-thumb">
              <HeicImage
                v-if="visiblePhotoIds.has(photo.id)"
                :src="getPhotoUrl(photo.filename, 400)"
                :alt="photo.original_name"
                objectFit="cover"
              />
              <div v-else class="thumb-placeholder" />
            </div>
            <div class="photo-meta">
              <span class="photo-name">{{ photo.original_name }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="sidebar-container" v-if="selectedPhoto">
         <PhotoDetailSidebar
            :photo="selectedPhoto"
            :faces="[]"
            :loading-faces="false"
            :landmarks="[]"
            :loading-landmarks="false"
            :persons="[]"
            :can-delete="false"
            :can-upload="false"
            :reindexing-photo="false"
            :is-editing-date="false"
            :updating-date="false"
            @fullscreen="isFullscreen = true"
         />
      </div>
    </div>
  </div>
</template>

<style scoped>
.album-detail-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.role-badge {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  background: var(--p-surface-200);
  text-transform: uppercase;
}
.role-badge.owner { background: #fee2e2; color: #991b1b; }
.role-badge.contributor { background: #dcfce7; color: #166534; }

.controls {
  display: flex;
  gap: 2rem;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.control-group label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.album-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.photo-grid-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}
.photo-item {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: var(--p-surface-100);
}
.photo-item.selected {
  border-color: var(--p-primary-color);
}
.photo-thumb {
  width: 100%;
  height: 100%;
}
.thumb-placeholder {
  width: 100%;
  height: 100%;
  background: var(--p-surface-200);
}
.photo-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0,0,0,0.5);
  color: white;
  padding: 0.25rem;
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar-container {
  width: 320px;
  border-left: 1px solid var(--p-content-border-color);
  background: var(--p-surface-card);
}
.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}
</style>
