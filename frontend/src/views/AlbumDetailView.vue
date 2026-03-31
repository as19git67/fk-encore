<script lang="ts" setup>
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import GalleryLayout from '../components/GalleryLayout.vue'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import {
  type AlbumWithPhotos,
  deletePhoto,
  deleteAlbum,
  getPhotoFaces,
  getAlbum,
  getPhotoLandmarks,
  getPhotoUrl,
  ignoreFace,
  listPersons,
  reindexPhoto,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type Person,
  updatePhotoCuration,
  updateAlbum,
  updateAlbumUserSettings
} from '../api/photos'
import {useAuthStore} from '../stores/auth'

const route = useRoute()
const router = useRouter()
const albumId = Number(route.params.id)
const auth = useAuthStore()

const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)
const activeSection = ref('')

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
    selectedIndex.value = album.value.photos.length > 0 ? 0 : -1
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

async function loadPersons() {
  try {
    const res = await listPersons()
    persons.value = res.persons
  } catch (err) {
    console.error('Failed to load persons:', err)
  }
}

async function loadSidebarData(photoId: number) {
  loadingFaces.value = true
  loadingLandmarks.value = true
  try {
    const [facesRes, landmarksRes] = await Promise.all([
      getPhotoFaces(photoId),
      getPhotoLandmarks(photoId),
    ])
    detectedFaces.value = facesRes.faces
    detectedLandmarks.value = landmarksRes.landmarks
  } catch (err) {
    console.error('Failed to load sidebar data:', err)
  } finally {
    loadingFaces.value = false
    loadingLandmarks.value = false
  }
}

const selectedPhoto = computed(() => {
  if (selectedIndex.value < 0 || !album.value) return null
  return album.value.photos[selectedIndex.value] || null
})

function scrollToPhoto(photoId: number) {
  const el = gridScrollRef.value?.querySelector(`[data-photo-id="${photoId}"]`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    activeSection.value = id
  }
}

watch(selectedPhoto, (photo) => {
  if (photo) {
    loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

watch(selectedIndex, (newIdx) => {
  const photo = album.value?.photos[newIdx]
  if (photo) scrollToPhoto(photo.id)
})

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const canDeleteAlbum = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const showPersons = computed(() => auth.hasPermission('people.view'))

const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])

interface PhotoItem {
  photo: NonNullable<AlbumWithPhotos['photos']>[number]
  index: number
}

interface MonthGroup {
  month: string
  photos: PhotoItem[]
}

interface YearGroup {
  year: string
  months: MonthGroup[]
}

const groupedPhotos = computed<YearGroup[]>(() => {
  const groups: YearGroup[] = []
  if (!album.value) return groups

  for (const [index, photo] of album.value.photos.entries()) {
    const date = new Date(photo.taken_at || photo.created_at)
    const year = date.getFullYear().toString()
    const month = date.toLocaleString('de-DE', { month: 'long' })

    let yearGroup = groups.find(g => g.year === year)
    if (!yearGroup) {
      yearGroup = { year, months: [] }
      groups.push(yearGroup)
    }

    let monthGroup = yearGroup.months.find(m => m.month === month)
    if (!monthGroup) {
      monthGroup = { month, photos: [] }
      yearGroup.months.push(monthGroup)
    }

    monthGroup.photos.push({ photo, index })
  }

  return groups
})

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

function handleCoverPhotoIdUpdate(id: number | null) {
  if (!album.value) return
  album.value.cover_photo_id = id ?? undefined
}

function updatePhotoStatus(id: number, status: CurationStatus) {
  if (!album.value) return
  album.value.photos = album.value.photos.map(photo => (
    photo.id === id ? { ...photo, curation_status: status } : photo
  ))
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try {
    await ignoreFace(faceId)
    detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Ignorieren des Gesichts'
  }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try {
    await reindexPhoto(selectedPhoto.value.id)
    await loadSidebarData(selectedPhoto.value.id)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Neu-Erkennen'
  } finally {
    reindexingPhoto.value = false
  }
}

async function handleHidePhoto(id: number) {
  try {
    await deletePhoto(id)
    updatePhotoStatus(id, 'hidden')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Ausblenden'
  }
}

async function handleRestorePhoto(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    updatePhotoStatus(id, 'visible')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Wiederherstellen'
  }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  updatePhotoStatus(id, newStatus)
  try {
    await updatePhotoCuration(id, newStatus)
  } catch (err: any) {
    updatePhotoStatus(id, currentStatus)
    error.value = err.message || 'Fehler beim Ändern des Favoriten-Status'
  }
}

async function scrollToCover() {
  if (!album.value?.cover_photo_id) return
  const idx = album.value.photos.findIndex(p => p.id === album.value!.cover_photo_id)
  if (idx >= 0) {
    selectedIndex.value = idx
    await nextTick()
    scrollToPhoto(album.value.cover_photo_id)
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

onMounted(() => {
  void loadData()
  if (showPersons.value) void loadPersons()
})

// Reuse observer logic for performance
const visiblePhotoIds = ref(new Set<number>())
const gridScrollRef = ref<HTMLElement | null>(null)
let photoObserver: IntersectionObserver | null = null
let sectionObserver: IntersectionObserver | null = null

function setGridScrollRef(el: HTMLElement | null) {
  gridScrollRef.value = el
}

function setupObservers() {
  photoObserver?.disconnect()
  sectionObserver?.disconnect()
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
      {root: gridScrollRef.value, rootMargin: '300px 0px'}
  )
  const photoEls = gridScrollRef.value.querySelectorAll('[data-photo-id]')
  photoEls.forEach(el => photoObserver!.observe(el))

  const rootRect = gridScrollRef.value.getBoundingClientRect()
  photoEls.forEach(el => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
      const id = Number((el as HTMLElement).dataset.photoId)
      if (id) visiblePhotoIds.value.add(id)
    }
  })

  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeSection.value = (entry.target as HTMLElement).id
        }
      }
    },
    { root: gridScrollRef.value, rootMargin: '-5% 0px -90% 0px' }
  )
  gridScrollRef.value.querySelectorAll('[data-section-header]').forEach(el => sectionObserver!.observe(el))
}

watch(groupedPhotos, async () => {
  await nextTick()
  setupObservers()
})

watch(gridScrollRef, () => {
  nextTick(() => setupObservers())
})

onUnmounted(() => {
  photoObserver?.disconnect()
  sectionObserver?.disconnect()
})
</script>

<template>
  <div class="album-detail-view">
    <div v-if="album" class="subheader">
      <div class="header">
        <div class="header-left">
          <h1 class="title">{{ album.name }}</h1>
          <span :class="['role-badge', `role-badge--${album.role}`]">{{ album.role }}</span>
        </div>
        <div class="controls">
          <Button
            v-if="album.cover_photo_id"
            icon="pi pi-image"
            label="Cover fokussieren"
            size="small"
            text
            @click="scrollToCover"
            title="Zum Cover-Foto springen"
          />
          <Button v-if="canWrite" icon="pi pi-pencil" label="Umbenennen" size="small" text @click="openRename"/>
          <Button v-if="canDeleteAlbum" icon="pi pi-trash" label="Löschen" severity="danger" size="small" text
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
      <div class="album-info-block__description">
        <div v-if="!editingDescription" class="album-info-block__description-content">
          <span :class="{ 'album-info-block__description-text--empty': !album.description }" class="album-info-block__description-text">
            {{ album.description || 'Keine Beschreibung' }}
          </span>
          <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc" class="album-info-block__edit-btn"/>
        </div>
        <div v-else class="album-info-block__edit">
          <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="2"></textarea>
          <div class="album-info-block__edit-actions">
            <Button :loading="updatingAlbum" icon="pi pi-check" size="small" @click="saveDescription"/>
            <Button :disabled="updatingAlbum" icon="pi pi-times" size="small" text @click="editingDescription = false"/>
          </div>
        </div>
      </div>

      <div class="album-info-block__meta">
        <span class="album-info-block__meta-text">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
      </div>
    </div>

    <GalleryLayout v-if="album && groupedPhotos.length > 0" :center-ref="setGridScrollRef">
      <template #left>
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
      </template>

      <template #default>
        <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
          <h2 class="year-title" :id="'year-' + yearGroup.year" data-section-header>{{ yearGroup.year }}</h2>

          <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
            <h3
              v-if="monthGroup.month"
              class="month-title"
              :id="'month-' + yearGroup.year + '-' + monthGroup.month"
              data-section-header
            >
              {{ monthGroup.month }}
            </h3>

            <div class="photo-grid">
              <div
                v-for="item in monthGroup.photos"
                :key="item.photo.id"
                :data-photo-id="item.photo.id"
                class="photo-item"
                :class="{ selected: item.index === selectedIndex }"
                @click="selectedIndex = item.index"
              >
                <div class="photo-thumb">
                  <HeicImage
                    v-if="visiblePhotoIds.has(item.photo.id)"
                    :alt="item.photo.original_name"
                    :src="getPhotoUrl(item.photo.filename, 400)"
                    objectFit="cover"
                  />
                  <div v-else class="thumb-placeholder" />
                </div>
                <div class="photo-meta">
                  <span class="photo-name">{{ item.photo.original_name }}</span>
                </div>
              </div>
            </div>
          </template>
        </template>
      </template>

      <template #right>
        <PhotoDetailSidebar
          v-if="selectedPhoto"
          :can-delete="canDeletePhotos"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="false"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :photo="selectedPhoto"
          :reindexing-photo="reindexingPhoto"
          :updating-date="false"
          :album-id="albumId"
          :cover-photo-id="album.cover_photo_id"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @fullscreen="isFullscreen = true"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </template>
    </GalleryLayout>

    <div v-else-if="album" class="info-text">
      Keine Fotos in dieser Ansicht.
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--surface-border);
}

.album-info-block__description {
  flex: 1 1 24rem;
  min-width: 16rem;
  display: flex;
  align-items: center;
}

.album-info-block__description-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.album-info-block__description-text {
  font-size: 0.9rem;
}

.album-info-block__description-text--empty {
  color: var(--text-color-secondary);
  font-style: italic;
}

.album-info-block__edit {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.album-info-block__edit textarea {
  flex: 1;
  min-height: 2.5rem;
}

.album-info-block__edit-actions {
  display: flex;
  gap: 0.25rem;
}

.album-info-block__meta {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.album-info-block__meta-text {
  font-size: 0.85rem;
  color: var(--text-color-secondary);
  white-space: nowrap;
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
  border-bottom: 1px solid var(--surface-border);
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
  background: var(--surface-200);
  text-transform: uppercase;
}

.role-badge--owner {
  background: #fee2e2;
  color: #991b1b;
}

.role-badge--contributor {
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
  color: var(--text-color-secondary);
}

.year-title {
  border-bottom: 2px solid #3b82f6;
  padding-bottom: 0.5rem;
}

.month-title {
  border-bottom: 1px solid var(--surface-border);
  color: #3b82f6;
  margin-top: 1rem;
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
  color: #3b82f6;
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.2s;
}

.nav-year:hover { background: #eff6ff; }
.nav-year.active { background: #3b82f6; color: white; }

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

.nav-month.active {
  color: #3b82f6;
  font-weight: bold;
  background: #eff6ff;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.photo-item {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: var(--surface-100);
}

.photo-item.selected {
  border-color: #3b82f6;
}

.photo-thumb {
  width: 100%;
  height: 100%;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  background: var(--surface-200);
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
  border-left: 1px solid var(--surface-border);
  background: var(--surface-card);
}

.info-text {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}
</style>
