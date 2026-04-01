<script setup lang="ts">
import {onMounted, ref, computed, watch, nextTick} from 'vue'
import {useRouter} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import {type Album, createAlbum, listAlbums, getPhotoUrl, updateAlbum, deleteAlbum} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import ServiceStatusBar from "../components/ServiceStatusBar.vue";

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')
const auth = useAuthStore()

const firstAlbumRef = ref<HTMLElement | null>(null)

const sortedAlbums = computed(() => {
  return [...albums.value].sort((a, b) => {
    const dateA = a.newest_photo_at ? new Date(a.newest_photo_at).getTime() : 0
    const dateB = b.newest_photo_at ? new Date(b.newest_photo_at).getTime() : 0

    if (dateA !== dateB) {
      return dateB - dateA // Newest first
    }

    return a.name.localeCompare(b.name)
  })
})

watch(loading, (newLoading) => {
  if (!newLoading && sortedAlbums.value.length > 0) {
    nextTick(() => {
      firstAlbumRef.value?.focus()
    })
  }
})

const showCreateDialog = ref(false)
const newAlbumName = ref('')
const newAlbumDesc = ref('')
const creating = ref(false)
const showRenameDialog = ref(false)
const showDeleteDialog = ref(false)
const renameValue = ref('')
const updatingAlbum = ref(false)
const selectedAlbum = ref<Album | null>(null)

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

function canManageAlbum(album: Album) {
  return auth.user?.id === album.user_id
}

function openRenameDialog(album: Album) {
  selectedAlbum.value = album
  renameValue.value = album.name
  showRenameDialog.value = true
}

function openDeleteDialog(album: Album) {
  selectedAlbum.value = album
  showDeleteDialog.value = true
}

async function handleRenameAlbum() {
  if (!selectedAlbum.value) return
  const newName = renameValue.value.trim()
  if (!newName) return

  updatingAlbum.value = true
  try {
    await updateAlbum(selectedAlbum.value.id, { name: newName })
    showRenameDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Umbenennen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

async function handleDeleteAlbum() {
  if (!selectedAlbum.value) return

  updatingAlbum.value = true
  try {
    await deleteAlbum(selectedAlbum.value.id)
    showDeleteDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="albums-view">

    <!-- Service status warning bar -->
    <ServiceStatusBar />

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
          v-for="(album, index) in sortedAlbums"
          :key="album.id"
          :ref="el => { if (index === 0) firstAlbumRef = (el as HTMLElement) }"
          class="album-card"
          tabindex="0"
          @click="router.push(`/albums/${album.id}`)"
          @keydown.enter="router.push(`/albums/${album.id}`)"
          @keydown.space.prevent="router.push(`/albums/${album.id}`)"
      >
        <div v-if="canManageAlbum(album)" class="album-actions" @click.stop>
          <Button icon="pi pi-pencil" text rounded size="small" v-tooltip="'Umbenennen'" @click="openRenameDialog(album)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Löschen'" @click="openDeleteDialog(album)" />
        </div>
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
          <span class="album-meta">
            {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
            <template v-if="album.oldest_photo_at && album.newest_photo_at">
              • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
            </template>
          </span>
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

    <Dialog v-model:visible="showRenameDialog" header="Album umbenennen" :modal="true">
      <div class="dialog-content">
        <label for="renameAlbumName">Name des Albums</label>
        <InputText id="renameAlbumName" v-model="renameValue" autofocus @keydown.enter="handleRenameAlbum" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showRenameDialog = false" />
        <Button label="Speichern" :disabled="!renameValue.trim()" :loading="updatingAlbum" @click="handleRenameAlbum" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showDeleteDialog" header="Album löschen" :modal="true" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du dieses Album wirklich löschen?</p>
        <p class="muted">Es werden keine Fotos gelöscht. Sie bleiben unter <b>Alle Fotos</b> erhalten.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showDeleteDialog = false" />
        <Button label="Löschen" severity="danger" :loading="updatingAlbum" @click="handleDeleteAlbum" />
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
  margin-inline: -0.25em;
  padding-inline: 0.5em;
  width: 100%;
}

@media (min-width: 800px) {
  .albums-view {
    margin-inline: -0.5em;
    padding-inline: 1em;
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
  gap: 1rem;
}

.album-card {
  position: relative;
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

.album-actions {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--p-surface-card) 82%, transparent);
  backdrop-filter: blur(4px);
}

.album-card:hover,
.album-card:focus-visible {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.album-cover {
  width: 100%;
  height: 200px;
  background: var(--p-surface-100);
  overflow: hidden;
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
