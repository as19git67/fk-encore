<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ToggleSwitch from 'primevue/toggleswitch'
import { useConfirm } from 'primevue/useconfirm'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoGrid from '../components/PhotoGrid.vue'
import TimelineNav from '../components/TimelineNav.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import {
  listPhotos, uploadPhoto, updatePhotoDate, reindexPhoto, ignoreFace,
  getPhotoFaces, getPhotoLandmarks, updatePhotoCuration,
  listPhotoGroups, searchPhotos,
  type Photo, type Face, type CurationStatus, type PhotoGroup,
  type PhotoSearchResult, type LandmarkItem,
} from '../api/photos'
import { listPersons, type Person } from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoGrouping } from '../composables/usePhotoGrouping'
import { usePhotoSelection } from '../composables/usePhotoSelection'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const confirm = useConfirm()

// ── Data ─────────────────────────────────────────────────────────────────────
const photos = ref<Photo[]>([])
const loading = ref(true)
const uploading = ref(false)
const uploadAbortController = ref<AbortController | null>(null)
const error = ref('')
const showHidden = ref(false)

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const canManageData = computed(() => auth.hasPermission('data.manage'))

// ── Photo groups (stacks) ─────────────────────────────────────────────────────
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)

const photoToGroup = computed(() => {
  const map = new Map<number, PhotoGroup>()
  for (const group of photoGroupsList.value) {
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  return map
})

const unreviewedGroupCount = computed(() =>
  photoGroupsList.value.filter(g => !g.reviewed_at).length
)

const hiddenByStack = computed(() => {
  const set = new Set<number>()
  for (const group of photoGroupsList.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) {
      if (pid !== group.cover_photo_id) set.add(pid)
    }
  }
  return set
})


// ── Search ────────────────────────────────────────────────────────────────────
const searchQuery = ref('')
const searchResults = ref<PhotoSearchResult[] | null>(null)
const searchLoading = ref(false)
const searchError = ref('')

const searchResultIds = computed<number[] | null>(() =>
  searchResults.value ? searchResults.value.map(r => r.photoId) : null
)

async function executeSearch() {
  const q = searchQuery.value.trim()
  if (!q) { clearSearch(); return }
  searchLoading.value = true
  searchError.value = ''
  try {
    searchResults.value = (await searchPhotos(q)).results
  } catch {
    searchError.value = 'Suche fehlgeschlagen. Ist der Embedding-Service erreichbar?'
  } finally {
    searchLoading.value = false
  }
}

function clearSearch() {
  searchQuery.value = ''
  searchResults.value = null
  searchError.value = ''
}

// ── Sort ──────────────────────────────────────────────────────────────────────
const sortBy = ref<'date' | 'quality'>('date')

// ── Grouping (via composable) ─────────────────────────────────────────────────
const { groupedPhotos } = usePhotoGrouping(photos, {
  hiddenByStack,
  photoToGroup,
  searchResultIds,
  sortBy,
})

// ── Selection (via composable) ────────────────────────────────────────────────
const { selectedIndex, selectedPhotoIds, selectedPhoto, selectedPhotos, selectPhoto } =
  usePhotoSelection(photos)

// Expand selection: if any selected photo is in a group, include all group members
const expandedSelectedPhotos = computed<Photo[]>(() => {
  const expanded = new Set<number>()
  for (const photo of selectedPhotos.value) {
    expanded.add(photo.id)
    const group = photoToGroup.value.get(photo.id)
    if (group) {
      for (const pid of group.photo_ids) expanded.add(pid)
    }
  }
  return photos.value.filter(p => expanded.has(p.id))
})

const prevPhoto = computed(() =>
  selectedIndex.value > 0 ? photos.value[selectedIndex.value - 1] ?? null : null
)
const nextPhoto = computed(() =>
  selectedIndex.value >= 0 && selectedIndex.value < photos.value.length - 1
    ? photos.value[selectedIndex.value + 1] ?? null
    : null
)

// ── Mobile drawer state ───────────────────────────────────────────────────────
const mobileTimelineOpen = ref(false)
const mobileSidebarOpen = ref(false)

watch(selectedPhoto, (photo) => {
  if (photo && window.innerWidth <= 768) {
    mobileSidebarOpen.value = true
  }
})

// ── Sidebar state ─────────────────────────────────────────────────────────────
const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])
const isEditingDate = ref(false)
const editDate = ref<Date | null>(null)
const updatingDate = ref(false)

watch(selectedPhoto, (photo) => {
  isEditingDate.value = false
  if (photo) {
    loadDetectedFaces(photo.id)
    loadLandmarks(photo.id)
    loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

async function loadPersons() {
  try { persons.value = (await listPersons()).persons } catch { /* ignore */ }
}

async function loadDetectedFaces(photoId: number) {
  loadingFaces.value = true
  try { detectedFaces.value = (await getPhotoFaces(photoId)).faces }
  catch { detectedFaces.value = [] }
  finally { loadingFaces.value = false }
}

async function loadLandmarks(photoId: number) {
  loadingLandmarks.value = true
  try { detectedLandmarks.value = (await getPhotoLandmarks(photoId)).landmarks }
  catch { detectedLandmarks.value = [] }
  finally { loadingLandmarks.value = false }
}

// ── Fullscreen ────────────────────────────────────────────────────────────────
const isFullscreen = ref(false)

watch(isFullscreen, (val) => { if (!val) isEditingDate.value = false })

// ── Column count (received from PhotoGrid) ────────────────────────────────────
const columnCount = ref(4)

// ── Active section (received from PhotoGrid, passed to TimelineNav) ───────────
const activeSection = ref('')

// ── Ref to PhotoGrid component ────────────────────────────────────────────────
const photoGridRef = ref<InstanceType<typeof PhotoGrid> | null>(null)
const timelineNavRef = ref<InstanceType<typeof TimelineNav> | null>(null)

// ── Keyboard navigation (via composable) ─────────────────────────────────────
useGalleryKeyboard({
  isBlocked: () => !!activeGroup.value || isEditingDate.value,
  onLeft() {
    if (isFullscreen.value) {
      if (selectedIndex.value > 0) selectedIndex.value--
    } else {
      if (selectedIndex.value > 0) selectedIndex.value--
      else selectedIndex.value = photos.value.length - 1
    }
  },
  onRight() {
    if (isFullscreen.value) {
      if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
    } else {
      if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
      else selectedIndex.value = 0
    }
  },
  onUp() { timelineNavRef.value?.navigateUp() },
  onDown() { timelineNavRef.value?.navigateDown() },
  onSpace() {
    if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value
  },
  onExtra(e) {
    if (!selectedPhoto.value) return
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
    else if (e.key === 'Enter' && !isFullscreen.value) { isFullscreen.value = true; e.preventDefault() }
    else if (e.key === 'f' || e.key === 'F') { handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status); e.preventDefault() }
    else if (e.key === 'x' || e.key === 'X') {
      if (selectedPhoto.value.curation_status !== 'hidden') handleDelete(selectedPhoto.value.id)
      else handleRestore(selectedPhoto.value.id)
      e.preventDefault()
    }
  },
})

// Scroll selected photo into view is handled by PhotoGrid internally

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadPhotos() {
  loading.value = true
  error.value = ''
  try {
    const [photosRes, groupsRes] = await Promise.all([
      listPhotos(showHidden.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    photos.value = photosRes.photos.sort((a, b) =>
      new Date(b.taken_at || b.created_at).getTime() -
      new Date(a.taken_at || a.created_at).getTime()
    )
    photoGroupsList.value = groupsRes.groups
    loading.value = false
    await nextTick()
    const firstVisible = photos.value.findIndex(p => !hiddenByStack.value.has(p.id))
    selectedIndex.value = firstVisible >= 0 ? firstVisible : (photos.value.length > 0 ? 0 : -1)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Fotos'
    loading.value = false
  }
}

async function reloadPhotosInPlace() {
  try {
    const [photosRes, groupsRes] = await Promise.all([
      listPhotos(showHidden.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    photos.value = photosRes.photos.sort((a, b) =>
      new Date(b.taken_at || b.created_at).getTime() -
      new Date(a.taken_at || a.created_at).getTime()
    )
    photoGroupsList.value = groupsRes.groups
  } catch { /* silently fail */ }
}

// ── Curation ──────────────────────────────────────────────────────────────────
async function handleDelete(id: number) {
  confirm.require({
    message: 'Foto ausblenden? Es kann jederzeit wiederhergestellt werden.',
    header: 'Foto ausblenden',
    icon: 'pi pi-eye-slash',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Ausblenden', severity: 'warn' },
    accept: async () => {
      try {
        await updatePhotoCuration(id, 'hidden')
        await reloadPhotosInPlace()
        if (selectedIndex.value >= photos.value.length) selectedIndex.value = photos.value.length - 1
      } catch (err: any) { error.value = err.message || 'Fehler' }
    },
  })
}

async function handleRestore(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    await reloadPhotosInPlace()
  } catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  const photo = photos.value.find(p => p.id === id)
  if (photo) photo.curation_status = newStatus
  try {
    await updatePhotoCuration(id, newStatus)
    await reloadPhotosInPlace()
  } catch (err: any) {
    if (photo) photo.curation_status = currentStatus
    error.value = err.message || 'Fehler'
  }
}

// ── Date editing ──────────────────────────────────────────────────────────────
function startEditingDate() {
  const photo = selectedPhoto.value
  if (!photo) return
  editDate.value = new Date(photo.taken_at || photo.created_at)
  isEditingDate.value = true
}

async function handleUpdateDate() {
  const photo = selectedPhoto.value
  if (!editDate.value || !photo) return
  updatingDate.value = true
  try {
    const takenAt = editDate.value.toISOString()
    await updatePhotoDate(photo.id, takenAt)
    photo.taken_at = takenAt
    isEditingDate.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Aktualisieren des Datums'
  } finally {
    updatingDate.value = false
  }
}

// ── Face actions ──────────────────────────────────────────────────────────────
async function handleIgnoreFace(faceId: number) {
  if (!selectedPhoto.value) return
  try {
    await ignoreFace(faceId)
    await loadDetectedFaces(selectedPhoto.value.id)
  } catch { /* ignore */ }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try {
    await reindexPhoto(selectedPhoto.value.id)
    await Promise.all([loadDetectedFaces(selectedPhoto.value.id), loadLandmarks(selectedPhoto.value.id)])
  } catch { /* ignore */ }
  finally { reindexingPhoto.value = false }
}

// ── Group multi-select (Ctrl/Shift click on a stack) ─────────────────────
function handleGroupMultiSelect(group: PhotoGroup) {
  const newSet = new Set(selectedPhotoIds.value)
  for (const pid of group.photo_ids) {
    newSet.add(pid)
  }
  selectedPhotoIds.value = newSet
  // Set selectedIndex to the cover photo or first group member
  const coverIdx = photos.value.findIndex(p => p.id === (group.cover_photo_id ?? group.photo_ids[0]))
  if (coverIdx >= 0) selectedIndex.value = coverIdx
}

// ── Stack group handling ──────────────────────────────────────────────────────
function selectAfterGroup(group: PhotoGroup | null) {
  if (!group || photos.value.length === 0) {
    selectedIndex.value = photos.value.length > 0 ? 0 : -1
    return
  }
  const groupPhotoIds = new Set(group.photo_ids)
  const visibleGroupItems = photos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id) && !hiddenByStack.value.has(photo.id))
  if (visibleGroupItems.length > 0) {
    selectedIndex.value = visibleGroupItems[0]!.index
    return
  }
  const allGroupItems = photos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id))
  const maxIdx = allGroupItems.length > 0 ? Math.max(...allGroupItems.map(gi => gi.index)) : -1
  for (let i = maxIdx + 1; i < photos.value.length; i++) {
    if (!hiddenByStack.value.has(photos.value[i]!.id)) { selectedIndex.value = i; return }
  }
  selectedIndex.value = photos.value.findIndex(p => !hiddenByStack.value.has(p.id))
}

function handleGroupClose() {
  const group = activeGroup.value
  activeGroup.value = null
  reloadPhotosInPlace().then(() => selectAfterGroup(group))
}

function handleGroupNext(reviewedGroupId: number) {
  const next = photoGroupsList.value.find(g => !g.reviewed_at && g.id !== reviewedGroupId)
  if (next) { activeGroup.value = next; reloadPhotosInPlace() }
  else { const group = activeGroup.value; activeGroup.value = null; reloadPhotosInPlace().then(() => selectAfterGroup(group)) }
}

function handleStartGroupReview() {
  const first = photoGroupsList.value.find(g => !g.reviewed_at)
  if (first) activeGroup.value = first
}

// ── Timeline nav scroll ───────────────────────────────────────────────────────
function handleScrollTo(sectionId: string) {
  photoGridRef.value?.scrollToSection(sectionId)
  activeSection.value = sectionId

  // Select first photo in the target section
  for (const yearGroup of groupedPhotos.value) {
    if (yearGroup.sectionId === sectionId) {
      const firstMonth = yearGroup.months[0]
      if (firstMonth?.photos.length) {
        selectPhoto(firstMonth.photos[0]!.index)
      }
      return
    }
    for (const monthGroup of yearGroup.months) {
      if (monthGroup.sectionId === sectionId && monthGroup.photos.length) {
        selectPhoto(monthGroup.photos[0]!.index)
        return
      }
    }
  }
}

// ── Upload / Drag & Drop ──────────────────────────────────────────────────────
const uploadErrors = ref<string[]>([])
const showErrorFlyout = ref(false)

const isDragging = ref(false)
const dragCounter = ref(0)

async function handleUpload(event: any) {
  let files: File[] = []
  if (event.files) files = event.files
  else if (event instanceof FileList) files = Array.from(event)
  else if (event.dataTransfer) files = Array.from(event.dataTransfer.files)
  if (!files.length) return

  const abortController = new AbortController()
  uploadAbortController.value = abortController
  uploading.value = true
  error.value = ''
  const duplicates: string[] = []
  const unsupported: string[] = []
  const errors: string[] = []

  try {
    for (const file of files) {
      if (abortController.signal.aborted) break
      try { await uploadPhoto(file, abortController.signal) }
      catch (err: any) {
        if (abortController.signal.aborted) break
        if (err.message?.includes('bereits hochgeladen')) duplicates.push(file.name)
        else if (err.message?.includes('nicht unterstützt')) unsupported.push(file.name)
        else errors.push(`${file.name}: ${err.message}`)
      }
    }
    await loadPhotos()
    if (abortController.signal.aborted) {
      error.value = 'Hochladen wurde abgebrochen.'
    } else if (duplicates.length || unsupported.length || errors.length) {
      const allErrors: string[] = [
        ...duplicates.map(f => `Bereits vorhanden: ${f}`),
        ...unsupported.map(f => `Nicht unterstützt: ${f}`),
        ...errors.map(e => `Fehler: ${e}`),
      ]
      const totalErrors = allErrors.length
      if (totalErrors > 3) {
        uploadErrors.value = allErrors
        error.value = `${totalErrors} Dateien konnten nicht hochgeladen werden.`
      } else {
        uploadErrors.value = []
        error.value = allErrors.join(' ')
      }
    }
  } catch (err: any) {
    if (!abortController.signal.aborted) error.value = err.message || 'Fehler beim Hochladen'
  } finally {
    uploading.value = false
    uploadAbortController.value = null
  }
}

function cancelUpload() { uploadAbortController.value?.abort() }

function handleDragEnter(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault(); dragCounter.value++; isDragging.value = true
}
function handleDragLeave(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault(); dragCounter.value--
  if (dragCounter.value === 0) isDragging.value = false
}
function handleDragOver(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
async function handleDrop(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault(); isDragging.value = false; dragCounter.value = 0
  const files = e.dataTransfer?.files
  if (files?.length) await handleUpload(files)
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadPhotos()
serviceHealth.startPolling()

import { onUnmounted } from 'vue'
onUnmounted(() => serviceHealth.stopPolling())
</script>

<template>
  <div
    class="photos-view"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Drag overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-message">
        <i class="pi pi-upload" />
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>

    <ServiceStatusBar />

    <!-- Subheader -->
    <div class="subheader">
      <div class="header">
        <h1 class="title">Meine Fotos</h1>
        <div class="actions">
          <div v-if="canDelete" class="toggle-hidden">
            <label for="showHidden" class="text-sm">Ausgeblendete</label>
            <ToggleSwitch v-model="showHidden" inputId="showHidden" @update:modelValue="loadPhotos" />
          </div>
          <Button
            v-if="canManageData && unreviewedGroupCount > 0"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images" severity="success"
            @click="handleStartGroupReview"
          />
          <Button v-if="canUpload && uploading" label="Abbrechen" icon="pi pi-times" severity="danger" @click="cancelUpload" />
          <label v-else-if="canUpload" class="upload-button-label">
            <input type="file" accept="image/*" multiple class="upload-input-hidden"
              @change="handleUpload({ files: ($event.target as HTMLInputElement).files ? Array.from(($event.target as HTMLInputElement).files!) : [] })" />
            <Button label="Fotos hochladen" icon="pi pi-upload" as="span" />
          </label>
        </div>
      </div>

      <div class="search-bar">
        <div class="search-input-wrapper">
          <i class="pi pi-search search-icon" />
          <input v-model="searchQuery" type="text" class="search-input"
            placeholder="Fotos suchen…"
            @keyup.enter="executeSearch"
            @keyup.escape="clearSearch" />
          <button v-if="searchQuery" class="search-clear" @click="clearSearch"><i class="pi pi-times" /></button>
        </div>
        <Button icon="pi pi-search" label="Suchen" :loading="searchLoading" :disabled="!searchQuery.trim()" @click="executeSearch" />
        <span v-if="searchResults !== null && !searchLoading" class="search-result-count">
          {{ searchResults.length }} Treffer
        </span>
        <div class="sort-toggle">
          <Button
            :icon="sortBy === 'date' ? 'pi pi-calendar' : 'pi pi-star'"
            :label="sortBy === 'date' ? 'Datum' : 'Qualität'"
            size="small" severity="secondary" outlined
            @click="sortBy = sortBy === 'date' ? 'quality' : 'date'"
          />
        </div>
      </div>
    </div>

    <Message v-if="searchError" severity="error" @close="searchError = ''">{{ searchError }}</Message>
    <Message v-if="error" severity="error" @close="error = ''; uploadErrors = []">
      {{ error }}
      <button v-if="uploadErrors.length > 3" class="error-flyout-btn" @click="showErrorFlyout = !showErrorFlyout">
        <i class="pi pi-list" /> Details anzeigen
      </button>
    </Message>

    <!-- Error flyout overlay -->
    <div v-if="showErrorFlyout && uploadErrors.length > 0" class="error-flyout-overlay" @click.self="showErrorFlyout = false">
      <div class="error-flyout">
        <div class="error-flyout-header">
          <span>{{ uploadErrors.length }} Fehler beim Hochladen</span>
          <button class="error-flyout-close" @click="showErrorFlyout = false"><i class="pi pi-times" /></button>
        </div>
        <ul class="error-flyout-list">
          <li v-for="(err, i) in uploadErrors" :key="i">{{ err }}</li>
        </ul>
      </div>
    </div>

    <div v-if="uploading" class="info-text">Fotos werden hochgeladen…</div>
    <div v-else-if="loading" class="info-text">Lade Fotos…</div>
    <div v-else-if="photos.length === 0" class="info-text">Keine Fotos hochgeladen.</div>

    <!-- Three-column layout -->
    <div
      v-else
      class="gallery-layout"
      :class="{ 'mobile-timeline-open': mobileTimelineOpen, 'mobile-sidebar-open': mobileSidebarOpen }"
    >
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
        :photos="photos"
        :selectedIndex="selectedIndex"
        :selectedPhotoIds="selectedPhotoIds"
        :canDelete="canDelete"
        :hasStacks="true"
        @update:columnCount="columnCount = $event"
        @section-change="activeSection = $event"
        @photo-click="(item, event) => selectPhoto(item.index, event)"
        @photo-dblclick="isFullscreen = true"
        @stack-click="activeGroup = $event"
        @group-multi-select="handleGroupMultiSelect"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleDelete"
        @restore="handleRestore"
      />

      <!-- RIGHT: Details sidebar -->
      <PhotoDetailSidebar
        v-if="selectedPhotos.length > 0"
        :photo="(selectedPhoto || selectedPhotos[0])!"
        :selectedPhotos="expandedSelectedPhotos"
        :faces="detectedFaces"
        :loading-faces="loadingFaces"
        :landmarks="detectedLandmarks"
        :loading-landmarks="loadingLandmarks"
        :limitAlbumsShown="true"
        :persons="persons"
        :can-delete="canDelete"
        :can-upload="canUpload"
        :reindexing-photo="reindexingPhoto"
        :is-editing-date="isEditingDate"
        v-model:editDate="editDate"
        :updating-date="updatingDate"
        :show-persons="auth.hasPermission('people.view')"
        :face-service-available="serviceHealth.faceServiceAvailable"
        @fullscreen="isFullscreen = true"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleDelete"
        @restore="handleRestore"
        @start-edit-date="startEditingDate"
        @update-date="handleUpdateDate"
        @cancel-edit-date="isEditingDate = false"
        @ignore-face="handleIgnoreFace"
        @reindex="handleReindexPhoto"
      />
    </div>

    <!-- Fullscreen overlay -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="canDelete"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleDelete"
      @restore="handleRestore"
    />

    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :allPhotos="photos"
      :totalUnreviewed="unreviewedGroupCount"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobileTimelineOpen || mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileTimelineOpen = false; mobileSidebarOpen = false"
    />

    <!-- Mobile: Floating-Button zum Öffnen der Zeitleiste -->
    <button
      v-if="!loading && !uploading && photos.length > 0"
      class="mobile-fab mobile-fab--timeline"
      :class="{ active: mobileTimelineOpen }"
      @click="mobileTimelineOpen = !mobileTimelineOpen; mobileSidebarOpen = false"
      aria-label="Zeitleiste"
    >
      <i class="pi pi-calendar" />
    </button>

    <!-- Mobile: Floating-Button zum Öffnen der Details (wenn Foto gewählt) -->
    <button
      v-if="selectedPhoto && !mobileSidebarOpen && !loading && !uploading"
      class="mobile-fab mobile-fab--details"
      @click="mobileSidebarOpen = true; mobileTimelineOpen = false"
      aria-label="Details"
    >
      <i class="pi pi-info-circle" />
    </button>
  </div>
</template>

<style scoped>
.photos-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

.photos-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin: 0;
}

.subheader {
  flex-shrink: 0;
  background: var(--surface-card);
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  padding: 0.5rem 1rem;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.toggle-hidden {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.info-text {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}

.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Search Bar ──────────────────────────────────────────────────────────── */
.search-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0 0;
  flex-wrap: wrap;
}

.search-input-wrapper {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 600px;
}

.search-icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-color-secondary);
  pointer-events: none;
  font-size: 0.9rem;
}

.search-input {
  width: 100%;
  padding: 0.5rem 2.25rem;
  border: 1px solid var(--surface-300);
  border-radius: 6px;
  background: var(--surface-0);
  color: var(--text-color);
  font-size: 0.95rem;
  outline: none;
  box-sizing: border-box;
}

.search-input:focus {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px var(--primary-200, rgba(99, 102, 241, 0.2));
}

.search-clear {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-color-secondary);
  padding: 0.2rem;
  display: flex;
  border-radius: 4px;
}
.search-clear:hover { color: var(--text-color); background: var(--surface-100); }

.search-result-count {
  font-size: 0.875rem;
  color: var(--text-color-secondary);
  white-space: nowrap;
}

.sort-toggle { margin-left: auto; }

/* ── Upload ──────────────────────────────────────────────────────────────── */
.upload-button-label { display: inline-flex; cursor: pointer; }
.upload-input-hidden { display: none; }

/* ── Drag Overlay ────────────────────────────────────────────────────────── */
.drag-overlay {
  position: fixed;
  inset: 0;
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
  color: var(--p-primary-color);
  font-size: 1.5rem;
  font-weight: 600;
}

.drag-message .pi { font-size: 3rem; }

/* ── Error flyout ───────────────────────────────────────────────────────── */
.error-flyout-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-left: 0.75rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.error-flyout-btn:hover { background: rgba(255, 255, 255, 0.3); }

.error-flyout-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8rem;
  background: rgba(0, 0, 0, 0.3);
}

.error-flyout {
  background: var(--surface-card);
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 90%;
  max-width: 500px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
}

.error-flyout-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.95rem;
  border-bottom: 1px solid var(--surface-border);
  flex-shrink: 0;
}

.error-flyout-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-color-secondary);
  padding: 0.25rem;
  border-radius: 4px;
}
.error-flyout-close:hover { color: var(--text-color); background: var(--surface-100); }

.error-flyout-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.error-flyout-list li {
  padding: 0.5rem 1rem;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--surface-50);
}

.error-flyout-list li:last-child { border-bottom: none; }

/* ── Mobile Backdrop ─────────────────────────────────────────────────────── */
.mobile-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 490;
}

/* ── Mobile FABs ─────────────────────────────────────────────────────────── */
.mobile-fab {
  display: none;
  position: fixed;
  bottom: 1.5rem;
  z-index: 495;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  transition: background 0.2s, transform 0.2s;
}

.mobile-fab--timeline {
  left: 1rem;
  background: var(--surface-card);
  color: var(--p-primary-color);
  border: 1px solid var(--surface-border);
}
.mobile-fab--timeline.active {
  background: var(--p-primary-color);
  color: white;
}

.mobile-fab--details {
  right: 1rem;
  background: var(--p-primary-color);
  color: white;
}

/* ── Mobile Breakpoint ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .mobile-backdrop { display: block; }
  .mobile-fab { display: flex; }

  /* Timeline Nav → linker Slide-in-Drawer */
  .gallery-layout :deep(.timeline-nav) {
    position: fixed;
    left: 0;
    top: var(--menubar-height, 3.5rem);
    bottom: 0;
    width: 80px;
    z-index: 500;
    background: var(--surface-card) !important;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 3px 0 12px rgba(0, 0, 0, 0.2);
  }
  .gallery-layout.mobile-timeline-open :deep(.timeline-nav) {
    transform: translateX(0);
  }

  /* Details Sidebar → Bottom Sheet */
  .gallery-layout :deep(.details-sidebar) {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100% !important;
    max-height: 65vh;
    z-index: 500;
    background: var(--surface-card) !important;
    border-radius: 16px 16px 0 0;
    border-left: none;
    border-top: 1px solid var(--surface-border);
    transform: translateY(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
  }
  .gallery-layout.mobile-sidebar-open :deep(.details-sidebar) {
    transform: translateY(0);
  }

  /* Drag-Handle Indikator oben am Bottom Sheet */
  .gallery-layout :deep(.sidebar-header)::before {
    content: '';
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-300);
    margin: 0 auto 0.5rem;
  }
  .gallery-layout :deep(.sidebar-header) {
    flex-direction: column;
    padding-top: 0.5rem;
  }

  /* Subheader kompakter */
  .subheader {
    padding: 0.375rem 0.75rem;
  }
  .photos-view .title {
    font-size: 1.2rem;
  }

  /* Actions: Labels ausblenden, nur Icons */
  .subheader .actions :deep(.p-button-label) {
    display: none;
  }
  .subheader .actions :deep(.p-button) {
    padding: 0.5rem;
    min-width: 2.25rem;
  }
  .toggle-hidden label {
    display: none;
  }
}
</style>
