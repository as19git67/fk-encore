<script lang="ts" setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoGrid from '../components/PhotoGrid.vue'
import TimelineNav from '../components/TimelineNav.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import {
  type AlbumWithPhotos,
  type AlbumShareWithUser,
  getPhotoFaces,
  getAlbum,
  getAlbumShares,
  getPhotoLandmarks,
  ignoreFace,
  listPersons,
  reindexPhoto,
  removeAlbumShare,
  shareAlbum,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type Person,
  type Photo,
  updatePhotoCuration,
  updateAlbum,
  updateAlbumUserSettings
} from '../api/photos'
import { listUsers, type UserWithRoles } from '../api/users'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoGrouping } from '../composables/usePhotoGrouping'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import type { PhotoItem } from '../composables/usePhotoGrouping'
import { onUnmounted } from 'vue'

const route = useRoute()
const albumId = Number(route.params.id)
const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()

// ── Data ──────────────────────────────────────────────────────────────────────
const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)
const activeSection = ref('')

// Flat Photo[] for composables, sorted newest-first
const albumPhotos = computed<Photo[]>(() =>
  [...((album.value?.photos ?? []) as Photo[])].sort((a, b) =>
    new Date(b.taken_at || b.created_at).getTime() -
    new Date(a.taken_at || a.created_at).getTime()
  )
)

// ── Grouping (via composable) ─────────────────────────────────────────────────
const { groupedPhotos } = usePhotoGrouping(albumPhotos)

// ── Navigation refs ───────────────────────────────────────────────────────────
const photoGridRef = ref<InstanceType<typeof PhotoGrid> | null>(null)
const timelineNavRef = ref<InstanceType<typeof TimelineNav> | null>(null)

// ── Keyboard navigation (via composable) ─────────────────────────────────────
useGalleryKeyboard({
  onLeft() {
    if (isFullscreen.value) { if (selectedIndex.value > 0) selectedIndex.value--; return }
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = albumPhotos.value.length - 1
  },
  onRight() {
    if (isFullscreen.value) {
      if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++; return
    }
    if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  },
  onUp() { timelineNavRef.value?.navigateUp() },
  onDown() { timelineNavRef.value?.navigateDown() },
  onSpace() {
    if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value
  },
  onExtra(e) {
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
  },
})

// ── Computed ──────────────────────────────────────────────────────────────────
const selectedPhoto = computed(() =>
  selectedIndex.value >= 0 ? albumPhotos.value[selectedIndex.value] ?? null : null
)
const prevPhoto = computed(() =>
  selectedIndex.value > 0 ? albumPhotos.value[selectedIndex.value - 1] ?? null : null
)
const nextPhoto = computed(() =>
  selectedIndex.value < albumPhotos.value.length - 1
    ? albumPhotos.value[selectedIndex.value + 1] ?? null : null
)

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const isOwner = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const showPersons = computed(() => auth.hasPermission('people.view'))

// ── Sidebar state ─────────────────────────────────────────────────────────────
const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])

watch(selectedPhoto, (photo) => {
  if (photo) {
    loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

watch(selectedIndex, () => {
  const photo = selectedPhoto.value
  if (photo && !isFullscreen.value) {
    const el = photoGridRef.value?.scrollRef?.querySelector(`[data-photo-id="${photo.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
})

// ── Data loading ──────────────────────────────────────────────────────────────
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
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Einstellungen'
  }
}

async function loadPersons() {
  try { persons.value = (await listPersons()).persons } catch { /* ignore */ }
}

async function loadSidebarData(photoId: number) {
  loadingFaces.value = true
  loadingLandmarks.value = true
  try {
    const [facesRes, landmarksRes] = await Promise.all([getPhotoFaces(photoId), getPhotoLandmarks(photoId)])
    detectedFaces.value = facesRes.faces
    detectedLandmarks.value = landmarksRes.landmarks
  } catch { detectedFaces.value = []; detectedLandmarks.value = [] }
  finally { loadingFaces.value = false; loadingLandmarks.value = false }
}

// ── Curation ──────────────────────────────────────────────────────────────────
function updatePhotoStatus(id: number, status: CurationStatus) {
  if (!album.value) return
  album.value.photos = album.value.photos.map(p => p.id === id ? { ...p, curation_status: status } : p)
}

async function handleHidePhoto(id: number) {
  try { await updatePhotoCuration(id, 'hidden'); updatePhotoStatus(id, 'hidden') }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleRestorePhoto(id: number) {
  try { await updatePhotoCuration(id, 'visible'); updatePhotoStatus(id, 'visible') }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  updatePhotoStatus(id, newStatus)
  try { await updatePhotoCuration(id, newStatus) }
  catch (err: any) { updatePhotoStatus(id, currentStatus); error.value = err.message || 'Fehler' }
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try { await ignoreFace(faceId); detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId) }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try { await reindexPhoto(selectedPhoto.value.id); await loadSidebarData(selectedPhoto.value.id) }
  catch (err: any) { error.value = err.message || 'Fehler' }
  finally { reindexingPhoto.value = false }
}

function handleCoverPhotoIdUpdate(id: number | null) {
  if (!album.value) return
  album.value.cover_photo_id = id ?? undefined
}

// ── Grid interaction ──────────────────────────────────────────────────────────
function handlePhotoClick(item: PhotoItem) {
  // Album view: single click selects + opens fullscreen
  selectedIndex.value = item.index
  isFullscreen.value = true
}

// ── Timeline nav ──────────────────────────────────────────────────────────────
function handleScrollTo(sectionId: string) {
  photoGridRef.value?.scrollToSection(sectionId)
  activeSection.value = sectionId
}

// ── Album cover ───────────────────────────────────────────────────────────────
async function scrollToCover() {
  if (!album.value?.cover_photo_id) return
  const idx = albumPhotos.value.findIndex(p => p.id === album.value!.cover_photo_id)
  if (idx >= 0) selectedIndex.value = idx
}

// ── Description editing ───────────────────────────────────────────────────────
const updatingAlbum = ref(false)
const editingDescription = ref(false)
const descDraft = ref('')

function startEditDesc() {
  if (!album.value) return
  descDraft.value = album.value.description || ''
  editingDescription.value = true
}

async function saveDescription() {
  if (!album.value) return
  updatingAlbum.value = true
  try {
    await updateAlbum(albumId, { description: descDraft.value })
    album.value.description = descDraft.value
    editingDescription.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Beschreibung'
  } finally {
    updatingAlbum.value = false
  }
}

// ── Album sharing ─────────────────────────────────────────────────────────────
const showShareDialog = ref(false)
const albumShares = ref<AlbumShareWithUser[]>([])
const allUsers = ref<UserWithRoles[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<'read' | 'write'>('read')
const sharing = ref(false)
const loadingShares = ref(false)

const viewOptions = [{ label: 'Alle', value: 'all' }, { label: 'Favoriten', value: 'favorites' }]
const hideModeOptions = [{ label: 'Meine ausgeblendeten', value: 'mine' }, { label: 'Alle ausgeblendeten', value: 'all' }]
const accessLevelOptions = [{ label: 'Nur lesen', value: 'read' }, { label: 'Bearbeiten', value: 'write' }]

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumShares.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  return allUsers.value.filter(u => u.id !== currentUserId && !sharedIds.has(u.id))
})

async function openShareDialog() {
  showShareDialog.value = true
  loadingShares.value = true
  try {
    const [sharesRes, usersRes] = await Promise.all([
      getAlbumShares(albumId),
      auth.hasPermission('users.list') ? listUsers() : Promise.resolve({ users: [] }),
    ])
    albumShares.value = sharesRes.shares
    allUsers.value = usersRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Freigaben'
  } finally {
    loadingShares.value = false
  }
}

async function handleShare() {
  if (!shareUserId.value) return
  sharing.value = true
  try {
    await shareAlbum(albumId, shareUserId.value, shareAccessLevel.value)
    albumShares.value = (await getAlbumShares(albumId)).shares
    shareUserId.value = null
    shareAccessLevel.value = 'read'
  } catch (err: any) { error.value = err.message || 'Fehler beim Freigeben' }
  finally { sharing.value = false }
}

async function handleRemoveShare(userId: number) {
  try {
    await removeAlbumShare(albumId, userId)
    albumShares.value = albumShares.value.filter(s => s.user_id !== userId)
  } catch (err: any) { error.value = err.message || 'Fehler' }
}

// ── Init ──────────────────────────────────────────────────────────────────────
void loadData()
if (showPersons.value) void loadPersons()
serviceHealth.startPolling()
onUnmounted(() => serviceHealth.stopPolling())
</script>

<template>
  <div class="album-detail-view">
    <ServiceStatusBar />

    <div v-if="album" class="subheader">
      <div class="header">
        <div class="header-left">
          <h1 class="title">{{ album.name }}</h1>
          <span :class="['role-badge', `role-badge--${album.role}`]">{{ album.role }}</span>
        </div>
        <div class="controls">
          <Button v-if="album.cover_photo_id" icon="pi pi-image" label="Cover fokussieren" size="small" text @click="scrollToCover" />
          <Button v-if="isOwner" icon="pi pi-share-alt" label="Freigeben" size="small" text @click="openShareDialog" />
          <div v-if="album.settings" class="control-group">
            <label>Ansicht:</label>
            <SelectButton v-model="album.settings.active_view" :options="viewOptions" optionLabel="label" optionValue="value" @change="handleSettingsChange" />
          </div>
          <div v-if="album.settings" class="control-group">
            <label>Ausblenden:</label>
            <SelectButton v-model="album.settings.hide_mode" :options="hideModeOptions" optionLabel="label" optionValue="value" @change="handleSettingsChange" />
          </div>
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && !album" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <div v-if="album" class="album-info-block">
      <div class="album-info-block__description">
        <div v-if="!editingDescription" class="album-info-block__description-content">
          <span :class="{ 'album-info-block__description-text--empty': !album.description }" class="album-info-block__description-text">
            {{ album.description || 'Keine Beschreibung' }}
          </span>
          <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc" class="album-info-block__edit-btn" />
        </div>
        <div v-else class="album-info-block__edit">
          <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="2" />
          <div class="album-info-block__edit-actions">
            <Button :loading="updatingAlbum" icon="pi pi-check" size="small" @click="saveDescription" />
            <Button :disabled="updatingAlbum" icon="pi pi-times" size="small" text @click="editingDescription = false" />
          </div>
        </div>
      </div>
      <div class="album-info-block__meta">
        <span class="album-info-block__meta-text">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
      </div>
    </div>

    <!-- Three-column layout: TimelineNav | PhotoGrid | Sidebar -->
    <div v-if="album && groupedPhotos.length > 0" class="gallery-layout">
      <!-- LEFT: Timeline nav -->
      <TimelineNav
        ref="timelineNavRef"
        :groupedPhotos="groupedPhotos"
        :activeSection="activeSection"
        @scroll-to="handleScrollTo"
      />

      <!-- CENTER: Photo grid -->
      <PhotoGrid
        ref="photoGridRef"
        :groupedPhotos="groupedPhotos"
        :photos="albumPhotos"
        :selectedIndex="selectedIndex"
        :selectedPhotoIds="new Set(selectedPhoto ? [selectedPhoto.id] : [])"
        :canDelete="false"
        @update:columnCount="() => {}"
        @section-change="activeSection = $event"
        @photo-click="handlePhotoClick"
        @photo-dblclick="handlePhotoClick"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
      />

      <!-- RIGHT: Details sidebar -->
      <PhotoDetailSidebar
        v-if="selectedPhoto"
        :photo="selectedPhoto"
        :can-delete="canDeletePhotos || canWrite"
        :can-upload="canUploadPhotos"
        :faces="detectedFaces"
        :is-editing-date="false"
        :landmarks="detectedLandmarks"
        :loading-faces="loadingFaces"
        :loading-landmarks="loadingLandmarks"
        :persons="persons"
        :reindexing-photo="reindexingPhoto"
        :updating-date="false"
        :album-id="albumId"
        :cover-photo-id="album.cover_photo_id"
        :show-persons="showPersons"
        :limit-albums-shown="true"
        :face-service-available="serviceHealth.faceServiceAvailable"
        @update:cover-photo-id="handleCoverPhotoIdUpdate"
        @fullscreen="isFullscreen = true"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
        @ignore-face="handleIgnoreFaceInSidebar"
        @reindex="handleReindexPhoto"
      />
    </div>

    <div v-else-if="album" class="info-text">Keine Fotos in dieser Ansicht.</div>

    <!-- Fullscreen overlay -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
    />

    <!-- Share Dialog -->
    <Dialog v-model:visible="showShareDialog" header="Album freigeben" modal style="width: 480px">
      <div v-if="loadingShares" class="share-loading"><i class="pi pi-spin pi-spinner" /> Lädt…</div>
      <template v-else>
        <div class="share-section">
          <h4 class="share-section-title">Aktuelle Freigaben</h4>
          <div v-if="albumShares.length === 0" class="share-empty">Noch keine Freigaben.</div>
          <div v-for="share in albumShares" :key="share.user_id" class="share-row">
            <div class="share-user-info">
              <span class="share-user-name">{{ share.user_name }}</span>
              <span class="share-user-email">{{ share.user_email }}</span>
            </div>
            <span :class="['share-badge', share.access_level === 'write' ? 'share-badge--write' : 'share-badge--read']">
              {{ share.access_level === 'write' ? 'Bearbeiten' : 'Nur lesen' }}
            </span>
            <Button icon="pi pi-times" size="small" text severity="danger" @click="handleRemoveShare(share.user_id)" />
          </div>
        </div>
        <div class="share-section">
          <h4 class="share-section-title">Benutzer hinzufügen</h4>
          <div class="share-add-form">
            <Select v-if="allUsers.length > 0" v-model="shareUserId" :options="usersNotShared" optionLabel="name" optionValue="id" placeholder="Benutzer auswählen…" class="share-user-select" />
            <input v-else v-model.number="shareUserId" type="number" placeholder="Benutzer-ID" class="p-inputtext share-userid-input" />
            <SelectButton v-model="shareAccessLevel" :options="accessLevelOptions" optionLabel="label" optionValue="value" />
            <Button label="Freigeben" icon="pi pi-check" :loading="sharing" :disabled="!shareUserId" @click="handleShare" />
          </div>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.album-detail-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

@media (min-width: 800px) {
  .album-detail-view { margin-inline: 0.5em; }
}

.album-detail-view .title { font-size: 1.5em; font-weight: 600; margin-block: 0.25em; }

.subheader {
  flex-shrink: 0;
  background: var(--surface-card);
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  gap: 0.5em;
  border-bottom: 1px solid var(--surface-border);
}

.header-left { display: flex; align-items: center; gap: 1rem; }

.role-badge {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  background: var(--surface-200);
  text-transform: uppercase;
}
.role-badge--owner { background: #fee2e2; color: #991b1b; }
.role-badge--contributor { background: #dcfce7; color: #166534; }

.controls { display: flex; gap: 2rem; align-items: center; flex-wrap: wrap; }

.control-group { display: flex; align-items: center; gap: 0.5rem; }
.control-group label { font-size: 0.85rem; color: var(--text-color-secondary); }

/* ── Album info block ────────────────────────────────────────────────────── */
.album-info-block {
  flex-shrink: 0;
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

.album-info-block__description-content { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
.album-info-block__description-text { font-size: 0.9rem; }
.album-info-block__description-text--empty { color: var(--text-color-secondary); font-style: italic; }
.album-info-block__edit { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
.album-info-block__edit textarea { flex: 1; min-height: 2.5rem; }
.album-info-block__edit-actions { display: flex; gap: 0.25rem; }
.album-info-block__meta { display: flex; align-items: center; flex: 0 0 auto; }
.album-info-block__meta-text { font-size: 0.85rem; color: var(--text-color-secondary); white-space: nowrap; }

/* ── Three-column layout ─────────────────────────────────────────────────── */
.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.info-text {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}

/* ── Share dialog ────────────────────────────────────────────────────────── */
.share-loading { padding: 1rem; text-align: center; }
.share-section { margin-bottom: 1.5rem; }
.share-section-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; }
.share-empty { font-size: 0.85rem; color: var(--text-color-secondary); }
.share-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0; border-bottom: 1px solid var(--surface-border); }
.share-user-info { flex: 1; min-width: 0; }
.share-user-name { display: block; font-size: 0.875rem; font-weight: 500; }
.share-user-email { display: block; font-size: 0.75rem; color: var(--text-color-secondary); }
.share-badge { font-size: 0.7rem; padding: 0.15rem 0.4rem; border-radius: 3px; white-space: nowrap; }
.share-badge--read { background: var(--surface-200); color: var(--text-color-secondary); }
.share-badge--write { background: #dcfce7; color: #166534; }
.share-add-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.share-user-select { flex: 1; min-width: 180px; }
.share-userid-input { width: 120px; }
</style>
