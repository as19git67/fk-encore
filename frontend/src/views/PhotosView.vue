<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import ToggleSwitch from 'primevue/toggleswitch'
import HeicImage from '../components/HeicImage.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import {
  listPhotos,
  uploadPhoto,
  deletePhoto,
  getPhotoUrl,
  updatePhotoDate,
  reindexPhoto,
  ignoreFace,
  getPhotoFaces,
  getPhotoLandmarks,
  updatePhotoCuration,
  listPhotoGroups,
  searchPhotos,
  type Photo,
  type Face,
  type CurationStatus,
  type PhotoGroup,
  type PhotoSearchResult,
  type LandmarkItem,
} from '../api/photos'
import { listPersons, type Person } from '../api/photos'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const photos = ref<Photo[]>([])
const loading = ref(true)
const uploading = ref(false)
const uploadAbortController = ref<AbortController | null>(null)
const error = ref('')
const selectedIndex = ref(-1)
const isFullscreen = ref(false)

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const canManageData = computed(() => auth.hasPermission('data.manage'))
const showHidden = ref(false)

// Photo groups (stacks)
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)

// ── Semantic Search ─────────────────────────────────────────────────────────
const searchQuery = ref('')
const searchResults = ref<PhotoSearchResult[] | null>(null)
const searchLoading = ref(false)
const searchError = ref('')

const searchResultIds = computed<number[] | null>(() => {
  if (searchResults.value === null) return null
  return searchResults.value.map(r => r.photoId)
})

async function executeSearch() {
  const q = searchQuery.value.trim()
  if (!q) {
    searchResults.value = null
    searchError.value = ''
    return
  }
  searchLoading.value = true
  searchError.value = ''
  try {
    const res = await searchPhotos(q)
    searchResults.value = res.results
  } catch (err) {
    searchError.value = 'Suche fehlgeschlagen. Ist der Embedding-Service erreichbar?'
    console.error('Search failed:', err)
  } finally {
    searchLoading.value = false
  }
}

function clearSearch() {
  searchQuery.value = ''
  searchResults.value = null
  searchError.value = ''
}

// Map: photoId -> group
const photoToGroup = computed(() => {
  const map = new Map<number, PhotoGroup>()
  for (const group of photoGroupsList.value) {
    for (const pid of group.photo_ids) {
      map.set(pid, group)
    }
  }
  return map
})

const unreviewedGroupCount = computed(() =>
  photoGroupsList.value.filter((g) => !g.reviewed_at).length
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

const inUnreviewedStack = computed(() => {
  const set = new Set<number>()
  for (const group of photoGroupsList.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) {
      set.add(pid)
    }
  }
  return set
})

const selectedPhoto = computed(() => {
  if (selectedIndex.value < 0) return null
  return photos.value[selectedIndex.value] ?? null
})

const prevPhoto = computed(() => {
  if (selectedIndex.value <= 0) return null
  return photos.value[selectedIndex.value - 1] ?? null
})

const nextPhoto = computed(() => {
  if (selectedIndex.value < 0 || selectedIndex.value >= photos.value.length - 1) return null
  return photos.value[selectedIndex.value + 1] ?? null
})

const formatPhotoDateFull = (photo: Photo) => {
  const dateStr = photo.taken_at || photo.created_at
  if (!dateStr) return ''
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(dateStr))
}

const isDragging = ref(false)
const dragCounter = ref(0)

const isEditingDate = ref(false)
const editDate = ref<Date | null>(null)
const updatingDate = ref(false)
const confirm = useConfirm()
const activeSection = ref('')

const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])

const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)

// ── Lazy rendering via IntersectionObserver ──────────────────────────────────

const gridScrollRef = ref<HTMLElement | null>(null)
const visiblePhotoIds = ref(new Set<number>())
let photoObserver: IntersectionObserver | null = null
let sectionObserver: IntersectionObserver | null = null

// Column count for keyboard navigation
const columnCount = ref(4)

function updateColumnCount() {
  const grid = gridScrollRef.value?.querySelector('.photo-grid')
  if (grid) {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    if (cols > 0) columnCount.value = cols
  }
}

let gridResizeObserver: ResizeObserver | null = null

// ── Photo grouping ──────────────────────────────────────────────────────────

interface PhotoItem {
  photo: Photo
  index: number
  group?: PhotoGroup
}

interface MonthGroup {
  month: string
  photos: PhotoItem[]
}

interface YearGroup {
  year: string
  months: MonthGroup[]
}

const groupedPhotos = computed(() => {
  const groups: YearGroup[] = []
  const ids = searchResultIds.value

  const orderedPhotos = ids !== null
    ? ids.map(id => photos.value.find(p => p.id === id)).filter((p): p is Photo => p !== undefined)
    : photos.value

  orderedPhotos.forEach((photo, index) => {
    if (ids === null && hiddenByStack.value.has(photo.id)) return

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

    const group = photoToGroup.value.get(photo.id)
    const stackGroup = ids === null && group && !group.reviewed_at ? group : undefined
    monthGroup.photos.push({ photo, index, group: stackGroup })
  })

  return groups
})

// ── Data loading ────────────────────────────────────────────────────────────

async function loadPersons() {
  try {
    const res = await listPersons()
    persons.value = res.persons
  } catch (err) {
    console.error('Failed to load persons:', err)
  }
}

async function loadDetectedFaces(photoId: number) {
  loadingFaces.value = true
  try {
    const res = await getPhotoFaces(photoId)
    detectedFaces.value = res.faces
  } catch (err) {
    console.error('Failed to load faces:', err)
  } finally {
    loadingFaces.value = false
  }
}

async function loadLandmarks(photoId: number) {
  loadingLandmarks.value = true
  try {
    const res = await getPhotoLandmarks(photoId)
    detectedLandmarks.value = res.landmarks
  } catch (err) {
    console.error('Failed to load landmarks:', err)
  } finally {
    loadingLandmarks.value = false
  }
}

async function handleIgnoreFace(faceId: number) {
  if (!selectedPhoto.value) return
  try {
    await ignoreFace(faceId)
    await loadDetectedFaces(selectedPhoto.value.id)
  } catch (err) {
    console.error('Failed to ignore face:', err)
  }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try {
    await reindexPhoto(selectedPhoto.value.id)
    await Promise.all([
      loadDetectedFaces(selectedPhoto.value.id),
      loadLandmarks(selectedPhoto.value.id),
    ])
  } catch (err) {
    console.error('Failed to reindex photo:', err)
  } finally {
    reindexingPhoto.value = false
  }
}

watch(selectedPhoto, (newPhoto) => {
  if (newPhoto) {
    loadDetectedFaces(newPhoto.id)
    loadPersons()
    loadLandmarks(newPhoto.id)
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

async function loadPhotos() {
  loading.value = true
  error.value = ''
  try {
    const [photosRes, groupsRes] = await Promise.all([
      listPhotos(showHidden.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    photos.value = photosRes.photos.sort((a, b) => {
      const dateA = new Date(a.taken_at || a.created_at).getTime()
      const dateB = new Date(b.taken_at || b.created_at).getTime()
      return dateB - dateA
    })
    photoGroupsList.value = groupsRes.groups
    loading.value = false
    await nextTick()
    setupObservers()
    updateColumnCount()
    // Select first visible photo on initial load
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
    photos.value = photosRes.photos.sort((a, b) => {
      const dateA = new Date(a.taken_at || a.created_at).getTime()
      const dateB = new Date(b.taken_at || b.created_at).getTime()
      return dateB - dateA
    })
    photoGroupsList.value = groupsRes.groups
    await nextTick()
    setupObservers()
  } catch {
    // Silently fail
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    activeSection.value = id
  }
}

function scrollToPhoto(photoId: number) {
  const el = gridScrollRef.value?.querySelector(`[data-photo-id="${photoId}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// ── Upload / Delete / Curation ──────────────────────────────────────────────

async function handleUpload(event: any) {
  let files: any[] = []
  if (event.files) files = event.files
  else if (event instanceof FileList) files = Array.from(event)
  else if (event.dataTransfer) files = Array.from(event.dataTransfer.files)

  if (!files || files.length === 0) return

  const abortController = new AbortController()
  uploadAbortController.value = abortController
  uploading.value = true
  error.value = ''
  let duplicates: string[] = []
  let unsupportedTypes: string[] = []
  let errors: string[] = []

  try {
    for (const file of files) {
      if (abortController.signal.aborted) break
      try {
        await uploadPhoto(file, abortController.signal)
      } catch (err: any) {
        if (abortController.signal.aborted) break
        if (err.message?.includes('Foto wurde bereits hochgeladen')) duplicates.push(file.name)
        else if (err.message?.includes('Dateiformat wird nicht unterstützt')) unsupportedTypes.push(file.name)
        else errors.push(`${file.name}: ${err.message}`)
      }
    }
    await loadPhotos()
    if (abortController.signal.aborted) {
      error.value = 'Hochladen wurde abgebrochen.'
    } else if (duplicates.length > 0 || unsupportedTypes.length > 0 || errors.length > 0) {
      let msg = ''
      if (duplicates.length > 0) msg += `Bereits vorhanden: ${duplicates.join(', ')}. `
      if (unsupportedTypes.length > 0) msg += `Nicht unterstützt: ${unsupportedTypes.join(', ')}. `
      if (errors.length > 0) msg += `Fehler: ${errors.join('; ')}.`
      error.value = msg
    }
  } catch (err: any) {
    if (!abortController.signal.aborted) error.value = err.message || 'Fehler beim Hochladen'
  } finally {
    uploading.value = false
    uploadAbortController.value = null
  }
}

function cancelUpload() {
  uploadAbortController.value?.abort()
}

async function handleDelete(id: number) {
  confirm.require({
    message: 'Foto ausblenden? Es kann jederzeit wiederhergestellt werden.',
    header: 'Foto ausblenden',
    icon: 'pi pi-eye-slash',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Ausblenden', severity: 'warn' },
    accept: async () => {
      try {
        await deletePhoto(id)
        await reloadPhotosInPlace()
        if (selectedIndex.value >= photos.value.length) selectedIndex.value = photos.value.length - 1
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Ausblenden'
      }
    }
  })
}

async function handleRestore(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    await reloadPhotosInPlace()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Wiederherstellen'
  }
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
    error.value = err.message || 'Fehler beim Ändern des Favoriten-Status'
  }
}

function selectAfterGroup(group: PhotoGroup | null) {
  if (!group || photos.value.length === 0) {
    selectedIndex.value = photos.value.length > 0 ? 0 : -1
    return
  }
  const groupPhotoIds = new Set(group.photo_ids)
  // First visible photo from the group that is still in the grid
  const visibleGroupItems = photos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id) && !hiddenByStack.value.has(photo.id))
  if (visibleGroupItems.length > 0) {
    const first = visibleGroupItems[0]!
    selectedIndex.value = first.index
    scrollToPhoto(first.photo.id)
    return
  }
  // All group photos gone — select the photo that follows the group's last position
  const allGroupItems = photos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id))
  const maxIdx = allGroupItems.length > 0 ? Math.max(...allGroupItems.map(gi => gi.index)) : -1
  for (let i = maxIdx + 1; i < photos.value.length; i++) {
    const photo = photos.value[i]!
    if (!hiddenByStack.value.has(photo.id)) {
      selectedIndex.value = i
      scrollToPhoto(photo.id)
      return
    }
  }
  const firstVisible = photos.value.findIndex(p => !hiddenByStack.value.has(p.id))
  selectedIndex.value = firstVisible >= 0 ? firstVisible : 0
}

function handleGroupClose() {
  const group = activeGroup.value
  activeGroup.value = null
  reloadPhotosInPlace().then(() => selectAfterGroup(group))
}

function handleGroupNext(reviewedGroupId: number) {
  const next = photoGroupsList.value.find((g) => !g.reviewed_at && g.id !== reviewedGroupId)
  if (next) {
    activeGroup.value = next
    reloadPhotosInPlace()
  } else {
    const group = activeGroup.value
    activeGroup.value = null
    reloadPhotosInPlace().then(() => selectAfterGroup(group))
  }
}

function handleStartGroupReview() {
  const first = photoGroupsList.value.find(g => !g.reviewed_at)
  if (first) activeGroup.value = first
}

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

// ── Drag & Drop ─────────────────────────────────────────────────────────────

function handleDragEnter(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  dragCounter.value++
  isDragging.value = true
}

function handleDragLeave(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  dragCounter.value--
  if (dragCounter.value === 0) isDragging.value = false
}

function handleDragOver(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

async function handleDrop(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  isDragging.value = false
  dragCounter.value = 0
  const files = e.dataTransfer?.files
  if (files && files.length > 0) await handleUpload(files)
}

// ── Keyboard Navigation ─────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
  if (isEditingDate.value) return

  if (isFullscreen.value) {
    if (e.key === 'Escape' || e.key === ' ') {
      isFullscreen.value = false
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      if (selectedIndex.value > 0) selectedIndex.value--
    } else if (e.key === 'ArrowRight') {
      if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
    } else if ((e.key === 'x' || e.key === 'X') && selectedPhoto.value) {
      if (selectedPhoto.value.curation_status !== 'hidden') handleDelete(selectedPhoto.value.id)
      else handleRestore(selectedPhoto.value.id)
      e.preventDefault()
    } else if ((e.key === 'f' || e.key === 'F') && selectedPhoto.value) {
      handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status)
      e.preventDefault()
    }
    return
  }

  if (photos.value.length === 0) return

  const cols = columnCount.value
  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = photos.value.length - 1
  } else if (e.key === 'ArrowDown') {
    if (selectedIndex.value + cols < photos.value.length) selectedIndex.value += cols
  } else if (e.key === 'ArrowUp') {
    if (selectedIndex.value - cols >= 0) selectedIndex.value -= cols
  } else if (e.key === ' ') {
    if (selectedIndex.value !== -1) { isFullscreen.value = !isFullscreen.value; e.preventDefault() }
  } else if (e.key === 'Enter') {
    if (selectedIndex.value !== -1 && document.activeElement?.tagName !== 'INPUT') isFullscreen.value = true
  }
}

watch(selectedIndex, (newIdx) => {
  isEditingDate.value = false
  if (newIdx === -1 || isFullscreen.value) return
  const photo = photos.value[newIdx]
  if (photo) scrollToPhoto(photo.id)
})

watch(isFullscreen, (val) => {
  if (!val) isEditingDate.value = false
})

// ── IntersectionObserver setup ──────────────────────────────────────────────

function setupObservers() {
  // Clean up old observers
  photoObserver?.disconnect()
  sectionObserver?.disconnect()

  const root = gridScrollRef.value
  if (!root) return

  // Photo visibility observer — controls which images get rendered
  visiblePhotoIds.value = new Set()
  photoObserver = new IntersectionObserver(
    (entries) => {
      const next = new Set(visiblePhotoIds.value)
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.photoId)
        if (!id) continue
        if (entry.isIntersecting) next.add(id)
        else next.delete(id)
      }
      visiblePhotoIds.value = next
    },
    { root, rootMargin: '300px 0px' }
  )
  const photoEls = root.querySelectorAll('[data-photo-id]')
  photoEls.forEach(el => photoObserver!.observe(el))

  // Fallback: immediately mark items that are in the initial viewport as visible
  // (IntersectionObserver callbacks are async and may not fire before first paint)
  const rootRect = root.getBoundingClientRect()
  const initial = new Set(visiblePhotoIds.value)
  photoEls.forEach(el => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
      const id = Number((el as HTMLElement).dataset.photoId)
      if (id) initial.add(id)
    }
  })
  visiblePhotoIds.value = initial

  // Section header observer — tracks active year/month for timeline nav
  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeSection.value = (entry.target as HTMLElement).id
        }
      }
    },
    { root, rootMargin: '-5% 0px -90% 0px' }
  )
  root.querySelectorAll('[data-section-header]').forEach(el => sectionObserver!.observe(el))
}

// Re-observe after groupedPhotos changes (e.g. search, filter)
watch(groupedPhotos, async () => {
  await nextTick()
  setupObservers()
  updateColumnCount()
})

onMounted(() => {
  loadPhotos()
  window.addEventListener('keydown', handleKeydown)

  // Track column count on resize
  gridResizeObserver = new ResizeObserver(() => updateColumnCount())
  if (gridScrollRef.value) gridResizeObserver.observe(gridScrollRef.value)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  photoObserver?.disconnect()
  sectionObserver?.disconnect()
  gridResizeObserver?.disconnect()
})
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
        <i class="pi pi-upload"></i>
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>

    <!-- Subheader (not sticky — only the grid scrolls) -->
    <div class="subheader">
      <div class="header">
        <h1>Meine Fotos</h1>
        <div class="actions">
          <div v-if="canDelete" class="toggle-hidden">
            <label for="showHidden" class="text-sm">Ausgeblendete</label>
            <ToggleSwitch v-model="showHidden" inputId="showHidden" @update:modelValue="loadPhotos" />
          </div>
          <Button
            v-if="canManageData && unreviewedGroupCount > 0"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images"
            severity="success"
            :disabled="uploading"
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
            placeholder="Fotos suchen…" @keyup.enter="executeSearch" @keyup.escape="clearSearch" />
          <button v-if="searchQuery" class="search-clear" @click="clearSearch"><i class="pi pi-times" /></button>
        </div>
        <Button icon="pi pi-search" label="Suchen" :loading="searchLoading" :disabled="!searchQuery.trim()" @click="executeSearch" />
        <span v-if="searchResults !== null && !searchLoading" class="search-result-count">
          {{ searchResults.length }} Treffer
        </span>
      </div>
    </div>

    <Message v-if="searchError" severity="error" @close="searchError = ''">{{ searchError }}</Message>
    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="uploading" class="info-text">Fotos werden hochgeladen…</div>
    <div v-else-if="loading" class="info-text">Lade Fotos…</div>
    <div v-else-if="photos.length === 0" class="info-text">Keine Fotos hochgeladen.</div>

    <!-- Three-column layout -->
    <div v-else class="gallery-layout">
      <!-- LEFT: Timeline nav -->
      <nav class="timeline-nav">
        <div v-for="yearGroup in groupedPhotos" :key="'nav-' + yearGroup.year" class="nav-year-group">
          <a @click.prevent="scrollToSection('year-' + yearGroup.year)"
            class="nav-year" :class="{ active: activeSection === 'year-' + yearGroup.year }">
            {{ yearGroup.year }}
          </a>
          <div class="nav-months">
            <a v-for="monthGroup in yearGroup.months"
              :key="'nav-' + yearGroup.year + monthGroup.month"
              @click.prevent="scrollToSection('month-' + yearGroup.year + '-' + monthGroup.month)"
              class="nav-month"
              :class="{ active: activeSection === 'month-' + yearGroup.year + '-' + monthGroup.month }">
              {{ monthGroup.month.substring(0, 3) }}
            </a>
          </div>
        </div>
      </nav>

      <!-- CENTER: Scrollable photo grid -->
      <div class="photo-grid-scroll" ref="gridScrollRef">
        <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
          <h2 class="year-title" :id="'year-' + yearGroup.year" data-section-header>{{ yearGroup.year }}</h2>

          <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
            <h3 class="month-title"
              :id="'month-' + yearGroup.year + '-' + monthGroup.month"
              data-section-header>
              {{ monthGroup.month }}
            </h3>

            <div class="photo-grid">
              <div
                v-for="item in monthGroup.photos"
                :key="item.photo.id"
                :data-photo-id="item.photo.id"
                class="photo-item"
                :class="{
                  selected: item.index === selectedIndex,
                  'is-hidden': item.photo.curation_status === 'hidden',
                  'is-favorite': item.photo.curation_status === 'favorite',
                  'is-stack': !!item.group
                }"
                @click="item.group ? (activeGroup = item.group) : (selectedIndex = item.index)"
                @dblclick="!item.group && (isFullscreen = true)"
              >
                <div class="photo-thumb">
                  <HeicImage
                    v-if="visiblePhotoIds.has(item.photo.id)"
                    :src="getPhotoUrl(item.photo.filename, 400)"
                    :alt="item.photo.original_name"
                  />
                </div>
                <span v-if="item.group" class="stack-badge">{{ item.group.member_count }}</span>
                <i v-if="item.group?.reviewed_at" class="pi pi-check stack-reviewed-badge"></i>
                <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge"></i>
                <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-eye-slash hidden-badge"></i>
                <div class="photo-info">
                  <span class="name">{{ item.group ? `${item.group.member_count} ähnliche Fotos` : item.photo.original_name }}</span>
                  <div v-if="!inUnreviewedStack.has(item.photo.id)" class="photo-actions">
                    <Button v-if="canDelete && item.photo.curation_status === 'hidden'" size="small" icon="pi pi-eye" severity="info" text rounded v-tooltip="'Wiederherstellen'" @click.stop="handleRestore(item.photo.id)" />
                    <Button v-if="canDelete && item.photo.curation_status !== 'hidden'" size="small" :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'" text rounded v-tooltip="'Favorit'" @click.stop="handleToggleFavorite(item.photo.id, item.photo.curation_status)" />
                    <Button v-if="canDelete && item.photo.curation_status !== 'hidden'" size="small" icon="pi pi-eye-slash" severity="danger" text rounded v-tooltip="'Ausblenden'" @click.stop="handleDelete(item.photo.id)" />
                  </div>
                </div>
              </div>
            </div>
          </template>
        </template>
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
        :can-upload="canUpload"
        :reindexing-photo="reindexingPhoto"
        :is-editing-date="isEditingDate"
        v-model:editDate="editDate"
        :updating-date="updatingDate"
        :show-persons="auth.hasPermission('people.view')"
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

    <!-- Fullscreen -->
    <div v-if="isFullscreen && selectedPhoto" class="fullscreen-overlay" @click="isFullscreen = false">
      <div style="display: none">
        <HeicImage v-if="prevPhoto" :src="getPhotoUrl(prevPhoto.filename)" />
        <HeicImage v-if="nextPhoto" :src="getPhotoUrl(nextPhoto.filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(selectedPhoto.filename)" :alt="selectedPhoto.original_name" objectFit="contain" />
        <div class="fs-topbar">
          <Button icon="pi pi-arrow-left" class="fs-topbar-btn" rounded text @click="isFullscreen = false" />
          <div class="fs-date-bar">{{ formatPhotoDateFull(selectedPhoto) }}</div>
          <div class="fs-toolbar">
            <Button v-if="selectedPhoto.curation_status === 'hidden'" icon="pi pi-eye" class="fs-topbar-btn" rounded text severity="warn" @click="handleRestore(selectedPhoto.id)" />
            <Button v-else icon="pi pi-eye-slash" class="fs-topbar-btn" rounded text severity="info" @click="handleDelete(selectedPhoto.id)" />
            <Button :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" class="fs-topbar-btn" rounded text :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'" @click="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)" />
          </div>
        </div>
        <Button v-if="selectedIndex > 0" icon="pi pi-chevron-left" class="fs-nav fs-nav-left" rounded text @click="selectedIndex > 0 && selectedIndex--" />
        <Button v-if="selectedIndex < photos.length - 1" icon="pi pi-chevron-right" class="fs-nav fs-nav-right" rounded text @click="selectedIndex < photos.length - 1 && selectedIndex++" />
      </div>
    </div>

    <PhotoCompareView v-if="activeGroup" :group="activeGroup" :allPhotos="photos" :totalUnreviewed="unreviewedGroupCount" @close="handleGroupClose" @next="handleGroupNext" />
  </div>
</template>

<style scoped>
/* ── Layout ────────────────────────────────────────────────────────────────── */
.photos-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
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
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}

.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0; /* allow children to scroll */
  overflow: hidden;
}

/* ── Timeline Nav (left) ──────────────────────────────────────────────────── */
.timeline-nav {
  width: 80px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 1rem 0.5rem;
  background: var(--surface-card);
  border-right: 1px solid var(--surface-border);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
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
  color: var(--p-primary-color);
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.2s;
}

.nav-year:hover { background: var(--p-primary-50); }
.nav-year.active { background: var(--p-primary-color); color: white; }

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
  color: var(--p-primary-color);
  font-weight: bold;
  background: var(--p-primary-50);
}

/* ── Photo Grid (center) ─────────────────────────────────────────────────── */
.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0 1rem 1rem;
}

.year-title {
  border-bottom: 2px solid var(--p-primary-color);
  padding-bottom: 0.5rem;
  margin-top: 2rem;
  margin-bottom: 0.5rem;
  font-size: 1.5rem;
}

.year-title:first-child {
  margin-top: 0.5rem;
}

.month-title {
  color: var(--text-color-secondary);
  font-weight: 500;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  padding-bottom: 0.5rem;
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
}

.photo-item:hover { transform: scale(1.02); }

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
}

.photo-thumb :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

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
.photo-item.selected .photo-info { opacity: 1; }

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

/* Stack styles */
.photo-item.is-stack { margin: 6px; }
.photo-item.is-stack::before,
.photo-item.is-stack::after {
  content: '';
  position: absolute;
  top: -2px; left: -2px; right: -2px; bottom: -2px;
  background: var(--surface-card);
  border-radius: 8px;
  z-index: -1;
  border: 1px solid var(--surface-300);
}
.photo-item.is-stack::before { transform: rotate(-3deg); top: -4px; left: -5px; }
.photo-item.is-stack::after { transform: rotate(2.5deg); top: -3px; right: -5px; }

.stack-badge {
  position: absolute;
  top: 8px; left: 8px;
  background: var(--p-primary-color);
  color: white;
  font-size: 0.8rem;
  font-weight: 700;
  min-width: 24px;
  height: 24px;
  line-height: 24px;
  text-align: center;
  padding: 0 6px;
  border-radius: 12px;
  z-index: 5;
}

.stack-reviewed-badge {
  position: absolute;
  top: 8px; left: 42px;
  background: var(--p-green-500);
  color: white;
  width: 22px; height: 22px;
  line-height: 22px;
  text-align: center;
  font-size: 0.7rem;
  border-radius: 11px;
  z-index: 5;
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

/* ── Upload ──────────────────────────────────────────────────────────────── */
.upload-button-label { display: inline-flex; cursor: pointer; }
.upload-input-hidden { display: none; }

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
.fs-date-bar { white-space: nowrap; pointer-events: none; }
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
</style>
