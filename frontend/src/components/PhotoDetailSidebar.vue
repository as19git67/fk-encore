<script setup lang="ts">
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import MultiSelect from 'primevue/multiselect'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, listAlbums, getPhotosAlbums, batchUpdateAlbumPhotos, type Album } from '../api/photos'
import type { Photo, Face, LandmarkItem, Person, CurationStatus } from '../api/photos'
import { ref, onMounted, watch, computed } from 'vue'

const props = defineProps<{
  photo: Photo
  selectedPhotos?: Photo[]
  faces: Face[]
  loadingFaces: boolean
  landmarks: LandmarkItem[]
  loadingLandmarks: boolean
  persons: Person[]
  canDelete: boolean
  canUpload: boolean
  reindexingPhoto: boolean
  isEditingDate: boolean
  updatingDate: boolean
  showPersons?: boolean
}>()

const editDate = defineModel<Date | null>('editDate', { default: null })

const albums = ref<Album[]>([])
const loadingAlbums = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({}) // photoId -> albumIds[]
const pendingAlbumChanges = ref<Record<number, 'add' | 'remove'>>({})
const savingAlbums = ref(false)

async function loadAlbums() {
  loadingAlbums.value = true
  try {
    const res = await listAlbums()
    albums.value = res.albums.sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    loadingAlbums.value = false
  }
}

async function loadPhotosAlbums() {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
  try {
    const res = await getPhotosAlbums(photoIds)
    const map: Record<number, number[]> = {}
    res.results.forEach(r => {
      map[r.photoId] = r.albumIds
    })
    photoAlbumMap.value = map
  } catch (err) {
    console.error('Failed to load photos albums:', err)
  }
}

// Reset selected album when photo changes
watch(() => props.photo.id, () => {
  pendingAlbumChanges.value = {}
  loadPhotosAlbums()
}, { immediate: true })

watch(() => props.selectedPhotos, () => {
  pendingAlbumChanges.value = {}
  if (props.selectedPhotos && props.selectedPhotos.length > 0) {
    loadPhotosAlbums()
  }
})


function getAlbumCheckState(albumId: number) {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
  if (photoIds.length === 0) return false
  
  let count = 0
  photoIds.forEach(pid => {
    if (photoAlbumMap.value[pid]?.includes(albumId)) {
      count++
    }
  })
  
  if (count === 0) return false
  if (count === photoIds.length) return true
  return null // indeterminate
}

function getEffectiveAlbumCheckState(albumId: number) {
  if (pendingAlbumChanges.value[albumId]) {
    return pendingAlbumChanges.value[albumId] === 'add' ? true : false
  }
  return getAlbumCheckState(albumId)
}

const selectedAlbumIds = computed({
  get: () => {
    if (albums.value.length === 0) return []
    
    // Wir nehmen nur die Alben, die für ALLE Bilder ausgewählt sind (effektiv)
    return albums.value
      .filter(album => getEffectiveAlbumCheckState(album.id) === true)
      .map(a => a.id)
  },
  set: (newVal: number[]) => {
    albums.value.forEach(album => {
      const isSelected = newVal.includes(album.id)
      const currentState = getEffectiveAlbumCheckState(album.id)
      
      if (isSelected && currentState !== true) {
        pendingAlbumChanges.value[album.id] = 'add'
      } else if (!isSelected && currentState !== false) {
        pendingAlbumChanges.value[album.id] = 'remove'
      }
      
      // Wenn die Änderung dem Originalzustand entspricht, können wir sie aus pending entfernen
      const originalState = getAlbumCheckState(album.id)
      if (pendingAlbumChanges.value[album.id] === 'add' && originalState === true) {
        delete pendingAlbumChanges.value[album.id]
      } else if (pendingAlbumChanges.value[album.id] === 'remove' && originalState === false) {
        delete pendingAlbumChanges.value[album.id]
      }
    })
  }
})

async function saveAlbumChanges() {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
  if (photoIds.length === 0) return
  savingAlbums.value = true
  
  const adds = Object.entries(pendingAlbumChanges.value)
    .filter(([_, action]) => action === 'add')
    .map(([id]) => parseInt(id))
    
  const removes = Object.entries(pendingAlbumChanges.value)
    .filter(([_, action]) => action === 'remove')
    .map(([id]) => parseInt(id))
    
  try {
    if (adds.length > 0) await batchUpdateAlbumPhotos(adds, photoIds, 'add')
    if (removes.length > 0) await batchUpdateAlbumPhotos(removes, photoIds, 'remove')
    
    pendingAlbumChanges.value = {}
    await loadPhotosAlbums()
  } catch (err) {
    console.error('Failed to save album changes:', err)
  } finally {
    savingAlbums.value = false
  }
}

onMounted(loadAlbums)

const emit = defineEmits<{
  fullscreen: []
  'ignore-face': [faceId: number]
  reindex: []
  'start-edit-date': []
  'update-date': []
  'cancel-edit-date': []
  'toggle-favorite': [id: number, status: CurationStatus]
  hide: [id: number]
  restore: [id: number]
}>()

function formatPhotoDate(photo: Photo) {
  const dateStr = photo.taken_at || photo.created_at
  if (!dateStr) return ''
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(dateStr))
}

function getPersonName(personId?: number) {
  if (!personId) return 'Unbekannt'
  const person = props.persons.find(p => p.id === personId)
  return person ? person.name : 'Unbekannt'
}
</script>

<template>
  <aside class="details-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Details</span>
    </div>
    <div v-if="selectedPhotos && selectedPhotos.length > 1" class="sidebar-scroll">
      <div class="sidebar-section">
        <div class="section-label">
          <i class="pi pi-images" />
          <span>{{ selectedPhotos.length }} Fotos ausgewählt</span>
        </div>
        
        <div class="album-list-container">
          <div class="section-label" style="margin-top: 1rem">
            <i class="pi pi-book" />
            <span>Alben</span>
          </div>
          <MultiSelect 
            v-model="selectedAlbumIds" 
            :options="albums" 
            optionLabel="name" 
            optionValue="id" 
            placeholder="Alben auswählen"
            :filter="true"
            display="chip"
            class="w-full"
            :loading="loadingAlbums"
          />
        </div>

        <div class="sidebar-divider" style="margin: 1.5rem 0" />
        
        <div class="multi-actions">
          <Button 
            label="Speichern" 
            icon="pi pi-save" 
            class="w-full" 
            :disabled="Object.keys(pendingAlbumChanges).length === 0"
            :loading="savingAlbums"
            @click="saveAlbumChanges" 
          />
        </div>
      </div>
    </div>
    <div v-else class="sidebar-scroll">
      <div class="preview-container" @click="emit('fullscreen')" title="Vollbild">
        <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" />
        <div class="preview-overlay"><i class="pi pi-expand"></i></div>
      </div>

      <div class="quick-actions">
        <Button icon="pi pi-expand" v-tooltip.bottom="'Vollbild'" @click="emit('fullscreen')" severity="secondary" text rounded />
        <Button v-if="canDelete && photo.curation_status === 'hidden'" icon="pi pi-eye" v-tooltip.bottom="'Wiederherstellen'" @click="emit('restore', photo.id)" severity="info" text rounded />
        <template v-if="canDelete && photo.curation_status !== 'hidden'">
          <Button :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" v-tooltip.bottom="photo.curation_status === 'favorite' ? 'Kein Favorit' : 'Favorit'" @click="emit('toggle-favorite', photo.id, photo.curation_status)" :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'" text rounded />
          <Button icon="pi pi-eye-slash" v-tooltip.bottom="'Ausblenden'" @click="emit('hide', photo.id)" severity="danger" text rounded />
        </template>
      </div>

      <div class="sidebar-divider" />

      <div class="meta-list">
        <div class="meta-row">
          <i class="pi pi-file meta-icon" />
          <span class="meta-value" :title="photo.original_name">{{ photo.original_name }}</span>
        </div>
        <div class="meta-row">
          <i class="pi pi-calendar meta-icon" />
          <span class="meta-value date-value">
            {{ formatPhotoDate(photo) }}
            <Button v-if="canUpload && !isEditingDate" icon="pi pi-pencil" text rounded size="small" @click="emit('start-edit-date')" class="edit-btn" />
          </span>
        </div>
        <div v-if="isEditingDate" class="date-editor">
          <DatePicker v-model="editDate" showTime hourFormat="24" fluid />
          <div class="edit-actions">
            <Button icon="pi pi-check" severity="success" text rounded @click="emit('update-date')" :loading="updatingDate" />
            <Button icon="pi pi-times" severity="danger" text rounded @click="emit('cancel-edit-date')" :disabled="updatingDate" />
          </div>
        </div>
        <div v-if="photo.size" class="meta-row">
          <i class="pi pi-database meta-icon" />
          <span class="meta-value">{{ (photo.size / 1024 / 1024).toFixed(2) }} MB</span>
        </div>
      </div>

      <div class="sidebar-divider" />
      <div class="sidebar-section">
        <div class="section-label"><i class="pi pi-book" /> Alben</div>
        <MultiSelect 
          v-model="selectedAlbumIds" 
          :options="albums" 
          optionLabel="name" 
          optionValue="id" 
          placeholder="Alben auswählen"
          :filter="true"
          display="chip"
          class="w-full"
          :loading="loadingAlbums"
        />
        <div class="multi-actions" style="margin-top: 0.75rem">
          <Button 
            label="Speichern" 
            icon="pi pi-save" 
            class="w-full" 
            size="small"
            :disabled="Object.keys(pendingAlbumChanges).length === 0"
            :loading="savingAlbums"
            @click="saveAlbumChanges" 
          />
        </div>
      </div>

      <template v-if="photo.location_city || photo.location_name || loadingLandmarks || landmarks.length > 0">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-map-marker" /> Ort</div>
          <div v-if="photo.location_name || photo.location_city" class="location-pill">
            <template v-if="photo.location_name && photo.location_country">{{ photo.location_name }}, {{ photo.location_country }}</template>
            <template v-else-if="photo.location_name">{{ photo.location_name }}</template>
            <template v-else-if="photo.location_city && photo.location_country">{{ photo.location_city }}, {{ photo.location_country }}</template>
            <template v-else>{{ photo.location_city }}</template>
          </div>
          <div v-if="loadingLandmarks" class="loading-row"><i class="pi pi-spin pi-spinner" /> Gebäude werden erkannt…</div>
          <div v-else-if="landmarks.length > 0" class="landmark-chips">
            <span v-for="lm in landmarks" :key="lm.id" class="landmark-tag" :title="`${Math.round(lm.confidence * 100)}%`">
              <i class="pi pi-building" /> {{ lm.label }} <span class="landmark-confidence">{{ Math.round(lm.confidence * 100) }}%</span>
            </span>
          </div>
        </div>
      </template>

      <template v-if="showPersons !== false">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-users" /> Personen</div>
          <div v-if="loadingFaces" class="loading-row"><i class="pi pi-spin pi-spinner" /> Lade…</div>
          <div v-else-if="faces.filter(f => !f.ignored).length === 0" class="empty-hint">Keine Personen erkannt</div>
          <div v-else class="person-list">
            <div v-for="face in faces.filter(f => !f.ignored)" :key="face.id" class="person-row">
              <i class="pi pi-user person-icon" />
              <span class="person-name">{{ getPersonName(face.person_id) }}</span>
              <Button icon="pi pi-times" severity="secondary" text rounded size="small" @click="emit('ignore-face', face.id)" v-tooltip="'Entfernen'" />
            </div>
          </div>
          <Button label="Neu erkennen" icon="pi pi-refresh" @click="emit('reindex')" :loading="reindexingPhoto" class="reindex-btn" severity="secondary" outlined size="small" />
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.details-sidebar {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border-left: 1px solid var(--surface-border);
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--surface-border);
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-color-secondary);
}

.sidebar-scroll {
  flex: 1;
  overflow-y: auto;
}

.preview-container {
  position: relative;
  cursor: pointer;
  background: var(--surface-ground);
}

.preview-container :deep(.heic-image-container) {
  height: 200px;
  width: 100%;
}

.preview-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s;
  color: white;
  font-size: 1.5rem;
}
.preview-container:hover .preview-overlay { opacity: 1; }

.quick-actions {
  display: flex;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.5rem 1rem;
}

.sidebar-divider { height: 1px; background: var(--surface-border); }

.sidebar-section { padding: 0.75rem 1rem; }

.section-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-color-secondary);
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.section-label .pi { font-size: 0.75rem; }

.meta-list {
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.meta-row {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-size: 0.875rem;
}

.meta-icon {
  font-size: 0.8rem;
  color: var(--text-color-secondary);
  margin-top: 0.15rem;
  flex-shrink: 0;
}

.meta-value {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  line-height: 1.4;
}

.date-value {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.edit-btn { flex-shrink: 0; opacity: 0.6; }
.edit-btn:hover { opacity: 1; }

.date-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0.5rem 0;
  padding: 0.75rem;
  background: var(--surface-ground);
  border-radius: 6px;
}

.edit-actions { display: flex; gap: 0.5rem; }

.location-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--surface-100);
  border: 1px solid var(--surface-300);
  border-radius: 1rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.82rem;
  margin-bottom: 0.5rem;
}

.landmark-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }

.landmark-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--surface-100);
  border: 1px solid var(--surface-300);
  border-radius: 1rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  cursor: default;
}
.landmark-tag .pi-building { font-size: 0.7rem; color: var(--text-color-secondary); }
.landmark-confidence { font-size: 0.7rem; color: var(--text-color-secondary); }

.loading-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--text-color-secondary);
}

.empty-hint {
  font-size: 0.82rem;
  color: var(--text-color-secondary);
  font-style: italic;
}

.person-list { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.25rem; }
.person-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding-inline: 0.4rem;
  background: var(--surface-ground);
  border-radius: 6px;
  border: 1px solid var(--surface-border);
}
.person-icon { font-size: 0.8rem; color: var(--text-color-secondary); }
.person-name { flex: 1; font-size: 0.875rem; }

.reindex-btn { width: 100%; margin-top: 0.5rem; }

.multi-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
