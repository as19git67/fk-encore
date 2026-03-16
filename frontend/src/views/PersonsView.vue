<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import HeicImage from '../components/HeicImage.vue'
import { listPersons, updatePerson, mergePersons, getPhotoUrl, listPhotos, reindexAllPhotos, getPersonDetails, type Person, type Photo, type PersonDetails } from '../api/photos'

const persons = ref<Person[]>([])
const enableLocalFaces = ref(true)
const loading = ref(true)
const error = ref('')

// Detailed view state
const selectedPersonDetail = ref<PersonDetails | null>(null)
const loadingDetails = ref(false)

// Fullscreen state
const isFullscreen = ref(false)
const selectedIndex = ref(-1)

const personPhotos = computed(() => {
    if (!selectedPersonDetail.value) return []
    return selectedPersonDetail.value.faces
        .filter(f => !!f.photo)
        .map(f => f.photo as Photo)
})

const showRenameDialog = ref(false)
const personToRename = ref<Person | null>(null)
const newName = ref('')

const showMergeDialog = ref(false)
const mergeSourceIds = ref<number[]>([])
const mergeTargetId = ref<number | null>(null)

const reindexing = ref(false)
let reindexInterval: any = null

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await listPersons()
    enableLocalFaces.value = res.enableLocalFaces
    // Filter out persons with 0 faces (orphans) to keep the list clean
    // Some backend databases might return faceCount as string, ensure it's a number
    persons.value = res.persons.filter(p => {
        const count = Number(p.faceCount || 0)
        return count > 0
    })
    
    // Refresh detailed view if open
    if (selectedPersonDetail.value) {
        await openPersonDetails(selectedPersonDetail.value)
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

async function openPersonDetails(person: Person) {
    loadingDetails.value = true
    error.value = ''
    try {
        const details = await getPersonDetails(person.id)
        selectedPersonDetail.value = details
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Laden der Details'
    } finally {
        loadingDetails.value = false
    }
}

function closePersonDetails() {
    selectedPersonDetail.value = null
    isFullscreen.value = false
    selectedIndex.value = -1
}

function openRename(person: Person) {
    personToRename.value = person
    newName.value = person.name
    showRenameDialog.value = true
}

async function handleRename() {
    if (!personToRename.value || !newName.value) return
    try {
        await updatePerson(personToRename.value.id, newName.value)
        showRenameDialog.value = false
        if (selectedPersonDetail.value && selectedPersonDetail.value.id === personToRename.value.id) {
            selectedPersonDetail.value.name = newName.value
        }
        await loadData()
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Umbenennen'
    }
}

async function handleReindex() {
    reindexing.value = true
    error.value = ''
    try {
        const res = await reindexAllPhotos()
        
        // If there are no photos to reindex, we are done immediately
        if (!res.count || res.count === 0) {
            reindexing.value = false
            await loadData()
            return
        }

        // Start polling for data updates while reindexing is happening in background
        // Sequential processing can take a while, so poll for up to 2 minutes
        if (reindexInterval) clearInterval(reindexInterval)
        
        let count = 0
        let lastPersonCount = persons.value.length
        let stableCount = 0
        const maxPolls = 60 // 60 × 2s = 120 seconds
        
        reindexInterval = setInterval(async () => {
            await loadData()
            count++
            
            // Check if data has stabilized (same number of persons for 5 consecutive polls)
            // This is a heuristic to stop polling early when background job likely finished
            if (persons.value.length === lastPersonCount && persons.value.length > 0) {
                stableCount++
            } else {
                stableCount = 0
                lastPersonCount = persons.value.length
            }

            // Stop polling after max duration or if data is stable for 10 seconds
            if (count > maxPolls || stableCount >= 5) {
                clearInterval(reindexInterval)
                reindexInterval = null
                reindexing.value = false
            }
        }, 2000)
        
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Re-Indexing'
        reindexing.value = false
    }
}

function getCoverUrl(person: Person) {
    if (person.cover_filename) {
        return getPhotoUrl(person.cover_filename)
    }
    return 'https://www.primefaces.org/wp-content/uploads/2020/05/placeholder.png'
}

function getFaceStyle(person: Person | { cover_bbox?: any }) {
    if (!person.cover_bbox) return {}
    
    // cover_bbox values are relative (0..1)
    const { x, y, width, height } = person.cover_bbox
    
    // We want to center the face. 
    // The center of the face in relative coordinates:
    const centerX = x + width / 2
    const centerY = y + height / 2
    
    // Zoom factor: how much of the image width should the face occupy?
    // If face is 0.1 wide, and we want it to be 0.5 of the container, zoom is 5x.
    // Let's aim for the face to be roughly 60% of the container.
    const zoom = Math.max(1, Math.min(4, 0.6 / Math.max(width, height)))
    
    return {
        transform: `scale(${zoom})`,
        transformOrigin: `${centerX * 100}% ${centerY * 100}%`,
        objectFit: 'cover',
        display: 'block'
    }
}

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

function handleKeydown(e: KeyboardEvent) {
  if (!isFullscreen.value || selectedIndex.value === -1) return

  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < personPhotos.value.length - 1) selectedIndex.value++
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
  } else if (e.key === 'Escape') {
    isFullscreen.value = false
  }
}

onMounted(() => {
  loadData()
  window.addEventListener('keydown', handleKeydown)
})

import { onUnmounted } from 'vue'
onUnmounted(() => {
    if (reindexInterval) clearInterval(reindexInterval)
    window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="p-4">
    <div class="flex justify-between items-center mb-6">
      <div class="flex items-center gap-4">
          <Button v-if="selectedPersonDetail" icon="pi pi-arrow-left" class="p-button-text p-button-rounded" @click="closePersonDetails" />
          <h1 class="text-3xl font-bold">{{ selectedPersonDetail ? selectedPersonDetail.name : 'Personen' }}</h1>
      </div>
      <div class="flex items-center gap-4">
          <div v-if="reindexing" class="flex items-center gap-3 text-primary animate-pulse mr-4">
              <i class="pi pi-spin pi-spinner"></i>
              <span class="text-sm font-medium">Scannen läuft...</span>
          </div>
          <div class="flex gap-4">
              <Button v-if="selectedPersonDetail" icon="pi pi-pencil" label="Umbenennen" class="p-button-outlined" @click="openRename(selectedPersonDetail)" />
              <Button icon="pi pi-images" label="Alle neu scannen" class="p-button-outlined" @click="handleReindex" :disabled="reindexing || !enableLocalFaces" :tooltip="!enableLocalFaces ? 'Lokale Gesichtserkennung ist deaktiviert' : ''" />
              <Button icon="pi pi-refresh" label="Aktualisieren" @click="loadData" :loading="loading" :disabled="reindexing" />
          </div>
      </div>
    </div>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

    <!-- Person List View -->
    <div v-if="!selectedPersonDetail">
        <div v-if="loading && persons.length === 0" class="text-center p-8">
          <i class="pi pi-spin pi-spinner text-4xl mb-2"></i>
          <p>Personen werden geladen...</p>
        </div>

        <div v-else-if="persons.length === 0" class="text-center p-8 bg-gray-50 rounded-xl border-2 border-dashed">
          <i class="pi pi-users text-5xl text-gray-400 mb-4"></i>
          <p class="text-xl text-gray-500">Keine Personen erkannt.</p>
          <p class="text-gray-400">Lade Fotos hoch, um die automatische Erkennung zu starten.</p>
        </div>

        <div v-else class="persons-grid">
          <div 
            v-for="person in persons" 
            :key="person.id"
            class="person-item"
            @click="openPersonDetails(person)"
          >
            <div class="person-cover">
              <HeicImage 
                :src="getCoverUrl(person)" 
                :alt="person.name"
                class="person-img"
                :imageStyle="getFaceStyle(person)"
              />
              <div class="person-overlay">
                 <Button 
                    icon="pi pi-pencil" 
                    class="p-button-rounded p-button-white" 
                    @click.stop="openRename(person)"
                 />
              </div>
              <div class="person-badge">
                {{ person.faceCount }} {{ person.faceCount === 1 ? 'Foto' : 'Fotos' }}
              </div>
            </div>
            <div class="person-info">
              <h3 class="person-name truncate">{{ person.name }}</h3>
              <p class="person-date mt-1">Aktualisiert {{ new Date(person.updated_at).toLocaleDateString() }}</p>
            </div>
          </div>
        </div>
    </div>

    <!-- Person Details View (Photo Grid) -->
    <div v-else>
        <div v-if="loadingDetails" class="text-center p-8">
            <i class="pi pi-spin pi-spinner text-4xl mb-2"></i>
            <p>Fotos werden geladen...</p>
        </div>
        <div v-else class="photo-grid">
            <div 
                v-for="(photo, idx) in personPhotos" 
                :key="photo.id" 
                class="photo-item"
                @click="selectedIndex = idx; isFullscreen = true"
            >
                <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" />
                <div class="photo-overlay">
                    <div class="photo-name">{{ photo.original_name }}</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Fullscreen Overlay -->
    <div v-if="isFullscreen && selectedIndex !== -1" class="fullscreen-overlay" @click="isFullscreen = false">
      <div style="display: none">
        <HeicImage v-if="selectedIndex > 0" :src="getPhotoUrl(personPhotos[selectedIndex - 1].filename)" />
        <HeicImage v-if="selectedIndex < personPhotos.length - 1" :src="getPhotoUrl(personPhotos[selectedIndex + 1].filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(personPhotos[selectedIndex].filename)" :alt="personPhotos[selectedIndex].original_name" objectFit="contain" />
        <div class="fullscreen-nav">
            <Button icon="pi pi-chevron-left" rounded text @click="selectedIndex > 0 && selectedIndex--" :disabled="selectedIndex === 0" />
            <div class="fullscreen-info">
              <div class="fullscreen-title">{{ personPhotos[selectedIndex].original_name }}</div>
              <div class="fullscreen-date">{{ formatPhotoDate(personPhotos[selectedIndex]) }}</div>
            </div>
            <Button icon="pi pi-chevron-right" rounded text @click="selectedIndex < personPhotos.length - 1 && selectedIndex++" :disabled="selectedIndex === personPhotos.length - 1" />
        </div>
        <Button icon="pi pi-times" class="close-btn" rounded severity="secondary" @click="isFullscreen = false" />
      </div>
    </div>

    <Dialog v-model:visible="showRenameDialog" header="Person umbenennen" :modal="true" class="w-full max-w-md">
        <div class="flex flex-col gap-4 mt-2">
            <label for="name">Name</label>
            <InputText id="name" v-model="newName" autofocus @keyup.enter="handleRename" />
            <div class="flex justify-end gap-2 mt-4">
                <Button label="Abbrechen" icon="pi pi-times" class="p-button-text" @click="showRenameDialog = false" />
                <Button label="Speichern" icon="pi pi-check" @click="handleRename" :disabled="!newName" />
            </div>
        </div>
    </Dialog>
  </div>
</template>

<style scoped>
.persons-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.5rem;
  padding: 0.5rem;
}

.person-item {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  background: white;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  border: 1px solid #e5e7eb;
}

.person-item:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

.person-cover {
  position: relative;
  height: 200px;
  width: 100%;
  overflow: hidden;
  background-color: #f3f4f6;
  flex-shrink: 0;
}

.person-img :deep(img) {
  width: 100%;
  height: 100%;
  transition: transform 0.5s;
}

.person-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.2s;
}

.person-item:hover .person-overlay {
  background: rgba(0, 0, 0, 0.2);
  opacity: 1;
}

.person-badge {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 0.25rem 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  backdrop-filter: blur(4px);
}

.person-info {
  padding: 0.75rem;
}

.person-name {
  font-weight: 600;
  color: #111827;
}

.person-date {
  font-size: 0.75rem;
  color: #6b7280;
}

.p-button-white {
    background: white;
    color: #333;
    border: none;
}
.p-button-white:hover {
    background: #f0f0f0;
}

/* Photo Grid (for Details) */
.photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
}

.photo-item {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
}

.photo-item :deep(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s;
}

.photo-item:hover :deep(img) {
    transform: scale(1.05);
}

.photo-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(transparent, rgba(0,0,0,0.7));
    padding: 1.5rem 0.5rem 0.5rem;
    color: white;
    opacity: 0;
    transition: opacity 0.2s;
}

.photo-item:hover .photo-overlay {
    opacity: 1;
}

.photo-name {
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Fullscreen Viewer */
.fullscreen-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.95);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.fullscreen-content {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.fullscreen-content :deep(img) {
  flex: 1;
  max-width: 100%;
  max-height: calc(100vh - 80px);
  object-fit: contain;
}

.fullscreen-nav {
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2rem;
  background: rgba(0,0,0,0.5);
  color: white;
}

.fullscreen-info {
  text-align: center;
}

.fullscreen-title {
  font-weight: bold;
}

.fullscreen-date {
  font-size: 0.8rem;
  opacity: 0.8;
}

.close-btn {
  position: absolute;
  top: 1rem;
  right: 1rem;
  background: rgba(255,255,255,0.1);
  border: none;
  color: white;
}

/* Utility-Fallbacks (Tailwind nicht aktiv in diesem Projekt) */
.flex { display: flex; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.mb-6 { margin-bottom: 1.5rem; }
.gap-4 { column-gap: 1rem; row-gap: 1rem; }
.gap-3 { column-gap: 0.75rem; row-gap: 0.75rem; }
.mr-4 { margin-right: 1rem; }

</style>
