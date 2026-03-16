<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import HeicImage from '../components/HeicImage.vue'
import { listPersons, updatePerson, mergePersons, getPhotoUrl, listPhotos, reindexAllPhotos, type Person, type Photo } from '../api/photos'

const persons = ref<Person[]>([])
const photos = ref<Photo[]>([])
const loading = ref(true)
const error = ref('')

const showRenameDialog = ref(false)
const selectedPerson = ref<Person | null>(null)
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
    // Filter out persons with 0 faces (orphans) to keep the list clean
    // Some backend databases might return faceCount as string, ensure it's a number
    persons.value = res.persons.filter(p => {
        const count = Number(p.faceCount || 0)
        return count > 0
    })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

function openRename(person: Person) {
    selectedPerson.value = person
    newName.value = person.name
    showRenameDialog.value = true
}

async function handleRename() {
    if (!selectedPerson.value || !newName.value) return
    try {
        await updatePerson(selectedPerson.value.id, newName.value)
        showRenameDialog.value = false
        await loadData()
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Umbenennen'
    }
}

async function handleReindex() {
    reindexing.value = true
    error.value = ''
    try {
        await reindexAllPhotos()
        
        // Start polling for data updates while reindexing is likely happening in background
        if (reindexInterval) clearInterval(reindexInterval)
        let count = 0
        reindexInterval = setInterval(async () => {
            await loadData()
            count++
            // Stop polling after 30 seconds (15 tries)
            if (count > 15) {
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

function getFaceStyle(person: Person) {
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

onMounted(loadData)

import { onUnmounted } from 'vue'
onUnmounted(() => {
    if (reindexInterval) clearInterval(reindexInterval)
})
</script>

<template>
  <div class="p-4">
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-3xl font-bold">Personen</h1>
      <div class="flex items-center gap-4">
          <div v-if="reindexing" class="flex items-center gap-3 text-primary animate-pulse mr-2">
              <i class="pi pi-spin pi-spinner"></i>
              <span class="text-sm font-medium">Scannen läuft...</span>
          </div>
          <div class="flex gap-2">
              <Button icon="pi pi-images" label="Alle neu scannen" class="p-button-outlined" @click="handleReindex" :disabled="reindexing" />
              <Button icon="pi pi-refresh" label="Aktualisieren" @click="loadData" :loading="loading" :disabled="reindexing" />
          </div>
      </div>
    </div>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

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
</style>
