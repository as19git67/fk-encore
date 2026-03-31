<script lang="ts" setup>
import {computed, nextTick, onMounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import {
  type AlbumWithPhotos,
  deleteAlbum,
  getAlbum,
  getPhotoUrl,
  updateAlbum,
  updateAlbumUserSettings
} from '../api/photos'

const route = useRoute()
const router = useRouter()
const albumId = Number(route.params.id)

const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)

const viewOptions = [
  {label: 'Alle', value: 'all'},
  {label: 'Favoriten', value: 'favorites'}
]

const hideModeOptions = [
  {label: 'Meine ausgeblendeten', value: 'mine'},
  {label: 'Alle ausgeblendeten', value: 'all'}
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

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const canDelete = computed(() => album.value?.role === 'owner')

// Rename & description state
const showRenameDialog = ref(false)
const renameValue = ref('')
const updatingAlbum = ref(false)

const editingDescription = ref(false)
const descDraft = ref('')

function openRename() {
  if (!album.value) return
  renameValue.value = album.value.name
  showRenameDialog.value = true
}

async function saveRename() {
  if (!album.value) return
  const newName = renameValue.value.trim()
  if (!newName) return
  try {
    updatingAlbum.value = true
    await updateAlbum(albumId, {name: newName})
    album.value.name = newName
    showRenameDialog.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Umbenennen'
  } finally {
    updatingAlbum.value = false
  }
}

function startEditDesc() {
  if (!album.value) return
  descDraft.value = album.value.description || ''
  editingDescription.value = true
}

async function saveDescription() {
  if (!album.value) return
  try {
    updatingAlbum.value = true
    await updateAlbum(albumId, {description: descDraft.value})
    album.value.description = descDraft.value
    editingDescription.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Beschreibung'
  } finally {
    updatingAlbum.value = false
  }
}

async function setAsCover() {
  if (!album.value || !selectedPhoto.value) return
  try {
    updatingAlbum.value = true
    await updateAlbum(albumId, {coverPhotoId: selectedPhoto.value.id})
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Setzen des Covers'
  } finally {
    updatingAlbum.value = false
  }
}

const showDeleteDialog = ref(false)

async function doDelete() {
  try {
    updatingAlbum.value = true
    await deleteAlbum(albumId)
    router.push('/albums')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    updatingAlbum.value = false
    showDeleteDialog.value = false
  }
}

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
      {root: gridScrollRef.value, rootMargin: '200px'}
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
          <h1 class="title">{{ album.name }}</h1>
          <span :class="album.role" class="role-badge">{{ album.role }}</span>
        </div>
        <div class="controls">
          <Button v-if="canWrite" icon="pi pi-pencil" label="Umbenennen" size="small" text @click="openRename"/>
          <Button v-if="canWrite && selectedPhoto" :loading="updatingAlbum" icon="pi pi-image" label="Als Cover setzen" size="small"
                  text @click="setAsCover"/>
          <Button v-if="canDelete" icon="pi pi-trash" label="Löschen" severity="danger" size="small" text
                  @click="showDeleteDialog = true"/>
          <div v-if="album.settings" class="control-group">
            <label>Ansicht:</label>
            <SelectButton
                v-model="album.settings.active_view"
                :options="viewOptions"
                optionLabel="label"
                optionValue="value"
                @change="handleSettingsChange"
            />
          </div>
          <div v-if="album.settings" class="control-group">
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
      <i class="pi pi-spin pi-spinner"/> Album wird geladen…
    </div>

    <div v-if="album" class="album-info-block">
      <div class="desc-row">
        <label class="desc-label">Beschreibung</label>
        <div v-if="!editingDescription" class="desc-content">
          <span :class="{ empty: !album.description }" class="desc-text">{{
              album.description || 'Keine Beschreibung'
            }}</span>
          <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc"/>
        </div>
        <div v-else class="desc-edit">
          <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="3" style="width: 100%"></textarea>
          <div class="desc-actions">
            <Button :loading="updatingAlbum" icon="pi pi-check" label="Speichern" size="small"
                    @click="saveDescription"/>
            <Button :disabled="updatingAlbum" icon="pi pi-times" label="Abbrechen" size="small" text
                    @click="editingDescription = false"/>
          </div>
        </div>
      </div>
    </div>

    <div v-if="album" class="album-layout">
      <div ref="gridScrollRef" class="photo-grid-scroll">
        <div v-if="album.photos.length === 0" class="info-text">
          Keine Fotos in dieser Ansicht.
        </div>
        <div v-else class="photo-grid">
          <div
              v-for="(photo, idx) in album.photos"
              :key="photo.id"
              :class="{ selected: idx === selectedIndex }"
              :data-photo-id="photo.id"
              class="photo-item"
              @click="selectedIndex = idx"
          >
            <div class="photo-thumb">
              <HeicImage
                  v-if="visiblePhotoIds.has(photo.id)"
                  :alt="photo.original_name"
                  :src="getPhotoUrl(photo.filename, 400)"
                  objectFit="cover"
              />
              <div v-else class="thumb-placeholder"/>
            </div>
            <div class="photo-meta">
              <span class="photo-name">{{ photo.original_name }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="selectedPhoto" class="sidebar-container">
        <PhotoDetailSidebar
            :can-delete="false"
            :can-upload="false"
            :faces="[]"
            :is-editing-date="false"
            :landmarks="[]"
            :loading-faces="false"
            :loading-landmarks="false"
            :persons="[]"
            :photo="selectedPhoto"
            :reindexing-photo="false"
            :updating-date="false"
            @fullscreen="isFullscreen = true"
        />
      </div>
    </div>
    <Dialog v-model:visible="showRenameDialog" :modal="true" header="Album umbenennen" style="width: min(100%, 26rem)">
      <div class="dialog-body">
        <label class="dialog-label" for="rename-input">Name</label>
        <InputText id="rename-input" v-model="renameValue" autocomplete="off" fluid @keyup.enter="saveRename"/>
        <div class="dialog-actions">
          <Button label="Abbrechen" text @click="showRenameDialog = false"/>
          <Button :disabled="!renameValue.trim()" :loading="updatingAlbum" icon="pi pi-check" label="Speichern"
                  @click="saveRename"/>
        </div>
      </div>
    </Dialog>

    <Dialog v-model:visible="showDeleteDialog" :modal="true" header="Album löschen" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du dieses Album wirklich löschen?</p>
        <p class="muted">Es werden keine Fotos gelöscht. Sie bleiben unter <b>Alle Fotos</b> erhalten.</p>
        <div class="dialog-actions">
          <Button label="Abbrechen" text @click="showDeleteDialog = false"/>
          <Button :loading="updatingAlbum" icon="pi pi-trash" label="Löschen" severity="danger" @click="doDelete"/>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
}

.dialog-body .dialog-actions {
  display: flex;
  justify-content: flex-end;
}

.album-info-block {
  padding: 0 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.desc-row {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 0.5rem 1rem;
  align-items: start;
  padding: 0.75rem 0;
}

.desc-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.desc-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.desc-text.empty {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.desc-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.album-detail-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

@media (min-width: 800px) {
  .album-detail-view {
    margin-inline: 0.5em;
  }
}

.album-detail-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  gap: 0.5em;
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

.role-badge.owner {
  background: #fee2e2;
  color: #991b1b;
}

.role-badge.contributor {
  background: #dcfce7;
  color: #166534;
}

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
  background: rgba(0, 0, 0, 0.5);
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
