<script setup lang="ts">
import { ref, computed, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import ToggleSwitch from 'primevue/toggleswitch'
import InputText from 'primevue/inputtext'
import { useConfirm } from 'primevue/useconfirm'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import HeicImage from '../components/HeicImage.vue'
import FacePhotoGrid from '../components/FacePhotoGrid.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import {
  listPersons, updatePerson, mergePersons, getPersonDetails,
  ignoreFace, ignorePersonFaces, updatePhotoCuration, reindexPhoto,
  getPhotoFaces, getPhotoLandmarks, getPhotoUrl,
  type CurationStatus, type Person, type Photo, type PersonDetails,
  type Face, type LandmarkItem,
} from '../api/photos'
import { faceBoxStyle, thumbnailImageStyle } from '../utils/faceBbox'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const router = useRouter()
const route = useRoute()
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
const nameFilter = ref('')

const filteredPersons = computed(() => {
  const q = nameFilter.value.trim().toLocaleLowerCase()
  if (!q) return persons.value
  return persons.value.filter(p => p.name.toLocaleLowerCase().includes(q))
})

function personCoverUrl(person: Person) {
  if (person.cover_filename) return getPhotoUrl(person.cover_filename, 400)
  return 'https://www.primefaces.org/wp-content/uploads/2020/05/placeholder.png'
}

// Remember the most recently opened person across reloads, plus a per-person
// map of the last photo the user had selected, so reopening a person restores
// the previous scroll/selection position instead of snapping back to the top.
const LAST_PERSON_KEY = 'persons_last_selected_id'
const LAST_PHOTO_MAP_KEY = 'persons_last_photo_by_person'

function loadLastPhotoMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_PHOTO_MAP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveLastPhotoForPerson(personId: number, photoId: number) {
  const map = loadLastPhotoMap()
  map[String(personId)] = photoId
  localStorage.setItem(LAST_PHOTO_MAP_KEY, JSON.stringify(map))
}

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

// While the fullscreen overlay is open we pin a snapshot of the list so
// that hiding/unhiding the current photo (via the eye button) doesn't
// yank it out of the carousel. The pin is released when the overlay
// closes, at which point we re-map selectedIndex onto the live list.
type PersonFaceItem = { face: Face; photo: Photo }
const pinnedFullscreenItems = ref<PersonFaceItem[] | null>(null)

const effectivePhotoFaceItems = computed<PersonFaceItem[]>(() =>
  pinnedFullscreenItems.value ?? uniquePhotoFaceItems.value
)

watch(isFullscreen, (val) => {
  if (val) {
    pinnedFullscreenItems.value = uniquePhotoFaceItems.value.slice()
  } else {
    const currentPhoto = pinnedFullscreenItems.value?.[selectedIndex.value]?.photo ?? null
    pinnedFullscreenItems.value = null
    if (currentPhoto) {
      const newIdx = uniquePhotoFaceItems.value.findIndex(i => i.photo.id === currentPhoto.id)
      selectedIndex.value = newIdx >= 0 ? newIdx : (uniquePhotoFaceItems.value.length > 0 ? 0 : -1)
    }
  }
})

watch(uniquePhotoFaceItems, (items) => {
  // While pinned (fullscreen), keep selectedIndex as-is so the viewed
  // photo doesn't change underneath the user when curation status flips.
  if (pinnedFullscreenItems.value) return
  if (items.length > 0) {
    if (selectedIndex.value < 0) selectedIndex.value = 0
    else if (selectedIndex.value >= items.length) selectedIndex.value = items.length - 1
  }
})

const personPhotos = computed(() => effectivePhotoFaceItems.value.map(i => i.photo))
const selectedPhoto = computed(() => effectivePhotoFaceItems.value[selectedIndex.value]?.photo ?? null)
const selectedPersonFace = computed(() => effectivePhotoFaceItems.value[selectedIndex.value]?.face ?? null)
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
  if (photo) {
    loadSidebarData(photo.id)
    if (selectedPerson.value) saveLastPhotoForPerson(selectedPerson.value.id, photo.id)
  } else { detectedFaces.value = []; detectedLandmarks.value = [] }
})

// ── Keyboard navigation (via composable) ─────────────────────────────────────
useGalleryKeyboard({
  isBlocked: () => document.activeElement?.tagName === 'INPUT' || !selectedPerson.value,
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
  onUp() { /* no-op: nav panel removed */ },
  onDown() { /* no-op: nav panel removed */ },
  onSpace() { if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value },
  onExtra(e) {
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
    else if (e.key === 'Enter' && !isFullscreen.value) { isFullscreen.value = true; e.preventDefault() }
    else if ((e.key === 'f' || e.key === 'F') && selectedPhoto.value) { handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status); e.preventDefault() }
  },
})

// Face bbox helpers extracted to utils/faceBbox.ts

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

function navigateToPhoto(photoId: number) {
  router.push({ name: 'fotos-gallery', query: { photoId: String(photoId) } })
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
    // Honor ?personId=… (and optional ?photoId=… to jump to a specific photo).
    const queryPersonId = Number(route.query.personId)
    const queryPhotoId = Number(route.query.photoId)
    const queryPerson = queryPersonId
      ? persons.value.find(p => p.id === queryPersonId)
      : undefined

    if (queryPerson) {
      await selectPersonItem(queryPerson, queryPhotoId || undefined)
      router.replace({ query: { ...route.query, personId: undefined, photoId: undefined } })
    } else if (selectedPerson.value) {
      // After a rename/reload, keep the currently opened person on screen
      // if it still exists. Otherwise return to the grid overview.
      const still = persons.value.find(p => p.id === selectedPerson.value!.id)
      if (still) await selectPersonItem(still)
      else { selectedPerson.value = null; selectedPersonDetail.value = null }
    }
    // Fresh page load with no query and no in-memory selection → show the
    // person grid as the first level of the view.
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

async function selectPersonItem(person: Person, focusPhotoId?: number) {
  const alreadyLoaded = selectedPerson.value?.id === person.id && !!selectedPersonDetail.value
  if (!alreadyLoaded) {
    selectedPerson.value = person
    localStorage.setItem(LAST_PERSON_KEY, String(person.id))
    selectedIndex.value = -1
    detectedFaces.value = []
    detectedLandmarks.value = []
    loadingDetails.value = true
    try {
      selectedPersonDetail.value = await getPersonDetails(person.id)
    } catch (err: any) {
      error.value = err.message || 'Fehler beim Laden'
      selectedPersonDetail.value = null
    } finally {
      loadingDetails.value = false
    }
  }
  // Jump to a specific photo if requested, otherwise restore the previously
  // selected photo for this person (if any), falling back to the first.
  if (focusPhotoId) {
    const idx = uniquePhotoFaceItems.value.findIndex(i => i.photo.id === focusPhotoId)
    selectedIndex.value = idx >= 0 ? idx : (uniquePhotoFaceItems.value.length > 0 ? 0 : -1)
  } else if (!alreadyLoaded) {
    const storedPhotoId = loadLastPhotoMap()[String(person.id)]
    const restoredIdx = storedPhotoId
      ? uniquePhotoFaceItems.value.findIndex(i => i.photo.id === storedPhotoId)
      : -1
    if (restoredIdx >= 0) selectedIndex.value = restoredIdx
    else if (uniquePhotoFaceItems.value.length > 0) selectedIndex.value = 0
  }
}

// ── Grid events ───────────────────────────────────────────────────────────────
async function handlePersonSelected(person: Person) {
  await selectPersonItem(person)
}

function backToGrid() {
  selectedPerson.value = null
  selectedPersonDetail.value = null
  selectedIndex.value = -1
  detectedFaces.value = []
  detectedLandmarks.value = []
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
          <Button
            v-if="selectedPerson"
            icon="pi pi-arrow-left"
            text rounded
            aria-label="Zurück zur Übersicht"
            v-tooltip="'Zurück zur Übersicht'"
            @click="backToGrid"
          />
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

    <!-- LEVEL 1: Person grid (default) ─────────────────────────────────────── -->
    <div v-else-if="!selectedPerson" class="persons-grid-layout">
      <div class="persons-filter-bar">
        <div class="persons-filter-input">
          <i class="pi pi-search persons-filter-icon" />
          <InputText
            v-model="nameFilter"
            placeholder="Nach Namen filtern…"
            fluid
            autocomplete="off"
          />
          <Button
            v-if="nameFilter"
            class="persons-filter-clear"
            icon="pi pi-times"
            text rounded size="small"
            aria-label="Filter löschen"
            @click="nameFilter = ''"
          />
        </div>
        <span class="persons-filter-count">
          {{ filteredPersons.length }} von {{ persons.length }}
        </span>
      </div>

      <div v-if="filteredPersons.length === 0" class="info-text">
        Keine Personen passen zum Filter.
      </div>
      <div v-else class="persons-grid">
        <button
          v-for="person in filteredPersons"
          :key="person.id"
          type="button"
          class="person-card"
          @click="handlePersonSelected(person)"
        >
          <div class="person-card-avatar">
            <HeicImage
              :src="personCoverUrl(person)"
              :alt="person.name"
              objectFit="cover"
              :imageStyle="thumbnailImageStyle(person.cover_bbox)"
            />
          </div>
          <div class="person-card-info">
            <div class="person-card-name">{{ person.name }}</div>
            <div class="person-card-count">{{ person.faceCount || 0 }} Fotos</div>
          </div>
        </button>
      </div>
    </div>

    <!-- LEVEL 2: Detail view for a selected person ─────────────────────────── -->
    <div v-else class="gallery-layout">
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
          :show-navigate-to-photo="true"
          @fullscreen="isFullscreen = true"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
          @navigate-to-photo="navigateToPhoto"
        />
      </div>
    </div>

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileSidebarOpen = false"
    />


    <!-- Fullscreen overlay -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPersonPhoto"
      :nextPhoto="nextPersonPhoto"
      :canDelete="canDelete"
      :showDetailsButton="true"
      :detailsActive="false"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="isFullscreen = false; mobileSidebarOpen = true"
    >
      <!-- Face box overlay in fullscreen -->
      <div class="face-box face-box-fullscreen" :style="faceBoxStyle(selectedPersonFace?.bbox)" />
      <template #topbar-center>
        <span class="fs-person-name">{{ selectedPerson?.name }}</span>
        <Button v-if="selectedPerson" icon="pi pi-pencil" rounded text size="small" @click.stop="openRename(selectedPerson)" />
      </template>
      <template #topbar-actions>
        <Button icon="pi pi-images" rounded text severity="secondary" v-tooltip.bottom="'In Fotos anzeigen'" @click.stop="navigateToPhoto(selectedPhoto.id)" />
        <Button icon="pi pi-info-circle" rounded text severity="secondary" v-tooltip.bottom="'Details'" @click.stop="isFullscreen = false; mobileSidebarOpen = true" />
        <Button v-if="canDelete" :icon="selectedPhoto.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'" rounded text :severity="selectedPhoto.curation_status === 'hidden' ? 'danger' : 'secondary'" @click.stop="selectedPhoto.curation_status === 'hidden' ? handleRestorePhoto(selectedPhoto.id) : handleHidePhoto(selectedPhoto.id)" />
        <Button v-if="canDelete" :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" rounded text :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'" @click.stop="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)" />
        <Button v-if="selectedPersonFace" icon="pi pi-trash" rounded text severity="danger" v-tooltip.bottom="'Gesicht ignorieren'" @click.stop="handleIgnoreFace(selectedPersonFace.id)" />
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
  background: var(--p-content-background);
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

/* ── Person Grid (Level 1) ──────────────────────────────────────────────── */
.persons-grid-layout {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.persons-filter-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  position: sticky;
  top: 0;
  background: var(--p-content-background);
  padding-bottom: 0.25rem;
  z-index: 1;
}

.persons-filter-input {
  position: relative;
  flex: 1;
  max-width: 28rem;
  display: flex;
  align-items: center;
}
.persons-filter-input :deep(.p-inputtext) {
  padding-left: 2.25rem;
  padding-right: 2.25rem;
  width: 100%;
}
.persons-filter-icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--p-text-muted-color);
  pointer-events: none;
  font-size: 0.9rem;
}
.persons-filter-clear {
  position: absolute;
  right: 0.25rem;
  top: 50%;
  transform: translateY(-50%);
}
.persons-filter-count {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.persons-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}

.person-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0.5rem 0.9rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  cursor: pointer;
  color: inherit;
  text-align: center;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  outline: none;
}
.person-card:hover,
.person-card:focus-visible {
  transform: translateY(-2px);
  border-color: var(--p-primary-color);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

.person-card-avatar {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--p-content-hover-background);
}

.person-card-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  width: 100%;
  min-width: 0;
}

.person-card-name {
  font-size: 0.95rem;
  font-weight: 500;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.person-card-count {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
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

/* ── Mobile Breakpoint ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .mobile-backdrop { display: block; }

  .persons-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 0.75rem;
  }

  /* Person Sidebar Sheet → Bottom Sheet */
  .person-sidebar-sheet {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: calc(100dvh - var(--menubar-height, 3.5rem));
    z-index: 500;
    background: var(--p-content-background);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--p-content-border-color);
    transform: translateY(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .person-sidebar-sheet.is-open {
    transform: translateY(0);
  }

  /* Close-Button schwebt sticky über dem Content, kein separater Header */
  .sidebar-sheet-header {
    position: sticky;
    top: 0;
    height: 0;
    overflow: visible;
    z-index: 2;
    display: flex;
    justify-content: flex-end;
    pointer-events: none;
  }
  .sidebar-sheet-close {
    pointer-events: all;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    cursor: pointer;
    color: var(--p-text-color);
    padding: 0;
    border-radius: 50%;
    font-size: 0.85rem;
    width: 1.75rem;
    height: 1.75rem;
    margin-top: 0.5rem;
    margin-right: 0.5rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    flex-shrink: 0;
  }
  .sidebar-sheet-close:hover {
    background: var(--p-content-hover-background);
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
