<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import Button from 'primevue/button'
import FileUpload from 'primevue/fileupload'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import { listPhotos, uploadPhoto, deletePhoto, getPhotoUrl, getPhotosToRefreshMetadata, refreshPhotoMetadata, type Photo } from '../api/photos'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const photos = ref<Photo[]>([])
const loading = ref(true)
const uploading = ref(false)
const error = ref('')
const selectedIndex = ref(-1)
const isFullscreen = ref(false)

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const canRefreshMetadata = computed(() => auth.hasPermission('photos.refresh_metadata'))

const refreshingMetadata = ref(false)
const refreshProgress = ref(0)
const refreshTotal = ref(0)
const refreshCurrent = ref(0)

interface PhotoItem {
  photo: Photo;
  index: number;
}

interface MonthGroup {
  month: string;
  photos: PhotoItem[];
}

interface YearGroup {
  year: string;
  months: MonthGroup[];
}

const groupedPhotos = computed(() => {
  const groups: YearGroup[] = [];
  
  photos.value.forEach((photo, index) => {
    const date = new Date(photo.taken_at || photo.created_at);
    const year = date.getFullYear().toString();
    const month = date.toLocaleString('de-DE', { month: 'long' });
    
    let yearGroup = groups.find(g => g.year === year);
    if (!yearGroup) {
      yearGroup = { year, months: [] };
      groups.push(yearGroup);
    }
    
    let monthGroup = yearGroup.months.find(m => m.month === month);
    if (!monthGroup) {
      monthGroup = { month, photos: [] };
      yearGroup.months.push(monthGroup);
    }
    
    monthGroup.photos.push({ photo, index });
  });
  
  return groups;
});

async function loadPhotos() {
  loading.value = true
  error.value = ''
  try {
    const res = await listPhotos()
    photos.value = res.photos
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Fotos'
  } finally {
    loading.value = false
  }
}

async function handleUpload(event: any) {
  const files = event.files
  if (!files || files.length === 0) return
  
  uploading.value = true
  error.value = ''
  let duplicates = []
  let errors = []

  try {
    for (const file of files) {
      try {
        await uploadPhoto(file)
      } catch (err: any) {
        if (err.message?.includes('Foto wurde bereits hochgeladen')) {
          duplicates.push(file.name)
        } else {
          errors.push(`${file.name}: ${err.message}`)
        }
      }
    }
    
    await loadPhotos()
    
    if (duplicates.length > 0 || errors.length > 0) {
      let msg = ''
      if (duplicates.length > 0) {
        msg += `Folgende Fotos wurden übersprungen, da sie bereits vorhanden sind: ${duplicates.join(', ')}. `
      }
      if (errors.length > 0) {
        msg += `Fehler bei: ${errors.join('; ')}.`
      }
      error.value = msg
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Hochladen'
  } finally {
    uploading.value = false
  }
}

async function handleDelete(id: number) {
  if (!confirm('Foto wirklich löschen?')) return
  try {
    await deletePhoto(id)
    await loadPhotos()
    if (selectedIndex.value >= photos.value.length) {
        selectedIndex.value = photos.value.length - 1
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

async function handleRefreshMetadata() {
  if (refreshingMetadata.value) return
  
  refreshingMetadata.value = true
  refreshProgress.value = 0
  refreshCurrent.value = 0
  refreshTotal.value = 0
  error.value = ''
  
  try {
    const res = await getPhotosToRefreshMetadata()
    const ids = res.ids
    
    if (ids.length === 0) {
      refreshingMetadata.value = false
      return
    }
    
    refreshTotal.value = ids.length
    
    for (const id of ids) {
      try {
        await refreshPhotoMetadata(id)
      } catch (err) {
        console.error(`Fehler beim Aktualisieren der Metadaten für Foto ${id}:`, err)
      }
      refreshCurrent.value++
      refreshProgress.value = Math.round((refreshCurrent.value / refreshTotal.value) * 100)
    }
    
    await loadPhotos()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Aktualisieren der Metadaten'
  } finally {
    refreshingMetadata.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (isFullscreen.value) {
    if (e.key === 'Escape' || e.key === ' ') {
      isFullscreen.value = false
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      if (selectedIndex.value > 0) {
        selectedIndex.value--
      }
    } else if (e.key === 'ArrowRight') {
      if (selectedIndex.value < photos.value.length - 1) {
        selectedIndex.value++
      }
    }
    return
  }

  if (photos.value.length === 0) return

  // Basic grid navigation
  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = photos.value.length - 1
  } else if (e.key === 'ArrowDown') {
    // Assume 4 columns for simpler navigation logic
    if (selectedIndex.value + 4 < photos.value.length) selectedIndex.value += 4
  } else if (e.key === 'ArrowUp') {
    if (selectedIndex.value - 4 >= 0) selectedIndex.value -= 4
  } else if (e.key === ' ') {
    if (selectedIndex.value !== -1) {
        isFullscreen.value = !isFullscreen.value
        e.preventDefault()
    }
  } else if (e.key === 'Enter') {
    if (selectedIndex.value !== -1) {
        isFullscreen.value = true
    }
  }
}

watch(selectedIndex, (newIdx) => {
  if (newIdx === -1 || isFullscreen.value) return
  nextTick(() => {
    const el = document.querySelector('.photo-item.selected')
    if (el) {
      el.scrollIntoView({ behavior: 'auto', block: 'nearest' })
    }
  })
})

onMounted(() => {
  loadPhotos()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="photos-view">
    <div class="header">
      <h1>Meine Fotos</h1>
      <div class="actions">
        <Button 
          v-if="canRefreshMetadata"
          label="Metadaten aktualisieren" 
          icon="pi pi-refresh" 
          severity="secondary" 
          :loading="refreshingMetadata"
          @click="handleRefreshMetadata"
          class="refresh-btn"
        />
        <FileUpload 
          v-if="canUpload"
          mode="basic" 
          name="file" 
          accept="image/*" 
          :auto="true" 
          customUpload 
          multiple
          @uploader="handleUpload" 
          chooseLabel="Fotos hochladen" 
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="refreshingMetadata" class="progress-container">
      <div class="progress-info">
        <span>Metadaten werden aktualisiert...</span>
        <span>{{ refreshCurrent }} / {{ refreshTotal }}</span>
      </div>
      <ProgressBar :value="refreshProgress"></ProgressBar>
    </div>

    <div v-if="uploading" class="info-text">Fotos werden hochgeladen...</div>
    <div v-else-if="loading" class="info-text">Lade Fotos...</div>
    <div v-else-if="photos.length === 0" class="info-text">Keine Fotos hochgeladen.</div>

    <div v-else class="photo-grid">
      <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
        <h2 class="grid-header year-title">{{ yearGroup.year }}</h2>
        <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
          <h3 class="grid-header month-title">{{ monthGroup.month }}</h3>
          <div 
            v-for="item in monthGroup.photos" 
            :key="item.photo.id" 
            class="photo-item"
            :class="{ selected: item.index === selectedIndex }"
            @click="selectedIndex = item.index; isFullscreen = true"
          >
            <img :src="getPhotoUrl(item.photo.filename)" :alt="item.photo.original_name" loading="lazy" />
            <div class="photo-info">
              <span class="name">{{ item.photo.original_name }}</span>
              <Button 
                v-if="canDelete"
                icon="pi pi-trash" 
                severity="danger" 
                text 
                rounded 
                @click.stop="handleDelete(item.photo.id)" 
              />
            </div>
          </div>
        </template>
      </template>
    </div>

    <div v-if="isFullscreen && selectedIndex !== -1" class="fullscreen-overlay" @click="isFullscreen = false">
      <!-- Preload next and previous image -->
      <div style="display: none">
        <img v-if="selectedIndex > 0" :src="getPhotoUrl(photos[selectedIndex - 1].filename)" />
        <img v-if="selectedIndex < photos.length - 1" :src="getPhotoUrl(photos[selectedIndex + 1].filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <img :src="getPhotoUrl(photos[selectedIndex].filename)" :alt="photos[selectedIndex].original_name" />
        <div class="fullscreen-nav">
            <Button icon="pi pi-chevron-left" rounded text @click="selectedIndex > 0 && selectedIndex--" :disabled="selectedIndex === 0" />
            <div class="fullscreen-title">{{ photos[selectedIndex].original_name }}</div>
            <Button icon="pi pi-chevron-right" rounded text @click="selectedIndex < photos.length - 1 && selectedIndex++" :disabled="selectedIndex === photos.length - 1" />
        </div>
        <Button icon="pi pi-times" class="close-btn" rounded severity="secondary" @click="isFullscreen = false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.progress-container {
  margin-bottom: 2rem;
  background: var(--surface-card);
  padding: 1rem;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.progress-info {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
  color: var(--text-color-secondary);
}

.info-text {
  text-align: center;
  margin: 3rem 0;
  color: var(--text-color-secondary);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.grid-header {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--text-color);
}

.year-title {
  border-bottom: 2px solid var(--p-primary-color);
  padding-bottom: 0.5rem;
  margin-top: 2.5rem;
  margin-bottom: 0.5rem;
  font-size: 1.5rem;
}

.month-title {
  color: var(--text-color-secondary);
  font-weight: 500;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
}

.photo-item {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  cursor: pointer;
  transition: transform 0.2s;
  border: 4px solid transparent;
}

.photo-item:hover {
  transform: scale(1.02);
}

.photo-item.selected {
  border-color: var(--p-primary-color);
  transform: scale(1.05);
  box-shadow: 0 0 15px var(--p-primary-color);
  z-index: 10;
}

.photo-item.selected img {
  filter: brightness(1.1);
}

/* .photo-grid:has(.photo-item.selected) .photo-item:not(.selected) {
  opacity: 0.7;
  filter: grayscale(0.2);
} */

.photo-item img {
  width: 100%;
  height: 200px;
  object-fit: cover;
  display: block;
}

.photo-info {
  padding: 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.9);
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.photo-item:hover .photo-info, .photo-item.selected .photo-info {
  opacity: 1;
}

.photo-info .name {
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1100;
}

.fullscreen-content {
  position: relative;
  max-width: 95vw;
  max-height: 95vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fullscreen-content img {
  max-width: 100%;
  max-height: 85vh;
  object-fit: contain;
}

.fullscreen-nav {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-top: 1rem;
    color: white;
}

.fullscreen-title {
    font-size: 1.1rem;
}

.close-btn {
  position: absolute;
  top: 0;
  right: -3rem;
}

@media (max-width: 640px) {
  .photo-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .close-btn {
    right: 0;
    top: -3rem;
  }
}
</style>
