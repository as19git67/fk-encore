<script setup lang="ts">
import { ref, computed, watch, nextTick, type ComponentPublicInstance } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import ToggleSwitch from 'primevue/toggleswitch'
import InputText from 'primevue/inputtext'
import { useConfirm } from 'primevue/useconfirm'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PersonNav from '../components/PersonNav.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import {
  listPersons, updatePerson, mergePersons, getPhotoUrl, getPersonDetails,
  ignoreFace, ignorePersonFaces, updatePhotoCuration, reindexPhoto,
  getPhotoFaces, getPhotoLandmarks,
  type CurationStatus, type Person, type Photo, type PersonDetails,
  type Face, type LandmarkItem, type FaceBBox,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoLazyLoad } from '../composables/usePhotoLazyLoad'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const confirm = useConfirm()

// ── Data ──────────────────────────────────────────────────────────────────────
const persons = ref<Person[]>([])
const loading = ref(true)
const error = ref('')
const selectedPerson = ref<Person | null>(null)
const selectedPersonDetail = ref<PersonDetails | null>(null)
const loadingDetails = ref(false)
const showHidden = ref(false)
const isFullscreen = ref(false)
const selectedIndex = ref(-1)

// ── Lazy loading (via composable) ─────────────────────────────────────────────
const gridScrollRef = ref<HTMLElement | null>(null)
const { visiblePhotoIds, setupObserver } = usePhotoLazyLoad('200px')

watch(gridScrollRef, (el) => { if (el) nextTick(() => setupObserver(el)) })

// ── Person face / photo items ─────────────────────────────────────────────────
const personFaceItems = computed(() => {
  if (!selectedPersonDetail.value) return []
  return selectedPersonDetail.value.faces
    .filter(f => !!f.photo && !f.ignored && (showHidden.value || f.photo.curation_status !== 'hidden'))
    .map(f => ({ face: f, photo: f.photo as Photo }))
})

const uniquePhotoFaceItems = computed(() => {
  const seen = new Set<number>()
  return personFaceItems.value.filter(item => {
    if (seen.has(item.photo.id)) return false
    seen.add(item.photo.id)
    return true
  })
})

watch(uniquePhotoFaceItems, (items) => {
  if (items.length > 0) {
    if (selectedIndex.value < 0) selectedIndex.value = 0
    else if (selectedIndex.value >= items.length) selectedIndex.value = items.length - 1
  }
  void nextTick(() => { if (gridScrollRef.value) setupObserver(gridScrollRef.value) })
})

const allUniquePhotoFaceItems = computed(() => {
  const seen = new Set<number>()
  return (selectedPersonDetail.value?.faces ?? [])
    .filter(f => !!f.photo)
    .map(f => ({ face: f, photo: f.photo as Photo }))
    .filter(item => { if (seen.has(item.photo.id)) return false; seen.add(item.photo.id); return true })
})

const personPhotos = computed(() => allUniquePhotoFaceItems.value.map(i => i.photo))
const selectedPhoto = computed(() => uniquePhotoFaceItems.value[selectedIndex.value]?.photo ?? null)
const selectedPersonFace = computed(() => allUniquePhotoFaceItems.value[selectedIndex.value]?.face ?? null)
const prevPersonPhoto = computed(() => selectedIndex.value > 0 ? personPhotos.value[selectedIndex.value - 1] ?? null : null)
const nextPersonPhoto = computed(() => selectedIndex.value < personPhotos.value.length - 1 ? personPhotos.value[selectedIndex.value + 1] ?? null : null)

// ── Sidebar state ─────────────────────────────────────────────────────────────
const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)

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

watch(selectedPhoto, (photo) => {
  if (photo) loadSidebarData(photo.id)
  else { detectedFaces.value = []; detectedLandmarks.value = [] }
})

// ── Keyboard navigation (via composable) ─────────────────────────────────────
const personNavRef = ref<InstanceType<typeof PersonNav> | null>(null)

useGalleryKeyboard({
  isBlocked: () => document.activeElement?.tagName === 'INPUT',
  onLeft() {
    if (isFullscreen.value) { if (selectedIndex.value > 0) selectedIndex.value--; return }
    const total = uniquePhotoFaceItems.value.length
    if (total === 0) return
    selectedIndex.value = selectedIndex.value > 0 ? selectedIndex.value - 1 : total - 1
  },
  onRight() {
    if (isFullscreen.value) { if (selectedIndex.value < personPhotos.value.length - 1) selectedIndex.value++; return }
    const total = uniquePhotoFaceItems.value.length
    if (total === 0) return
    selectedIndex.value = selectedIndex.value + 1 < total ? selectedIndex.value + 1 : 0
  },
  onUp() { personNavRef.value?.navigateUp() },
  onDown() { personNavRef.value?.navigateDown() },
  onSpace() { if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value },
  onExtra(e) {
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
    else if (e.key === 'Enter' && !isFullscreen.value) { isFullscreen.value = true; e.preventDefault() }
  },
})

// ── Face bbox helpers ─────────────────────────────────────────────────────────
function validBbox(bbox: FaceBBox | undefined | null): FaceBBox | null {
  if (!bbox) return null
  if (bbox.x > 1.1 || bbox.y > 1.1) return null
  return bbox
}

function thumbnailZoom(bbox: FaceBBox | undefined | null): number {
  const b = validBbox(bbox)
  if (!b) return 1
  return Math.min(4, Math.max(1.5, 0.4 / Math.max(b.width, b.height)))
}

function thumbnailImageStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return {}
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const zoom = thumbnailZoom(bbox)
  return {
    objectPosition: `${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%`,
    transform: `scale(${zoom.toFixed(2)}) translate(${((0.5 - cx) * 100).toFixed(1)}%, ${((0.5 - cy) * 100).toFixed(1)}%)`,
    transformOrigin: '50% 50%',
  }
}

function faceBoxStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return { display: 'none' }
  return {
    left: `${(b.x * 100).toFixed(2)}%`,
    top: `${(b.y * 100).toFixed(2)}%`,
    width: `${(b.width * 100).toFixed(2)}%`,
    height: `${(b.height * 100).toFixed(2)}%`,
  }
}

function thumbnailSrc(filename: string, bbox: FaceBBox | undefined | null): string {
  const zoom = thumbnailZoom(bbox)
  const width = zoom >= 2 ? 800 : zoom >= 1.5 ? 600 : 400
  return getPhotoUrl(filename, width)
}

// ── Curation ──────────────────────────────────────────────────────────────────
function setPhotoStatus(id: number, status: CurationStatus) {
  if (!selectedPersonDetail.value) return
  selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.map(f =>
    f.photo?.id === id ? { ...f, photo: { ...f.photo!, curation_status: status } } : f
  )
}

async function handleHidePhoto(id: number) {
  try { await updatePhotoCuration(id, 'hidden'); setPhotoStatus(id, 'hidden') }
  catch (err: any) { error.value = err.message || 'Fehler beim Ausblenden' }
}

async function handleRestorePhoto(id: number) {
  try { await updatePhotoCuration(id, 'visible'); setPhotoStatus(id, 'visible') }
  catch (err: any) { error.value = err.message || 'Fehler beim Wiederherstellen' }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  setPhotoStatus(id, newStatus)
  try { await updatePhotoCuration(id, newStatus) }
  catch (err: any) { setPhotoStatus(id, currentStatus); error.value = err.message || 'Fehler' }
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try {
    await ignoreFace(faceId)
    detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId)
    if (selectedPersonDetail.value) {
      selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.filter(f => f.id !== faceId)
    }
  } catch (err: any) { error.value = err.message || 'Fehler beim Ignorieren des Gesichts' }
}

async function handleIgnoreFace(faceId: number) {
  confirm.require({
    message: 'Dieses Gesicht wirklich ignorieren?',
    header: 'Bestätigung',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Ignorieren', severity: 'danger' },
    accept: async () => {
      try {
        await ignoreFace(faceId)
        if (selectedPersonDetail.value) {
          selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.filter(f => f.id !== faceId)
          if (selectedIndex.value >= uniquePhotoFaceItems.value.length) {
            selectedIndex.value = uniquePhotoFaceItems.value.length - 1
          }
        }
      } catch (err: any) { error.value = err.message || 'Fehler beim Ignorieren' }
    },
  })
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try { await reindexPhoto(selectedPhoto.value.id); await loadSidebarData(selectedPhoto.value.id) }
  catch (err: any) { error.value = err.message || 'Fehler beim Neu-Erkennen' }
  finally { reindexingPhoto.value = false }
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await listPersons()
    persons.value = res.persons
      .filter(p => Number(p.faceCount || 0) > 1)
      .sort((a, b) => {
        if (a.name === 'Unbenannt' && b.name !== 'Unbenannt') return 1
        if (a.name !== 'Unbenannt' && b.name === 'Unbenannt') return -1
        return Number(b.faceCount || 0) - Number(a.faceCount || 0)
      })
    if (selectedPerson.value) {
      const still = persons.value.find(p => p.id === selectedPerson.value!.id)
      if (still) await selectPersonItem(still)
      else if (persons.value.length > 0) await selectPersonItem(persons.value[0]!)
      else { selectedPerson.value = null; selectedPersonDetail.value = null }
    } else if (persons.value.length > 0) {
      await selectPersonItem(persons.value[0]!)
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

async function selectPersonItem(person: Person) {
  if (selectedPerson.value?.id === person.id && selectedPersonDetail.value) return
  selectedPerson.value = person
  selectedIndex.value = -1
  detectedFaces.value = []
  detectedLandmarks.value = []
  loadingDetails.value = true
  try {
    selectedPersonDetail.value = await getPersonDetails(person.id)
    if (uniquePhotoFaceItems.value.length > 0) selectedIndex.value = 0
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
    selectedPersonDetail.value = null
  } finally {
    loadingDetails.value = false
  }
}

// ── PersonNav events ──────────────────────────────────────────────────────────
async function handlePersonSelected(person: Person) {
  await selectPersonItem(person)
}

// ── Rename ────────────────────────────────────────────────────────────────────
const showRenameDialog = ref(false)
const personToRename = ref<Person | null>(null)
const newName = ref('')
const renameInputRef = ref<ComponentPublicInstance | null>(null)

const duplicateNamePerson = computed(() => {
  if (!personToRename.value) return null
  const normalized = newName.value.trim().toLocaleLowerCase()
  if (!normalized) return null
  return persons.value.find(p => p.id !== personToRename.value!.id && p.name.trim().toLocaleLowerCase() === normalized) ?? null
})

const renameWillMerge = computed(() => !!duplicateNamePerson.value)

function openRename(person: Person) {
  personToRename.value = person
  newName.value = person.name === 'Unbenannt' ? '' : person.name
  showRenameDialog.value = true
}

function onRenameDialogShow() {
  const input = (renameInputRef.value as any)?.$el || renameInputRef.value
  if (input instanceof HTMLInputElement) { input.focus(); input.select() }
  else if (input && typeof input.focus === 'function') { input.focus(); if (typeof input.select === 'function') input.select() }
}

async function handleRenameFromNav(person: Person) {
  // Person comes in with the new name set by PersonNav inline rename
  personToRename.value = persons.value.find(p => p.id === person.id) ?? null
  newName.value = person.name
  await handleRename()
}

async function handleRename(): Promise<boolean> {
  if (!personToRename.value) return false
  const sourcePersonId = personToRename.value.id
  const trimmedName = newName.value.trim()
  if (!trimmedName || trimmedName.toLowerCase() === 'unbenannt') return false
  const mergeCandidate = duplicateNamePerson.value
  try {
    await updatePerson(sourcePersonId, trimmedName)
    if (mergeCandidate) await mergePersons([mergeCandidate.id], sourcePersonId)
    showRenameDialog.value = false
    await loadData()
    if (selectedPersonDetail.value?.id === sourcePersonId) selectedPersonDetail.value.name = trimmedName
    return true
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Umbenennen'
    return false
  }
}

async function handleIgnorePerson(person: Person) {
  const currentIdx = persons.value.findIndex(p => p.id === person.id)
  const fallback = persons.value[currentIdx + 1] ?? persons.value[currentIdx - 1] ?? null
  confirm.require({
    message: `Person "${person.name}" und alle ihre Gesichtserkennungen dauerhaft ignorieren?`,
    header: 'Bestätigung',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Ignorieren', severity: 'danger' },
    accept: async () => {
      try {
        if (fallback) selectedPerson.value = fallback
        await ignorePersonFaces(person.id)
        await loadData()
      } catch (err: any) { error.value = err.message || 'Fehler beim Ignorieren' }
    },
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadData()
serviceHealth.startPolling()

import { onUnmounted } from 'vue'
onUnmounted(() => serviceHealth.stopPolling())
</script>

<template>
  <div class="persons-view">
    <ServiceStatusBar />

    <div class="subheader">
      <div class="header">
        <div class="header-left">
          <h1 class="title">{{ selectedPersonDetail ? selectedPersonDetail.name : 'Personen' }}</h1>
        </div>
        <div class="actions">
          <div v-if="selectedPersonDetail" class="toggle-hidden">
            <label for="showHiddenPersons" class="text-sm">Ausgeblendete</label>
            <ToggleSwitch v-model="showHidden" inputId="showHiddenPersons" />
          </div>
          <template v-if="selectedPerson">
            <Button icon="pi pi-pencil" label="Umbenennen" outlined @click="openRename(selectedPerson)" />
            <Button icon="pi pi-trash" label="Ignorieren" outlined severity="danger"
              v-tooltip="'Person und alle Gesichter dauerhaft ignorieren'"
              @click="handleIgnorePerson(selectedPerson)" />
          </template>
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && persons.length === 0" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Personen werden geladen…
    </div>
    <div v-else-if="!loading && persons.length === 0" class="info-text">Keine Personen erkannt.</div>

    <div v-else class="gallery-layout">
      <!-- LEFT: Person nav -->
      <PersonNav
        ref="personNavRef"
        :persons="persons"
        :selectedPerson="selectedPerson"
        @update:selectedPerson="handlePersonSelected"
        @rename="handleRenameFromNav"
        @ignore="handleIgnorePerson"
      />

      <!-- CENTER: Face photo grid (face-specific rendering, stays here) -->
      <div class="photo-grid-scroll" ref="gridScrollRef">
        <div v-if="loadingDetails" class="info-text"><i class="pi pi-spin pi-spinner" /> Lade…</div>
        <div v-else-if="uniquePhotoFaceItems.length === 0" class="info-text">Keine Fotos.</div>
        <div v-else class="photo-grid">
          <div
            v-for="(item, idx) in uniquePhotoFaceItems"
            :key="item.photo.id"
            :data-photo-id="item.photo.id"
            class="photo-item"
            tabindex="0"
            :class="{
              selected: idx === selectedIndex,
              'is-hidden': item.photo.curation_status === 'hidden',
              'is-favorite': item.photo.curation_status === 'favorite',
            }"
            @click="selectedIndex = idx"
            @dblclick="isFullscreen = true"
          >
            <div class="photo-thumb">
              <HeicImage
                v-if="visiblePhotoIds.has(item.photo.id)"
                :src="thumbnailSrc(item.photo.filename, item.face.bbox)"
                :alt="item.photo.original_name"
                objectFit="cover"
                :imageStyle="thumbnailImageStyle(item.face.bbox)"
              >
                <div class="face-box" :style="faceBoxStyle(item.face.bbox)" />
              </HeicImage>
            </div>
            <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge" />
            <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-eye-slash hidden-badge" />
            <div class="photo-info">
              <span class="name">{{ item.photo.original_name }}</span>
              <div class="photo-actions">
                <Button v-if="canDelete && item.photo.curation_status === 'hidden'" size="small" icon="pi pi-eye" severity="info" text rounded @click.stop="handleRestorePhoto(item.photo.id)" />
                <Button v-if="canDelete && item.photo.curation_status !== 'hidden'" size="small" :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'" text rounded @click.stop="handleToggleFavorite(item.photo.id, item.photo.curation_status)" />
                <Button v-if="canDelete && item.photo.curation_status !== 'hidden'" size="small" icon="pi pi-eye-slash" severity="danger" text rounded @click.stop="handleHidePhoto(item.photo.id)" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Details sidebar -->
      <PhotoDetailSidebar
        v-if="selectedPhoto"
        :photo="selectedPhoto"
        :faces="detectedFaces"
        :loading-faces="loadingFaces"
        :landmarks="detectedLandmarks"
        :loading-landmarks="loadingLandmarks"
        :persons="persons"
        :can-delete="canDelete"
        :can-upload="false"
        :reindexing-photo="reindexingPhoto"
        :is-editing-date="false"
        :updating-date="false"
        :show-persons="auth.hasPermission('people.view')"
        :limit-albums-shown="true"
        :face-service-available="serviceHealth.faceServiceAvailable"
        @fullscreen="isFullscreen = true"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
        @ignore-face="handleIgnoreFaceInSidebar"
        @reindex="handleReindexPhoto"
      />
    </div>

    <!-- Fullscreen overlay -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPersonPhoto"
      :nextPhoto="nextPersonPhoto"
      :canDelete="canDelete"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
    >
      <!-- Face box overlay in fullscreen -->
      <div class="face-box face-box-fullscreen" :style="faceBoxStyle(selectedPersonFace?.bbox)" />
      <template #topbar-center>
        <span class="fs-person-name">{{ selectedPerson?.name }}</span>
        <Button v-if="selectedPerson" icon="pi pi-pencil" class="fs-topbar-btn" rounded text size="small" @click.stop="openRename(selectedPerson)" />
      </template>
      <template #topbar-actions>
        <Button v-if="canDelete && selectedPhoto.curation_status === 'hidden'" icon="pi pi-eye" class="fs-topbar-btn" rounded text severity="info" @click.stop="handleRestorePhoto(selectedPhoto.id)" />
        <Button v-else-if="canDelete" icon="pi pi-eye-slash" class="fs-topbar-btn" rounded text severity="warn" @click.stop="handleHidePhoto(selectedPhoto.id)" />
        <Button v-if="canDelete" :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" class="fs-topbar-btn" rounded text :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'" @click.stop="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)" />
        <Button v-if="selectedPersonFace" icon="pi pi-trash" label="Gesicht ignorieren" class="fs-topbar-btn" rounded text severity="danger" @click.stop="handleIgnoreFace(selectedPersonFace.id)" />
      </template>
    </FullscreenOverlay>

    <!-- Rename dialog -->
    <Dialog v-model:visible="showRenameDialog" header="Person umbenennen" :modal="true" style="width: min(100%, 28rem)" @show="onRenameDialogShow">
      <div class="dialog-body">
        <div class="rename-row">
          <label for="rename-name" class="dialog-label">Name</label>
          <InputText ref="renameInputRef" id="rename-name" v-model="newName" fluid autocomplete="off" @keyup.enter="handleRename" autofocus />
        </div>
        <Message v-if="newName.trim().toLowerCase() === 'unbenannt'" severity="error" :closable="false">
          Der Name "Unbenannt" ist nicht zulässig.
        </Message>
        <Message v-if="renameWillMerge && newName.trim().toLowerCase() !== 'unbenannt'" severity="warn" :closable="false">
          Eine andere Person heißt bereits <b>{{ duplicateNamePerson?.name }}</b>. Beim Speichern werden beide zusammengeführt.
        </Message>
        <div class="dialog-actions">
          <Button label="Abbrechen" text @click="showRenameDialog = false" />
          <Button :label="renameWillMerge ? 'Zusammenführen' : 'Speichern'" :icon="renameWillMerge ? 'pi pi-clone' : 'pi pi-check'" @click="handleRename" :disabled="!newName.trim() || newName.trim().toLowerCase() === 'unbenannt'" />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.persons-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

.persons-view .title {
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

.header-left { display: flex; align-items: center; gap: 0.5rem; }

.actions { display: flex; gap: 0.5rem; align-items: center; }

.toggle-hidden { display: flex; align-items: center; gap: 0.5rem; }

.info-text {
  display: flex;
  justify-content: center;
  gap: 0.5em;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}

.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Center: face photo grid ─────────────────────────────────────────────── */
.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1rem;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.photo-item {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  cursor: pointer;
  transition: transform 0.2s;
  border: 4px solid transparent;
  outline: none;
}

.photo-item:hover { transform: scale(1.02); }

.photo-item:focus-visible {
  outline: 2px solid var(--p-primary-300);
  outline-offset: -2px;
}

.photo-item.selected {
  border-color: var(--p-primary-color);
  transform: scale(1.05);
  box-shadow: 0 0 15px var(--p-primary-color);
  z-index: 10;
}

.photo-thumb {
  width: 100%;
  height: 200px;
  background: var(--surface-ground);
  overflow: hidden;
}

.photo-thumb :deep(.heic-image-container) { width: 100%; height: 100%; }

.photo-info {
  padding: 0.25rem 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(4px);
  position: absolute;
  bottom: 0; left: 0; right: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.photo-item:hover .photo-info,
.photo-item.selected .photo-info,
.photo-item:focus-within .photo-info { opacity: 1; }

.photo-info .name {
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  color: white;
}

.photo-actions { display: flex; gap: 0; }

.photo-item.is-hidden { opacity: 0.35; }
.photo-item.is-hidden:hover { opacity: 0.7; }
.photo-item.is-favorite { border-color: var(--p-yellow-500); }

.favorite-badge, .hidden-badge {
  position: absolute;
  top: 8px; right: 8px;
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}
.favorite-badge { color: var(--p-yellow-500); }
.hidden-badge { color: white; }

/* ── Face bbox overlay ───────────────────────────────────────────────────── */
.face-box {
  position: absolute;
  border: 2px solid #eab308;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 2;
  border-radius: 2px;
}

.face-box-fullscreen {
  border-width: 3px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
}

.fs-person-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-color);
}

.fs-topbar-btn { color: var(--text-color) !important; }

/* ── Rename dialog ───────────────────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem 0; }
.rename-row { display: flex; flex-direction: column; gap: 0.4rem; }
.dialog-label { font-weight: 500; font-size: 0.9rem; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; padding-top: 0.5rem; }
</style>
