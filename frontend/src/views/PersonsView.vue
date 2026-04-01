<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch, type ComponentPublicInstance } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import ToggleSwitch from 'primevue/toggleswitch'
import { useConfirm } from 'primevue/useconfirm'
import InputText from 'primevue/inputtext'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import {
  listPersons, updatePerson, mergePersons, getPhotoUrl, getPersonDetails,
  ignoreFace, ignorePersonFaces, updatePhotoCuration, reindexPhoto,
  getPhotoFaces, getPhotoLandmarks,
  type CurationStatus, type Person, type Photo, type PersonDetails,
  type Face, type LandmarkItem, type FaceBBox,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const canDelete = computed(() => auth.hasPermission('photos.delete'))

const persons = ref<Person[]>([])
const loading = ref(true)
const error = ref('')

// ── Selected person ───────────────────────────────────────────────────────────
const selectedPerson = ref<Person | null>(null)
const selectedPersonDetail = ref<PersonDetails | null>(null)
const loadingDetails = ref(false)
const showHidden = ref(false)

const isFullscreen = ref(false)
const selectedIndex = ref(-1)

// ── Lazy loading via IntersectionObserver ────────────────────────────────────
const gridScrollRef = ref<HTMLElement | null>(null)
const visiblePhotoIds = ref(new Set<number>())
let photoObserver: IntersectionObserver | null = null
let debounceTimeout: ReturnType<typeof setTimeout> | null = null

const pendingVisibleIds = new Set<number>()

function applyVisiblePhotos() {
  visiblePhotoIds.value = new Set(pendingVisibleIds)
}

function setupPhotoObserver(options?: { resetScroll?: boolean }) {
  photoObserver?.disconnect()
  visiblePhotoIds.value = new Set()
  pendingVisibleIds.clear()
  if (debounceTimeout) clearTimeout(debounceTimeout)

  if (!gridScrollRef.value) return
  if (options?.resetScroll !== false) {
    gridScrollRef.value.scrollTop = 0
  }

  photoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.photoId)
        if (entry.isIntersecting) {
          pendingVisibleIds.add(id)
        } else {
          pendingVisibleIds.delete(id)
        }
      }

      if (debounceTimeout) clearTimeout(debounceTimeout)
      debounceTimeout = setTimeout(() => {
        applyVisiblePhotos()
        debounceTimeout = null
      }, 150)
    },
    { root: gridScrollRef.value, rootMargin: '200px' }
  )
  for (const el of gridScrollRef.value.querySelectorAll('[data-photo-id]')) {
    photoObserver.observe(el)
  }
}

watch(gridScrollRef, () => nextTick(() => setupPhotoObserver()))

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

// Ensure selectedIndex is always valid when photos are available
watch(uniquePhotoFaceItems, (items) => {
  if (items.length > 0) {
    if (selectedIndex.value < 0) selectedIndex.value = 0
    else if (selectedIndex.value >= items.length) selectedIndex.value = items.length - 1
  }
  void nextTick(() => setupPhotoObserver({ resetScroll: false }))
})

const allUniquePhotoFaceItems = computed(() => {
  const seen = new Set<number>()
  return (selectedPersonDetail.value?.faces ?? [])
    .filter(f => !!f.photo)
    .map(f => ({ face: f, photo: f.photo as Photo }))
    .filter(item => {
      if (seen.has(item.photo.id)) return false
      seen.add(item.photo.id)
      return true
    })
})

const personPhotos = computed(() => allUniquePhotoFaceItems.value.map(item => item.photo))

const selectedPhoto = computed(() => {
  if (selectedIndex.value < 0) return null
  return uniquePhotoFaceItems.value[selectedIndex.value]?.photo ?? null
})

const selectedPersonFace = computed(() => {
  if (selectedIndex.value < 0) return null
  return allUniquePhotoFaceItems.value[selectedIndex.value]?.face ?? null
})

const prevPersonPhoto = computed(() => {
  if (selectedIndex.value <= 0) return null
  return personPhotos.value[selectedIndex.value - 1] ?? null
})

const nextPersonPhoto = computed(() => {
  if (selectedIndex.value < 0 || selectedIndex.value >= personPhotos.value.length - 1) return null
  return personPhotos.value[selectedIndex.value + 1] ?? null
})

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

watch(selectedPhoto, (photo) => {
  if (photo) loadSidebarData(photo.id)
  else { detectedFaces.value = []; detectedLandmarks.value = [] }
})

async function handleIgnoreFaceInSidebar(faceId: number) {
  try {
    await ignoreFace(faceId)
    detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId)
    if (selectedPersonDetail.value) {
      selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.filter(f => f.id !== faceId)
    }
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

// ── Curation ──────────────────────────────────────────────────────────────────
function setPhotoStatus(id: number, status: CurationStatus) {
  if (!selectedPersonDetail.value) return
  selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.map(f =>
    f.photo?.id === id ? { ...f, photo: { ...f.photo!, curation_status: status } } : f
  )
}

async function handleHidePhoto(id: number) {
  try {
    // Use the curation API (soft-hide) instead of the owner-only delete endpoint
    await updatePhotoCuration(id, 'hidden')
    setPhotoStatus(id, 'hidden')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Ausblenden'
  }
}

async function handleRestorePhoto(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    setPhotoStatus(id, 'visible')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Wiederherstellen'
  }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  setPhotoStatus(id, newStatus)
  try {
    await updatePhotoCuration(id, newStatus)
  } catch (err: any) {
    setPhotoStatus(id, currentStatus)
    error.value = err.message || 'Fehler'
  }
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
      if (still) {
        await selectPerson(still)
        await nextTick()
        const idx = persons.value.findIndex(p => p.id === still.id)
        getPersonEntries()[Math.max(0, idx)]?.focus()
      } else if (persons.value.length > 0) {
        await selectPerson(persons.value[0]!)
        await nextTick()
        getPersonEntries()[0]?.focus()
      } else {
        selectedPerson.value = null
        selectedPersonDetail.value = null
      }
    } else if (persons.value.length > 0) {
      await selectPerson(persons.value[0]!)
      await nextTick()
      getPersonEntries()[0]?.focus()
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

async function selectPerson(person: Person) {
  if (selectedPerson.value?.id === person.id && selectedPersonDetail.value) return
  selectedPerson.value = person
  selectedIndex.value = -1
  detectedFaces.value = []
  detectedLandmarks.value = []
  loadingDetails.value = true
  try {
    selectedPersonDetail.value = await getPersonDetails(person.id)
    // Always select first photo — never leave grid without a selection
    if (uniquePhotoFaceItems.value.length > 0) {
      selectedIndex.value = 0
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
    selectedPersonDetail.value = null
  } finally {
    loadingDetails.value = false
  }
}

// ── Rename ────────────────────────────────────────────────────────────────────
const showRenameDialog = ref(false)
const personToRename = ref<Person | null>(null)
const newName = ref('')
const inlineRenamePersonId = ref<number | null>(null)
const inlineRenameValue = ref('')
const inlineRenameSaving = ref(false)
const inlineRenameInputRef = ref<HTMLInputElement | null>(null)
const renameInputRef = ref<ComponentPublicInstance | null>(null)
const confirm = useConfirm()

function setInlineRenameInputRef(el: Element | ComponentPublicInstance | null) {
  inlineRenameInputRef.value = el instanceof HTMLInputElement ? el : null
}

function normalizePersonName(name: string) {
  return name.trim().toLocaleLowerCase()
}

const duplicateNamePerson = computed(() => {
  if (!personToRename.value) return null
  const normalized = normalizePersonName(newName.value)
  if (!normalized) return null
  return persons.value.find(
    p => p.id !== personToRename.value!.id && normalizePersonName(p.name) === normalized
  ) ?? null
})

const renameWillMerge = computed(() => !!duplicateNamePerson.value)

function openRename(person: Person) {
  personToRename.value = person
  newName.value = person.name === 'Unbenannt' ? '' : person.name
  showRenameDialog.value = true
}

function onRenameDialogShow() {
  // Focus the input in the dialog
  const input = (renameInputRef.value as any)?.$el || renameInputRef.value
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  } else if (input && typeof input.focus === 'function') {
    input.focus()
    if (typeof input.select === 'function') input.select()
  }
}

function startInlineRename(person: Person) {
  if (inlineRenameSaving.value) return
  inlineRenamePersonId.value = person.id
  inlineRenameValue.value = person.name === 'Unbenannt' ? '' : person.name
  void nextTick(() => {
    inlineRenameInputRef.value?.focus()
    inlineRenameInputRef.value?.select()
  })
}

function cancelInlineRename() {
  if (inlineRenameSaving.value) return
  inlineRenamePersonId.value = null
  inlineRenameValue.value = ''
}

async function submitInlineRename() {
  if (inlineRenamePersonId.value == null || inlineRenameSaving.value) return
  const person = persons.value.find(p => p.id === inlineRenamePersonId.value)
  if (!person) { cancelInlineRename(); return }
  const trimmedName = inlineRenameValue.value.trim()
  if (!trimmedName || trimmedName.toLowerCase() === 'unbenannt') return
  if (trimmedName === person.name.trim()) { cancelInlineRename(); return }
  personToRename.value = person
  newName.value = inlineRenameValue.value
  inlineRenameSaving.value = true
  const renamed = await handleRename()
  inlineRenameSaving.value = false
  if (renamed) { inlineRenamePersonId.value = null; inlineRenameValue.value = '' }
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

// ── Ignore ────────────────────────────────────────────────────────────────────
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
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Ignorieren'
      }
    }
  })
}

async function handleIgnorePerson(person: Person) {
  // Pre-select the next (or previous) person so loadData restores the right selection
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
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Ignorieren'
      }
    }
  })
}

// ── Person cover helpers ──────────────────────────────────────────────────────
function getCoverUrl(person: Person) {
  if (person.cover_filename) return getPhotoUrl(person.cover_filename, 200)
  return 'https://www.primefaces.org/wp-content/uploads/2020/05/placeholder.png'
}

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

// ── Keyboard navigation ───────────────────────────────────────────────────────
function getPersonEntries(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.person-entry[tabindex]'))
}

function getPhotoElements(): HTMLElement[] {
  return Array.from(gridScrollRef.value?.querySelectorAll<HTMLElement>('[data-photo-id]') ?? [])
}

async function onEntryKeydown(e: KeyboardEvent, person: Person, idx: number) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (persons.value[idx + 1]) {
      getPersonEntries()[idx + 1]?.focus()
      void selectPerson(persons.value[idx + 1]!)
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (persons.value[idx - 1]) {
      getPersonEntries()[idx - 1]?.focus()
      void selectPerson(persons.value[idx - 1]!)
    }
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    const total = uniquePhotoFaceItems.value.length
    if (total === 0) return
    const next = selectedIndex.value + 1 < total ? selectedIndex.value + 1 : 0
    selectedIndex.value = next
    await nextTick()
    getPhotoElements()[next]?.focus()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    const total = uniquePhotoFaceItems.value.length
    if (total === 0) return
    const prev = selectedIndex.value - 1 >= 0 ? selectedIndex.value - 1 : total - 1
    selectedIndex.value = prev
    await nextTick()
    getPhotoElements()[prev]?.focus()
  } else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === e.currentTarget) {
    e.preventDefault()
    // Activate person (load if not already selected) and move focus to first thumbnail
    if (selectedPerson.value?.id !== person.id) {
      await selectPerson(person)
    }
    await nextTick()
    const photoEls = getPhotoElements()
    const targetIdx = selectedIndex.value >= 0 ? selectedIndex.value : 0
    photoEls[targetIdx]?.focus()
  }
}

function onPhotoKeydown(e: KeyboardEvent, idx: number) {
  const total = uniquePhotoFaceItems.value.length
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.stopPropagation()
    selectedIndex.value = idx
    isFullscreen.value = !isFullscreen.value
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    const next = idx + 1 < total ? idx + 1 : 0
    selectedIndex.value = next
    void nextTick(() => getPhotoElements()[next]?.focus())
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    const prev = idx - 1 >= 0 ? idx - 1 : total - 1
    selectedIndex.value = prev
    void nextTick(() => getPhotoElements()[prev]?.focus())
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    const personIdx = persons.value.findIndex(p => p.id === selectedPerson.value?.id)
    if (personIdx >= 0 && persons.value[personIdx + 1]) {
      void selectPerson(persons.value[personIdx + 1]!)
      void nextTick(() => getPersonEntries()[personIdx + 1]?.focus())
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const personIdx = persons.value.findIndex(p => p.id === selectedPerson.value?.id)
    if (personIdx > 0 && persons.value[personIdx - 1]) {
      void selectPerson(persons.value[personIdx - 1]!)
      void nextTick(() => getPersonEntries()[personIdx - 1]?.focus())
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (document.activeElement?.tagName === 'INPUT') return
  if (isFullscreen.value) {
    if (e.key === 'ArrowRight' && selectedIndex.value < personPhotos.value.length - 1) { selectedIndex.value++; e.preventDefault() }
    else if (e.key === 'ArrowLeft' && selectedIndex.value > 0) { selectedIndex.value--; e.preventDefault() }
    else if (e.key === 'Escape' || e.key === ' ') { isFullscreen.value = false; e.preventDefault() }
  }
}

onMounted(() => {
  loadData()
  window.addEventListener('keydown', handleKeydown)
  serviceHealth.startPolling()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  photoObserver?.disconnect()
  serviceHealth.stopPolling()
})
</script>

<template>
  <div class="persons-view">
    <!-- Subheader -->
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
            <Button icon="pi pi-trash" label="Ignorieren" outlined severity="danger" @click="handleIgnorePerson(selectedPerson)" v-tooltip="'Person und alle Gesichter dauerhaft ignorieren'" />
          </template>
        </div>
      </div>
    </div>

    <ServiceStatusBar />

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && persons.length === 0" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Personen werden geladen…
    </div>
    <div v-else-if="!loading && persons.length === 0" class="info-text">Keine Personen erkannt.</div>

    <!-- Main layout: person panel + photo grid + sidebar -->
    <div v-else class="gallery-layout">

      <!-- LEFT: Person list panel -->
      <nav class="person-panel">
        <div
          v-for="(person, idx) in persons"
          :key="person.id"
          class="person-entry"
          tabindex="0"
          :class="{ active: selectedPerson?.id === person.id }"
          @click="selectPerson(person)"
          @keydown="onEntryKeydown($event, person, idx)"
        >
          <div class="person-avatar">
            <HeicImage
              :src="getCoverUrl(person)"
              :alt="person.name"
              objectFit="cover"
              :imageStyle="thumbnailImageStyle(person.cover_bbox)"
            />
          </div>
          <div class="person-entry-info">
            <div v-if="inlineRenamePersonId === person.id" class="rename-inline" @click.stop>
              <input
                :ref="setInlineRenameInputRef"
                v-model="inlineRenameValue"
                class="rename-input"
                type="text"
                autocomplete="off"
                :disabled="inlineRenameSaving"
                @keydown.enter.prevent.stop="submitInlineRename"
                @keydown.esc.prevent.stop="cancelInlineRename"
              />
              <Button icon="pi pi-check" text rounded size="small" :disabled="inlineRenameSaving || !inlineRenameValue.trim() || inlineRenameValue.trim().toLowerCase() === 'unbenannt'" @click.stop="submitInlineRename" />
              <Button icon="pi pi-times" text rounded size="small" :disabled="inlineRenameSaving" @click.stop="cancelInlineRename" />
            </div>
            <template v-else>
              <span class="person-entry-name">{{ person.name }}</span>
              <span class="person-entry-count">{{ person.faceCount }} Fotos</span>
            </template>
          </div>
          <Button
            v-if="inlineRenamePersonId !== person.id"
            class="pencil-btn"
            icon="pi pi-pencil"
            text rounded size="small"
            tabindex="-1"
            @click.stop="startInlineRename(person)"
          />
        </div>
      </nav>

      <!-- CENTER: Photo grid for selected person -->
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
            @keydown="onPhotoKeydown($event, idx)"
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
    <div v-if="isFullscreen && selectedPhoto" class="fullscreen-overlay" @click="isFullscreen = false">
      <div style="display: none">
        <HeicImage v-if="prevPersonPhoto" :src="getPhotoUrl(prevPersonPhoto.filename)" />
        <HeicImage v-if="nextPersonPhoto" :src="getPhotoUrl(nextPersonPhoto.filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(selectedPhoto.filename)" :alt="selectedPhoto.original_name" objectFit="contain">
          <div class="face-box face-box-fullscreen" :style="faceBoxStyle(selectedPersonFace?.bbox)" />
        </HeicImage>
        <div class="fs-topbar">
          <Button icon="pi pi-arrow-left" class="fs-topbar-btn" rounded text @click="isFullscreen = false" />
          <div class="fs-center">
            <span class="fs-person-name">{{ selectedPerson?.name }}</span>
            <Button v-if="selectedPerson" icon="pi pi-pencil" class="fs-topbar-btn" rounded text size="small" @click.stop="openRename(selectedPerson)" />
          </div>
          <div class="fs-toolbar">
            <Button v-if="selectedPhoto.curation_status === 'hidden'" icon="pi pi-eye" class="fs-topbar-btn" rounded text severity="info" @click.stop="handleRestorePhoto(selectedPhoto.id)" />
            <Button v-else icon="pi pi-eye-slash" class="fs-topbar-btn" rounded text severity="warn" @click.stop="handleHidePhoto(selectedPhoto.id)" />
            <Button :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" class="fs-topbar-btn" rounded text :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'" @click.stop="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)" />
            <Button v-if="selectedPersonFace" icon="pi pi-trash" label="Gesicht ignorieren" class="fs-topbar-btn" rounded text severity="danger" @click.stop="handleIgnoreFace(selectedPersonFace.id)" />
          </div>
        </div>
        <Button v-if="selectedIndex > 0" icon="pi pi-chevron-left" class="fs-nav fs-nav-left" rounded text @click="selectedIndex > 0 && selectedIndex--" />
        <Button v-if="selectedIndex < personPhotos.length - 1" icon="pi pi-chevron-right" class="fs-nav fs-nav-right" rounded text @click="selectedIndex < personPhotos.length - 1 && selectedIndex++" />
      </div>
    </div>

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
/* ── Layout ──────────────────────────────────────────────────────────────── */
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

.header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header h1 {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
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

/* ── Person panel (left) ─────────────────────────────────────────────────── */
.person-panel {
  width: 200px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--surface-card);
  border-right: 1px solid var(--surface-border);
  display: flex;
  flex-direction: column;
  gap: 0;
}

.person-entry {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.15s;
  outline: none;
}

.person-entry:hover { background: var(--surface-hover); }

/* Subtle background for any focused entry (keyboard traversal) */
.person-entry:focus-visible { background: var(--surface-hover); }

/* Strong focus ring only on the active (selected) entry */
.person-entry.active:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

.person-entry.active {
  background: var(--p-primary-50);
  border-left-color: var(--p-primary-color);
}

.person-avatar {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--surface-ground);
}

.person-avatar :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

.person-avatar :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.person-entry-info {
  flex: 1;
  min-width: 0;
}

.person-entry-name {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

.person-entry-count {
  display: block;
  font-size: 0.72rem;
  color: var(--text-color-secondary);
}

.rename-inline {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  width: 100%;
}

.rename-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--surface-300);
  border-radius: 4px;
  padding: 0.15rem 0.3rem;
  font-size: 0.8rem;
  outline: none;
  background: var(--surface-0);
}

.rename-input:focus { border-color: var(--p-primary-color); }

/* Pencil: visible on hover, or when the active entry has focus */
.pencil-btn {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}

.person-entry:hover .pencil-btn,
.person-entry.active:focus-within .pencil-btn {
  opacity: 1;
  pointer-events: auto;
}

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

/* ── Photo grid (center) ─────────────────────────────────────────────────── */
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
  bottom: 0;
  left: 0;
  right: 0;
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
  top: 8px;
  right: 8px;
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}
.favorite-badge { color: var(--p-yellow-500); }
.hidden-badge { color: white; }

/* ── Fullscreen ──────────────────────────────────────────────────────────── */
.fullscreen-overlay {
  position: fixed;
  inset: 0;
  background: var(--p-slate-950);
  z-index: 1100;
}

.fullscreen-content {
  position: relative;
  width: 100%;
  height: 100%;
}

.fullscreen-content :deep(.heic-image-container) { width: 100%; height: 100%; overflow: hidden; }
.fullscreen-content :deep(img) { width: 100%; height: 100%; object-fit: contain; }

.fs-topbar {
  position: absolute;
  top: 0; left: 0; right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.25rem;
  pointer-events: none;
  background-color: var(--p-neutral-50);
}
.fs-topbar > * { display: flex; pointer-events: auto; color: var(--p-text-color); }

.fs-topbar-btn { pointer-events: auto; }

.fs-center {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  pointer-events: auto;
}

.fs-person-name {
  font-size: 1rem;
  font-weight: 600;
  pointer-events: none;
}

.fs-toolbar { display: flex; gap: 0.25rem; }

.fs-nav {
  position: absolute;
  top: 50%;
  z-index: 10;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.2s;
}
.fullscreen-content:hover .fs-nav { opacity: 1; }
.fs-nav-left { left: 0.75rem; }
.fs-nav-right { right: 0.75rem; }

/* ── Dialogs ─────────────────────────────────────────────────────────────── */
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.5rem;
}

.dialog-label { font-weight: 700; display: block; margin-bottom: 0.5rem; }

.rename-row { display: flex; flex-direction: column; gap: 0.5rem; }

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
