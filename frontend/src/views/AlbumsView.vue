<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {useRouter} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import {type Album, createAlbum, listAlbums, getPhotoUrl} from '../api/photos'

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')

const showCreateDialog = ref(false)
const newAlbumName = ref('')
const newAlbumDesc = ref('')
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
    const album = await createAlbum(newAlbumName.value.trim(), newAlbumDesc.value.trim() || undefined)
    showCreateDialog.value = false
    newAlbumName.value = ''
    newAlbumDesc.value = ''
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
        <h1 class="title">Meine Alben</h1>
        <Button label="Neues Album" icon="pi pi-plus" @click="showCreateDialog = true"/>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner"/> Alben werden geladen…
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
        <div class="album-cover">
          <HeicImage
            v-if="album.cover_filename"
            :src="getPhotoUrl(album.cover_filename, 400)"
            :alt="album.name"
            objectFit="cover"
          />
          <div v-else class="album-icon"><i class="pi pi-images"/></div>
        </div>
        <div class="album-info">
          <span class="album-name">{{ album.name }}</span>
          <span v-if="album.description" class="album-desc">{{ album.description }}</span>
          <span class="album-meta">Erstellt am {{ new Date(album.created_at).toLocaleDateString() }}</span>
        </div>
      </div>
    </div>

    <Dialog v-model:visible="showCreateDialog" header="Neues Album erstellen" :modal="true">
      <div class="dialog-content">
        <label for="albumName">Name des Albums</label>
        <InputText id="albumName" v-model="newAlbumName" autofocus @keydown.enter="handleCreateAlbum"/>
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label for="albumDesc">Beschreibung</label>
        <textarea id="albumDesc" v-model="newAlbumDesc" rows="2" class="p-inputtextarea p-inputtext" style="width: 100%"></textarea>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showCreateDialog = false"/>
        <Button label="Erstellen" :loading="creating" @click="handleCreateAlbum"/>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5em;
}

.albums-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

@media (min-width: 800px) {
  .albums-view {
    margin-inline: 0.5em;
  }
}

.albums-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem;
  margin-bottom: 1rem;
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
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.album-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.album-cover {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--p-surface-100);
}
.album-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}
.album-icon {
  font-size: 3rem;
  color: var(--p-primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.album-info {
  padding: 0.75rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.album-name {
  font-weight: 600;
  display: block;
}
.album-desc {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
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
