<script setup lang="ts">
import { ref, computed, watch, type ComponentPublicInstance } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import ToggleSwitch from 'primevue/toggleswitch'
import InputText from 'primevue/inputtext'
import { useConfirm } from 'primevue/useconfirm'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PersonNav from '../components/PersonNav.vue'
import FacePhotoGrid from '../components/FacePhotoGrid.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import {
  listPersons, updatePerson, mergePersons, getPersonDetails,
  ignoreFace, ignorePersonFaces, updatePhotoCuration, reindexPhoto,
  getPhotoFaces, getPhotoLandmarks,
  type CurationStatus, type Person, type Photo, type PersonDetails,
  type Face, type LandmarkItem, type FaceBBox,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
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

// ── Face bbox helpers (used in fullscreen overlay) ────────────────────────────
function validBbox(bbox: FaceBBox | undefined | null): FaceBBox | null {
  if (!bbox) return null
  if (bbox.x > 1.1 || bbox.y > 1.1) return null
  return bbox
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
        selectedPersonDetail.value = null  // force reload so selectPersonItem doesn't early-return
        await ignorePersonFaces(person.id)
        await loadData()
      } catch (err: any) { error.value = err.message || 'Fehler beim Ignorieren' }
    },
  })
}

// ── Mobile drawer state ───────────────────────────────────────────────────────
const mobilePersonNavOpen = ref(false)
const mobileSidebarOpen = ref(false)

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
      <!-- LEFT: Person nav – auf Mobile als Slide-in-Drawer -->
      <div class="person-nav-drawer" :class="{ 'is-open': mobilePersonNavOpen }">
        <PersonNav
          ref="personNavRef"
          :persons="persons"
          :selectedPerson="selectedPerson"
          @update:selectedPerson="handlePersonSelected($event); mobilePersonNavOpen = false"
          @rename="handleRenameFromNav"
          @ignore="handleIgnorePerson"
        />
      </div>

      <!-- CENTER: Face photo grid -->
      <FacePhotoGrid
        :items="uniquePhotoFaceItems"
        :selectedIndex="selectedIndex"
        :loadingDetails="loadingDetails"
        :canDelete="canDelete"
        @update:selectedIndex="selectedIndex = $event"
        @open-fullscreen="isFullscreen = true"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
      />

      <!-- RIGHT: Details sidebar – auf Mobile als Bottom-Sheet -->
      <div class="person-sidebar-sheet" :class="{ 'is-open': mobileSidebarOpen }">
        <div class="sidebar-sheet-header">
          <button class="sidebar-sheet-close" @click="mobileSidebarOpen = false" aria-label="Schließen">
            <i class="pi pi-times" />
          </button>
        </div>
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
    </div>

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobilePersonNavOpen || mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobilePersonNavOpen = false; mobileSidebarOpen = false"
    />

    <!-- Mobile: Floating-Button zum Öffnen der Personenliste -->
    <button
      v-if="!loading && persons.length > 0"
      class="mobile-fab mobile-fab--persons"
      :class="{ active: mobilePersonNavOpen }"
      @click="mobilePersonNavOpen = !mobilePersonNavOpen; mobileSidebarOpen = false"
      aria-label="Personenliste"
    >
      <i class="pi pi-users" />
    </button>

    <!-- Mobile: Floating-Button zum Öffnen der Details -->
    <button
      v-if="selectedPhoto && !mobileSidebarOpen && !loading"
      class="mobile-fab mobile-fab--details"
      @click="mobileSidebarOpen = true; mobilePersonNavOpen = false"
      aria-label="Details"
    >
      <i class="pi pi-info-circle" />
    </button>

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
        <Button v-if="selectedPerson" icon="pi pi-pencil" rounded text size="small" @click.stop="openRename(selectedPerson)" />
      </template>
      <template #topbar-actions>
        <Button v-if="canDelete && selectedPhoto.curation_status === 'hidden'" icon="pi pi-eye" rounded text severity="info" @click.stop="handleRestorePhoto(selectedPhoto.id)" />
        <Button v-else-if="canDelete" icon="pi pi-eye-slash" rounded text severity="warn" @click.stop="handleHidePhoto(selectedPhoto.id)" />
        <Button v-if="canDelete" :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" rounded text :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'" @click.stop="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)" />
        <Button v-if="selectedPersonFace" icon="pi pi-trash" label="Gesicht ignorieren" rounded text severity="danger" @click.stop="handleIgnoreFace(selectedPersonFace.id)" />
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
  background: var(--p-surface-0);
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
  color: var(--p-text-muted-color);
}

.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Person Nav Drawer Wrapper ───────────────────────────────────────────── */
.person-nav-drawer {
  display: contents;
}

/* ── Person Sidebar Sheet Wrapper ────────────────────────────────────────── */
.person-sidebar-sheet {
  display: contents;
}

.sidebar-sheet-header { display: none; }
.sidebar-sheet-close { display: none; }

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

.mobile-fab--persons {
  left: 1rem;
  background: var(--p-surface-0);
  color: var(--p-primary-color);
  border: 1px solid var(--p-surface-200);
}
.mobile-fab--persons.active {
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

  /* Person Nav Drawer → linker Slide-in-Drawer */
  .person-nav-drawer {
    display: block;
    position: fixed;
    left: 0;
    top: var(--menubar-height, 3.5rem);
    bottom: 0;
    width: 200px;
    z-index: 500;
    background: var(--p-surface-0);
    border-right: 1px solid var(--p-surface-200);
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 3px 0 12px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .person-nav-drawer.is-open {
    transform: translateX(0);
  }

  /* Person Sidebar Sheet → Bottom Sheet */
  .person-sidebar-sheet {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 65vh;
    z-index: 500;
    background: var(--p-surface-0);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--p-surface-200);
    transform: translateY(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .person-sidebar-sheet.is-open {
    transform: translateY(0);
  }

  /* Sticky Header mit Schließen-Button */
  .sidebar-sheet-header {
    display: flex;
    justify-content: flex-end;
    position: sticky;
    top: 0;
    background: var(--p-surface-0);
    border-bottom: 1px solid var(--p-surface-100);
    padding: 0.3rem 0.5rem;
    z-index: 1;
  }
  .sidebar-sheet-close {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--p-text-muted-color);
    padding: 0.4rem;
    border-radius: 50%;
    font-size: 1rem;
  }
  .sidebar-sheet-close:hover {
    color: var(--p-text-color);
    background: var(--p-surface-100);
  }

  .subheader {
    padding: 0.375rem 0.75rem;
  }
  .persons-view .title {
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

/* ── Face bbox overlay (fullscreen only) ─────────────────────────────────── */
.face-box-fullscreen {
  position: absolute;
  border: 3px solid #eab308;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 2;
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
}

.fs-person-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--p-text-color);
}

/* ── Rename dialog ───────────────────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem 0; }
.rename-row { display: flex; flex-direction: column; gap: 0.4rem; }
.dialog-label { font-weight: 500; font-size: 0.9rem; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; padding-top: 0.5rem; }
</style>
