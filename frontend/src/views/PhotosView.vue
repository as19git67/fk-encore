<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import Button from 'primevue/button'
import FileUpload from 'primevue/fileupload'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import DatePicker from 'primevue/datepicker'
import HeicImage from '../components/HeicImage.vue'
import { listPhotos, uploadPhoto, deletePhoto, getPhotoUrl, getPhotosToRefreshMetadata, refreshPhotoMetadata, updatePhotoDate, type Photo } from '../api/photos'
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

const formatPhotoDate = (photo: Photo) => {
  const dateStr = photo.taken_at || photo.created_at;
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

const refreshingMetadata = ref(false)
const isDragging = ref(false)
const dragCounter = ref(0)
const isEditingDate = ref(false)
const editDate = ref<Date | null>(null)
const updatingDate = ref(false)
const refreshProgress = ref(0)
const refreshTotal = ref(0)
const refreshCurrent = ref(0)
const activeSection = ref('')

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
    photos.value = res.photos.sort((a, b) => {
      const dateA = new Date(a.taken_at || a.created_at).getTime();
      const dateB = new Date(b.taken_at || b.created_at).getTime();
      return dateB - dateA;
    });
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Fotos'
  } finally {
    loading.value = false
  }
}

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

async function handleUpload(event: any) {
  let files: any[] = []
  if (event.files) {
    files = event.files
  } else if (event instanceof FileList) {
    files = Array.from(event)
  } else if (event.dataTransfer) {
    files = Array.from(event.dataTransfer.files)
  }

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

function startEditingDate() {
  const photo = photos.value[selectedIndex.value]
  if (!photo) return
  editDate.value = new Date(photo.taken_at || photo.created_at)
  isEditingDate.value = true
}

async function handleUpdateDate() {
  if (!editDate.value || selectedIndex.value === -1) return
  
  const photo = photos.value[selectedIndex.value]
  updatingDate.value = true
  try {
    // Convert to ISO string for backend
    const takenAt = editDate.value.toISOString()
    await updatePhotoDate(photo.id, takenAt)
    
    // Update local photo object
    photo.taken_at = takenAt
    isEditingDate.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Aktualisieren des Datums'
  } finally {
    updatingDate.value = false
  }
}

function handleDragEnter(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  dragCounter.value++
  isDragging.value = true
}

function handleDragLeave(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  dragCounter.value--
  if (dragCounter.value === 0) {
    isDragging.value = false
  }
}

function handleDragOver(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

async function handleDrop(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  isDragging.value = false
  dragCounter.value = 0
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    await handleUpload(files)
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (isEditingDate.value) return

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
  isEditingDate.value = false
  if (newIdx === -1 || isFullscreen.value) return
  nextTick(() => {
    const el = document.querySelector('.photo-item.selected')
    if (el) {
      el.scrollIntoView({ behavior: 'auto', block: 'nearest' })
    }
  })
})

watch(isFullscreen, (val) => {
  if (!val) isEditingDate.value = false
})

onMounted(() => {
  loadPhotos()
  window.addEventListener('keydown', handleKeydown)
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        activeSection.value = entry.target.id
      }
    })
  }, { threshold: 0.5, rootMargin: '-50px 0px -50% 0px' })
  
  // Observe headers when they are available
  watch(groupedPhotos, (newGroups) => {
    if (newGroups.length > 0) {
      nextTick(() => {
        document.querySelectorAll('.grid-header').forEach(header => {
          observer.observe(header)
        })
      })
    }
  }, { immediate: true })
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div 
    class="photos-view" 
    @dragenter="handleDragEnter" 
    @dragover="handleDragOver" 
    @dragleave="handleDragLeave" 
    @drop="handleDrop"
  >
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-message">
        <i class="pi pi-upload"></i>
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>
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

    <div v-else class="gallery-container">
      <div class="photo-grid">
        <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
          <h2 :id="'year-' + yearGroup.year" class="grid-header year-title">{{ yearGroup.year }}</h2>
          <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
            <h3 :id="'month-' + yearGroup.year + '-' + monthGroup.month" class="grid-header month-title">{{ monthGroup.month }}</h3>
            <div 
              v-for="item in monthGroup.photos" 
              :key="item.photo.id" 
              class="photo-item"
              :class="{ selected: item.index === selectedIndex }"
              @click="selectedIndex = item.index"
              @dblclick="isFullscreen = true"
            >
              <HeicImage :src="getPhotoUrl(item.photo.filename)" :alt="item.photo.original_name" loading="lazy" />
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

      <nav class="timeline-nav">
        <div v-for="yearGroup in groupedPhotos" :key="'nav-' + yearGroup.year" class="nav-year-group">
          <a 
            @click.prevent="scrollToSection('year-' + yearGroup.year)" 
            class="nav-year"
            :class="{ active: activeSection === 'year-' + yearGroup.year }"
          >
            {{ yearGroup.year }}
          </a>
          <div class="nav-months">
            <a 
              v-for="monthGroup in yearGroup.months" 
              :key="'nav-' + yearGroup.year + monthGroup.month"
              @click.prevent="scrollToSection('month-' + yearGroup.year + '-' + monthGroup.month)"
              class="nav-month"
              :class="{ active: activeSection === 'month-' + yearGroup.year + '-' + monthGroup.month }"
            >
              {{ monthGroup.month.substring(0, 3) }}
            </a>
          </div>
        </div>
      </nav>

      <div class="details-sidebar" v-if="selectedIndex !== -1">
        <div class="sidebar-header">
          <h3>Details</h3>
          <Button icon="pi pi-times" text rounded size="small" @click="selectedIndex = -1" />
        </div>
        
        <div class="sidebar-content">
          <div class="preview-container" @click="isFullscreen = true" title="Klicken für Vollbild">
            <HeicImage :src="getPhotoUrl(photos[selectedIndex].filename)" :alt="photos[selectedIndex].original_name" />
            <div class="preview-overlay">
              <i class="pi pi-expand"></i>
            </div>
          </div>
          
          <div class="info-group">
            <label>Dateiname</label>
            <div class="value">{{ photos[selectedIndex].original_name }}</div>
          </div>
          
          <div class="info-group">
            <label>Aufnahmedatum</label>
            <div v-if="!isEditingDate" class="date-display">
              <div class="value">{{ formatPhotoDate(photos[selectedIndex]) }}</div>
              <Button 
                v-if="canUpload"
                icon="pi pi-pencil" 
                text 
                rounded 
                size="small" 
                @click="startEditingDate" 
                class="edit-btn" 
              />
            </div>
            <div v-else class="date-editor">
              <DatePicker v-model="editDate" showTime hourFormat="24" fluid />
              <div class="edit-actions">
                <Button icon="pi pi-check" severity="success" text rounded @click="handleUpdateDate" :loading="updatingDate" />
                <Button icon="pi pi-times" severity="danger" text rounded @click="isEditingDate = false" :disabled="updatingDate" />
              </div>
            </div>
          </div>

          <div class="info-group" v-if="photos[selectedIndex].size">
            <label>Größe</label>
            <div class="value">{{ (photos[selectedIndex].size / 1024 / 1024).toFixed(2) }} MB</div>
          </div>

          <div class="sidebar-actions">
            <Button 
              label="Vollbild" 
              icon="pi pi-expand" 
              @click="isFullscreen = true" 
              class="w-full" 
              severity="secondary"
            />
            
            <Button 
              v-if="canDelete"
              label="Foto löschen" 
              icon="pi pi-trash" 
              @click="handleDelete(photos[selectedIndex].id)" 
              class="w-full" 
              severity="danger" 
              text
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="isFullscreen && selectedIndex !== -1" class="fullscreen-overlay" @click="isFullscreen = false">
      <!-- Preload next and previous image -->
      <div style="display: none">
        <HeicImage v-if="selectedIndex > 0" :src="getPhotoUrl(photos[selectedIndex - 1].filename)" />
        <HeicImage v-if="selectedIndex < photos.length - 1" :src="getPhotoUrl(photos[selectedIndex + 1].filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(photos[selectedIndex].filename)" :alt="photos[selectedIndex].original_name" objectFit="contain" />
        <div class="fullscreen-nav">
            <Button icon="pi pi-chevron-left" rounded text @click="selectedIndex > 0 && selectedIndex--" :disabled="selectedIndex === 0" />
            <div class="fullscreen-info">
              <div class="fullscreen-title">{{ photos[selectedIndex].original_name }}</div>
              <div class="fullscreen-date">
                {{ formatPhotoDate(photos[selectedIndex]) }}
              </div>
            </div>
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
  flex: 1;
}

.gallery-container {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
  position: relative;
}

.timeline-nav {
  position: sticky;
  top: 1rem;
  width: 80px;
  background: var(--surface-card);
  padding: 1rem 0.5rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  z-index: 100;
  flex-shrink: 0;
}

.details-sidebar {
  position: sticky;
  top: 1rem;
  width: 300px;
  background: var(--surface-card);
  padding: 1.5rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  z-index: 90;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 0.5rem;
  margin-bottom: 0.5rem;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 1.2rem;
}

.preview-container {
  position: relative;
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 1rem;
}

.preview-container :deep(.heic-image-container) {
  height: 180px;
  width: 100%;
}

.preview-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s;
  color: white;
  font-size: 1.5rem;
}

.preview-container:hover .preview-overlay {
  opacity: 1;
}

.info-group {
  margin-bottom: 1.25rem;
}

.info-group label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-color-secondary);
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.info-group .value {
  font-size: 0.95rem;
  word-break: break-all;
  color: var(--text-color);
}

.date-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.date-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--surface-ground);
  border-radius: 6px;
}

.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 1rem;
}

.w-full {
  width: 100%;
}

.nav-year-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.nav-year {
  font-weight: bold;
  font-size: 0.9rem;
  color: var(--p-primary-color);
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.2s;
}

.nav-year:hover {
  background: var(--p-primary-50);
}

.nav-months {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  align-items: center;
}

.nav-month {
  font-size: 0.75rem;
  color: var(--text-color-secondary);
  cursor: pointer;
  text-decoration: none;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  transition: color 0.2s;
}

.nav-year.active {
  background: var(--p-primary-color);
  color: white;
}

.nav-month.active {
  color: var(--p-primary-color);
  font-weight: bold;
  background: var(--p-primary-50);
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

.photo-item.selected :deep(img) {
  filter: brightness(1.1);
}

/* .photo-grid:has(.photo-item.selected) .photo-item:not(.selected) {
  opacity: 0.7;
  filter: grayscale(0.2);
} */

.photo-item :deep(.heic-image-container) {
  width: 100%;
  height: 200px;
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
  width: 95vh;
  height: 95vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fullscreen-content :deep(.heic-image-container) {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.fullscreen-nav {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-top: 1rem;
    color: white;
}

.fullscreen-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
}

.fullscreen-title {
    font-size: 1.1rem;
    font-weight: 500;
}

.fullscreen-date {
    font-size: 0.9rem;
    opacity: 0.8;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.edit-date-btn {
  color: white !important;
  opacity: 0.6;
}

.edit-date-btn:hover {
  opacity: 1;
}

.date-edit-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: center;
  background: rgba(255, 255, 255, 0.1);
  padding: 0.5rem;
  border-radius: 8px;
}

.edit-actions {
  display: flex;
  gap: 0.5rem;
}

.close-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 10;
}

@media (max-width: 1200px) {
  .details-sidebar {
    width: 250px;
  }
}

@media (max-width: 1024px) {
  .gallery-container {
    flex-direction: column;
  }
  .timeline-nav {
    width: 100%;
    position: static;
    max-height: none;
    flex-direction: row;
    overflow-x: auto;
    padding: 0.5rem;
  }
  .nav-year-group {
    flex-direction: row;
    white-space: nowrap;
  }
  .nav-months {
    flex-direction: row;
  }
  .details-sidebar {
    width: 100%;
    position: static;
    max-height: none;
  }
}

@media (max-width: 640px) {
  .photo-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .close-btn {
    right: 0.5rem;
    top: 0.5rem;
  }
}

.drag-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 119, 255, 0.15);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: center;
  pointer-events: none;
  border: 4px dashed var(--p-primary-color);
  margin: 10px;
  width: calc(100% - 20px);
  height: calc(100% - 20px);
  border-radius: 16px;
}

.drag-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  background: var(--surface-card);
  padding: 2rem 3rem;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.1);
  color: var(--p-primary-color);
  font-size: 1.5rem;
  font-weight: bold;
}

.drag-message i {
  font-size: 3rem;
}
</style>
