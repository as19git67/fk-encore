<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { listAlbums, createAlbum, type Album } from '../api/photos'

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')

const showCreateDialog = ref(false)
const newAlbumName = ref('')
const creating = ref(false)

const router = useRouter()

async function loadData() {
  loading.value = true
  try {
    const res = await listAlbums()
    albums.value = res.albums
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Alben'
  } finally {
    loading.value = false
  }
}

async function handleCreateAlbum() {
  if (!newAlbumName.value.trim()) return
  creating.value = true
  try {
    const album = await createAlbum(newAlbumName.value.trim())
    showCreateDialog.value = false
    newAlbumName.value = ''
    await loadData()
    router.push(`/albums/${album.id}`)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des Albums'
  } finally {
    creating.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="albums-view">
    <div class="subheader">
      <div class="header">
        <h1>Meine Alben</h1>
        <Button label="Neues Album" icon="pi pi-plus" @click="showCreateDialog = true" />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Alben werden geladen…
    </div>
    <div v-else-if="albums.length === 0" class="info-text">
      Keine Alben vorhanden. Erstelle dein erstes Album!
    </div>

    <div v-else class="albums-grid">
      <div
        v-for="album in albums"
        :key="album.id"
        class="album-card"
        @click="router.push(`/albums/${album.id}`)"
      >
        <div class="album-icon">
          <i class="pi pi-images" />
        </div>
        <div class="album-info">
          <span class="album-name">{{ album.name }}</span>
          <span class="album-meta">Erstellt am {{ new Date(album.created_at).toLocaleDateString() }}</span>
        </div>
      </div>
    </div>

    <Dialog v-model:visible="showCreateDialog" header="Neues Album erstellen" :modal="true">
      <div class="flex flex-column gap-3">
        <label for="albumName">Name des Albums</label>
        <InputText id="albumName" v-model="newAlbumName" autofocus @keydown.enter="handleCreateAlbum" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showCreateDialog = false" />
        <Button label="Erstellen" :loading="creating" @click="handleCreateAlbum" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.albums-view {
  padding: 1rem;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}
.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.5rem;
}
.album-card {
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1.5rem;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 1rem;
}
.album-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.album-icon {
  font-size: 3rem;
  color: var(--p-primary-color);
}
.album-name {
  font-weight: 600;
  display: block;
}
.album-meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}
</style>
