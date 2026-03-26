<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useWindowVirtualizer } from '@tanstack/vue-virtual'
import Button from 'primevue/button'
import FileUpload from 'primevue/fileupload'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import DatePicker from 'primevue/datepicker'
import ToggleSwitch from 'primevue/toggleswitch'
import HeicImage from '../components/HeicImage.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import {
  listPhotos,
  uploadPhoto,
  deletePhoto,
  getPhotoUrl,
  updatePhotoDate,
  reindexPhoto,
  ignoreFace,
  getPhotoFaces,
  updatePhotoCuration,
  listPhotoGroups,
  searchPhotos,
  type Photo,
  type Face,
  type CurationStatus,
  type PhotoGroup,
  type PhotoSearchResult,
} from '../api/photos'
import { listPersons, type Person } from '../api/photos'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const photos = ref<Photo[]>([])
const loading = ref(true)
const uploading = ref(false)
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

// IDs der gefundenen Fotos in Score-Reihenfolge (null = kein aktiver Suchfilter)
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

// Set of photo IDs that are in an UNREVIEWED group but NOT the cover
// Reviewed groups show all photos individually
const hiddenByStack = computed(() => {
  const set = new Set<number>()
  for (const group of photoGroupsList.value) {
    if (group.reviewed_at) continue // reviewed → show all individually
    for (const pid of group.photo_ids) {
      if (pid !== group.cover_photo_id) set.add(pid)
    }
  }
  return set
})

// Set of photo IDs that are in an unreviewed stack (no curation in grid)
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

const formatPhotoDate = (photo: Photo) => {
  const dateStr = photo.taken_at || photo.created_at;
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

const formatPhotoDateFull = (photo: Photo) => {
  const dateStr = photo.taken_at || photo.created_at;
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
};

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

// ── Virtual Scrolling ──────────────────────────────────────────────────────

const gridContainerRef = ref<HTMLElement | null>(null)
const containerWidth = ref(800)
const scrollMargin = ref(0)

// 200px item + 16px gap = 216px per column slot
const columnCount = computed(() => Math.max(1, Math.floor((containerWidth.value + 16) / 216)))

interface PhotoItem {
  photo: Photo;
  index: number;
  group?: PhotoGroup;
}

interface MonthGroup {
  month: string;
  photos: PhotoItem[];
}

interface YearGroup {
  year: string;
  months: MonthGroup[];
}

const groupedPhotos = computed(() => {
  const groups: YearGroup[] = [];
  const ids = searchResultIds.value;

  // In search mode: show results sorted by score (no date grouping headers needed,
  // but we reuse the same year/month grouping structure for display consistency).
  const orderedPhotos = ids !== null
    ? ids.map(id => photos.value.find(p => p.id === id)).filter((p): p is Photo => p !== undefined)
    : photos.value;

  orderedPhotos.forEach((photo, index) => {
    // Skip photos hidden by stack only when NOT in search mode
    if (ids === null && hiddenByStack.value.has(photo.id)) return;

    const date = new Date(photo.taken_at || photo.created_at);
    const year = date.getFullYear().toString();
    const month = date.toLocaleString('de-DE', { month: 'long' });

    let yearGroup = groups.find(g => g.year === year);
    if (!yearGroup) {
      yearGroup = { year, months: [] };
      groups.push(yearGroup);
    }

    let monthGroup = yearGroup.months.find(m => m.month === month);
    if (!monthGroup) {
      monthGroup = { month, photos: [] };
      yearGroup.months.push(monthGroup);
    }

    const group = photoToGroup.value.get(photo.id);
    // Only show as stack if group is unreviewed and not in search mode
    const stackGroup = ids === null && group && !group.reviewed_at ? group : undefined;
    monthGroup.photos.push({ photo, index, group: stackGroup });
  });

  return groups;
});

type VirtualRow =
  | { type: 'year-header'; year: string }
  | { type: 'month-header'; year: string; month: string }
  | { type: 'photos'; items: PhotoItem[] }

const virtualRows = computed<VirtualRow[]>(() => {
  const rows: VirtualRow[] = []
  for (const yearGroup of groupedPhotos.value) {
    rows.push({ type: 'year-header', year: yearGroup.year })
    for (const monthGroup of yearGroup.months) {
      rows.push({ type: 'month-header', year: yearGroup.year, month: monthGroup.month })
      const items = monthGroup.photos
      for (let i = 0; i < items.length; i += columnCount.value) {
        rows.push({ type: 'photos', items: items.slice(i, i + columnCount.value) })
      }
    }
  }
  return rows
})

// Fast lookup: section-id → row index
const sectionToRowIndex = computed(() => {
  const map = new Map<string, number>()
  virtualRows.value.forEach((row, i) => {
    if (row.type === 'year-header') map.set('year-' + row.year, i)
    else if (row.type === 'month-header') map.set('month-' + row.year + '-' + row.month, i)
  })
  return map
})

// Fast lookup: photoId → row index
const photoIdToRowIndex = computed(() => {
  const map = new Map<number, number>()
  virtualRows.value.forEach((row, i) => {
    if (row.type === 'photos') row.items.forEach(item => map.set(item.photo.id, i))
  })
  return map
})

const virtualizer = useWindowVirtualizer(computed(() => ({
  count: virtualRows.value.length,
  estimateSize: (i: number) => {
    const row = virtualRows.value[i]
    if (!row) return 224
    if (row.type === 'year-header') return 90
    if (row.type === 'month-header') return 56
    return 224 // photo row: 200px image + gap
  },
  overscan: 3,
  scrollMargin: scrollMargin.value,
})))

// Update active section based on which virtual rows are currently visible
watch(
  () => virtualizer.value.getVirtualItems(),
  (items) => {
    let current = activeSection.value
    for (const vItem of items) {
      const row = virtualRows.value[vItem.index]
      if (row?.type === 'year-header') current = 'year-' + row.year
      else if (row?.type === 'month-header') current = 'month-' + row.year + '-' + row.month
    }
    if (current !== activeSection.value) activeSection.value = current
  }
)

// ResizeObserver: track container width and scrollMargin
let resizeObserver: ResizeObserver | null = null

function updateGridMetrics(el: HTMLElement) {
  containerWidth.value = el.clientWidth
  // Use document offset (not offsetParent-relative offsetTop) for stable virtualizer positioning.
  scrollMargin.value = el.getBoundingClientRect().top + window.scrollY
}

function refreshVirtualLayout() {
  const el = gridContainerRef.value
  if (!el) return
  updateGridMetrics(el)
  virtualizer.value.measure()
}

watch(gridContainerRef, (el) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!el) return
  updateGridMetrics(el)
  resizeObserver = new ResizeObserver(() => {
    updateGridMetrics(el)
    virtualizer.value.measure()
  })
  resizeObserver.observe(el)
})

watch(columnCount, () => {
  virtualizer.value.measure()
})

async function loadPersons() {
  try {
    const res = await listPersons()
    persons.value = res.persons
  } catch (err) {
    console.error('Failed to load persons:', err)
  }
}

function getPersonName(personId?: number) {
  if (!personId) return 'Unbekannt'
  const person = persons.value.find(p => p.id === personId)
  return person ? person.name : 'Unbekannt'
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
    await loadDetectedFaces(selectedPhoto.value.id)
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
  } else {
    detectedFaces.value = []
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
      const dateA = new Date(a.taken_at || a.created_at).getTime();
      const dateB = new Date(b.taken_at || b.created_at).getTime();
      return dateB - dateA;
    });
    photoGroupsList.value = groupsRes.groups
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Fotos'
  } finally {
    loading.value = false
  }
}

function scrollToSection(id: string) {
  const index = sectionToRowIndex.value.get(id)
  if (index !== undefined) {
    virtualizer.value.scrollToIndex(index, { align: 'start', behavior: 'smooth' })
    activeSection.value = id
  }
}

async function handleUpload(event: any) {
  let files: any[] = []
  if (event.files) {
    files = event.files
  } else if (event instanceof FileList) {
    files = Array.from(event)
  } else if (event.dataTransfer) {
    files = Array.from(event.dataTransfer.files)
  }

  if (!files || files.length === 0) return
  
  uploading.value = true
  error.value = ''
  let duplicates = []
  let errors = []

  try {
    for (const file of files) {
      try {
        await uploadPhoto(file)
      } catch (err: any) {
        if (err.message?.includes('Foto wurde bereits hochgeladen')) {
          duplicates.push(file.name)
        } else {
          errors.push(`${file.name}: ${err.message}`)
        }
      }
    }
    
    await loadPhotos()
    
    if (duplicates.length > 0 || errors.length > 0) {
      let msg = ''
      if (duplicates.length > 0) {
        msg += `Folgende Fotos wurden übersprungen, da sie bereits vorhanden sind: ${duplicates.join(', ')}. `
      }
      if (errors.length > 0) {
        msg += `Fehler bei: ${errors.join('; ')}.`
      }
      error.value = msg
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Hochladen'
  } finally {
    uploading.value = false
  }
}

async function handleDelete(id: number) {
  confirm.require({
    message: 'Foto ausblenden? Es kann jederzeit wiederhergestellt werden.',
    header: 'Foto ausblenden',
    icon: 'pi pi-eye-slash',
    rejectProps: {
      label: 'Abbrechen',
      severity: 'secondary',
      outlined: true
    },
    acceptProps: {
      label: 'Ausblenden',
      severity: 'warn'
    },
    accept: async () => {
      try {
        await deletePhoto(id)
        await reloadPhotosInPlace()
        if (selectedIndex.value >= photos.value.length) {
          selectedIndex.value = photos.value.length - 1
        }
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Ausblenden'
      }
    }
  })
}

// Fix #6: Reload photos without losing scroll position
async function reloadPhotosInPlace() {
  try {
    const [photosRes, groupsRes] = await Promise.all([
      listPhotos(showHidden.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    photos.value = photosRes.photos.sort((a, b) => {
      const dateA = new Date(a.taken_at || a.created_at).getTime();
      const dateB = new Date(b.taken_at || b.created_at).getTime();
      return dateB - dateA;
    });
    photoGroupsList.value = groupsRes.groups
  } catch {
    // Silently fail — non-critical
  }
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

function scrollToPhoto(photoId: number) {
  const index = photoIdToRowIndex.value.get(photoId)
  if (index !== undefined) {
    virtualizer.value.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
  }
}

function handleGroupClose() {
  const coverId = activeGroup.value?.cover_photo_id
  activeGroup.value = null
  reloadPhotosInPlace().then(() => {
    if (coverId) scrollToPhoto(coverId)
  })
}

// Fix #2: "Weiter" = mark reviewed + advance to next unreviewed group
function handleGroupNext(reviewedGroupId: number) {
  const next = photoGroupsList.value.find((g) => !g.reviewed_at && g.id !== reviewedGroupId)
  if (next) {
    activeGroup.value = next
    reloadPhotosInPlace()
  } else {
    const coverId = activeGroup.value?.cover_photo_id
    activeGroup.value = null
    reloadPhotosInPlace().then(() => {
      if (coverId) scrollToPhoto(coverId)
    })
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
    // Convert to ISO string for backend
    const takenAt = editDate.value.toISOString()
    await updatePhotoDate(photo.id, takenAt)
    
    // Update local photo object
    photo.taken_at = takenAt
    isEditingDate.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Aktualisieren des Datums'
  } finally {
    updatingDate.value = false
  }
}

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
  if (dragCounter.value === 0) {
    isDragging.value = false
  }
}

function handleDragOver(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

async function handleDrop(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  isDragging.value = false
  dragCounter.value = 0
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    await handleUpload(files)
  }
}

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
      if (selectedPhoto.value.curation_status !== 'hidden') {
        handleDelete(selectedPhoto.value.id)
      } else {
        handleRestore(selectedPhoto.value.id)
      }
      e.preventDefault()
    } else if ((e.key === 'f' || e.key === 'F') && selectedPhoto.value) {
      handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status)
      e.preventDefault()
    }
    return
  }

  if (photos.value.length === 0) return

  // Basic grid navigation
  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < photos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = photos.value.length - 1
  } else if (e.key === 'ArrowDown') {
    // Assume 4 columns for simpler navigation logic
    if (selectedIndex.value + 4 < photos.value.length) selectedIndex.value += 4
  } else if (e.key === 'ArrowUp') {
    if (selectedIndex.value - 4 >= 0) selectedIndex.value -= 4
  } else if (e.key === ' ') {
    if (selectedIndex.value !== -1) {
        isFullscreen.value = !isFullscreen.value
        e.preventDefault()
    }
  } else if (e.key === 'Enter') {
    if (selectedIndex.value !== -1) {
        isFullscreen.value = true
    }
  }
}

watch(selectedIndex, (newIdx) => {
  isEditingDate.value = false
  if (newIdx === -1 || isFullscreen.value) return
  const photo = photos.value[newIdx]
  if (photo) {
    const rowIndex = photoIdToRowIndex.value.get(photo.id)
    if (rowIndex !== undefined) {
      virtualizer.value.scrollToIndex(rowIndex, { align: 'auto', behavior: 'auto' })
    }
  }
})

watch(isFullscreen, (val) => {
  if (!val) isEditingDate.value = false
})

onMounted(() => {
  loadPhotos()
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', refreshVirtualLayout)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', refreshVirtualLayout)
  resizeObserver?.disconnect()
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
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-message">
        <i class="pi pi-upload"></i>
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>
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
          @click="handleStartGroupReview"
        />
        <FileUpload
          v-if="canUpload"
          mode="basic"
          name="file"
          accept="image/*"
          :auto="true"
          customUpload
          multiple
          :disabled="uploading"
          @uploader="handleUpload"
          chooseLabel="Fotos hochladen"
        />
      </div>
    </div>

    <div class="search-bar">
      <div class="search-input-wrapper">
        <i class="pi pi-search search-icon" />
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Fotos suchen, z.B. &quot;Kinder im Garten mit Hund&quot;"
          @keyup.enter="executeSearch"
          @keyup.escape="clearSearch"
        />
        <button v-if="searchQuery" class="search-clear" @click="clearSearch" aria-label="Suche leeren">
          <i class="pi pi-times" />
        </button>
      </div>
      <Button
        icon="pi pi-search"
        label="Suchen"
        :loading="searchLoading"
        :disabled="!searchQuery.trim()"
        @click="executeSearch"
      />
      <span v-if="searchResults !== null && !searchLoading" class="search-result-count">
        {{ searchResults.length }} {{ searchResults.length === 1 ? 'Treffer' : 'Treffer' }}
      </span>
    </div>

    <Message v-if="searchError" severity="error" @close="searchError = ''">{{ searchError }}</Message>
    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="uploading" class="info-text">Fotos werden hochgeladen...</div>
    <div v-else-if="loading" class="info-text">Lade Fotos...</div>
    <div v-else-if="photos.length === 0" class="info-text">Keine Fotos hochgeladen.</div>

    <div v-else class="gallery-container">
      <!-- Virtual scrolling container -->
      <div
        ref="gridContainerRef"
        class="photo-grid-virtual"
        :style="{ height: virtualizer.getTotalSize() + 'px', position: 'relative' }"
      >
        <div
          v-for="vRow in virtualizer.getVirtualItems()"
          :key="String(vRow.key)"
          :data-index="vRow.index"
          style="position: absolute; top: 0; left: 0; width: 100%;"
          :style="{ transform: `translateY(${vRow.start - scrollMargin}px)` }"
        >
          <!-- Year header -->
          <h2
            v-if="virtualRows[vRow.index]?.type === 'year-header'"
            :id="'year-' + (virtualRows[vRow.index] as { type: 'year-header'; year: string }).year"
            class="year-title"
          >
            {{ (virtualRows[vRow.index] as { type: 'year-header'; year: string }).year }}
          </h2>

          <!-- Month header -->
          <h3
            v-else-if="virtualRows[vRow.index]?.type === 'month-header'"
            :id="'month-' + (virtualRows[vRow.index] as { type: 'month-header'; year: string; month: string }).year + '-' + (virtualRows[vRow.index] as { type: 'month-header'; year: string; month: string }).month"
            class="month-title"
          >
            {{ (virtualRows[vRow.index] as { type: 'month-header'; year: string; month: string }).month }}
          </h3>

          <!-- Photo row -->
          <div v-else class="photo-row">
            <div
              v-for="item in (virtualRows[vRow.index] as { type: 'photos'; items: PhotoItem[] } | undefined)?.items ?? []"
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
              <HeicImage :src="getPhotoUrl(item.photo.filename, 400)" :alt="item.photo.original_name" loading="lazy" />
              <span v-if="item.group" class="stack-badge">{{ item.group.member_count }}</span>
              <i v-if="item.group?.reviewed_at" class="pi pi-check stack-reviewed-badge"></i>
              <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge"></i>
              <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-eye-slash hidden-badge"></i>
              <div class="photo-info">
                <span class="name">{{ item.group ? `${item.group.member_count} ähnliche Fotos` : item.photo.original_name }}</span>
                <div v-if="!inUnreviewedStack.has(item.photo.id)" class="photo-actions">
                  <Button
                    v-if="canDelete && item.photo.curation_status === 'hidden'"
                    icon="pi pi-eye"
                    severity="info"
                    text
                    rounded
                    v-tooltip="'Wiederherstellen'"
                    @click.stop="handleRestore(item.photo.id)"
                  />
                  <Button
                    v-if="canDelete && item.photo.curation_status !== 'hidden'"
                    :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
                    :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
                    text
                    rounded
                    v-tooltip="'Favorit'"
                    @click.stop="handleToggleFavorite(item.photo.id, item.photo.curation_status)"
                  />
                  <Button
                    v-if="canDelete && item.photo.curation_status !== 'hidden'"
                    icon="pi pi-eye-slash"
                    severity="danger"
                    text
                    rounded
                    v-tooltip="'Ausblenden'"
                    @click.stop="handleDelete(item.photo.id)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <nav class="timeline-nav">
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
      </nav>

      <div class="details-sidebar" v-if="selectedPhoto">
        <div class="sidebar-header">
          <h3>Details</h3>
          <Button icon="pi pi-times" text rounded size="small" @click="selectedIndex = -1" />
        </div>
        
        <div class="sidebar-content">
          <div class="preview-container" @click="isFullscreen = true" title="Klicken für Vollbild">
            <HeicImage :src="getPhotoUrl(selectedPhoto.filename)" :alt="selectedPhoto.original_name" />
            <div class="preview-overlay">
              <i class="pi pi-expand"></i>
            </div>
          </div>
          
          <div class="info-group">
            <label>Dateiname</label>
            <div class="value">{{ selectedPhoto.original_name }}</div>
          </div>
          
          <div class="info-group">
            <label>Aufnahmedatum</label>
            <div v-if="!isEditingDate" class="date-display">
              <div class="value">{{ formatPhotoDate(selectedPhoto) }}</div>
              <Button
                v-if="canUpload"
                icon="pi pi-pencil" 
                text 
                rounded 
                size="small" 
                @click="startEditingDate" 
                class="edit-btn" 
              />
            </div>
            <div v-else class="date-editor">
              <DatePicker v-model="editDate" showTime hourFormat="24" fluid />
              <div class="edit-actions">
                <Button icon="pi pi-check" severity="success" text rounded @click="handleUpdateDate" :loading="updatingDate" />
                <Button icon="pi pi-times" severity="danger" text rounded @click="isEditingDate = false" :disabled="updatingDate" />
              </div>
            </div>
          </div>

          <div class="info-group" v-if="selectedPhoto.size">
            <label>Größe</label>
            <div class="value">{{ (selectedPhoto.size / 1024 / 1024).toFixed(2) }} MB</div>
          </div>

          <div class="sidebar-actions">
            <Button 
              label="Vollbild" 
              icon="pi pi-expand" 
              @click="isFullscreen = true" 
              class="w-full" 
              severity="secondary"
            />
            
            <Button
              v-if="canDelete && selectedPhoto.curation_status === 'hidden'"
              label="Wiederherstellen"
              icon="pi pi-eye"
              @click="handleRestore(selectedPhoto.id)"
              class="w-full"
              severity="info"
              text
            />
            <Button
              v-if="canDelete && selectedPhoto.curation_status !== 'hidden'"
              :label="selectedPhoto.curation_status === 'favorite' ? 'Kein Favorit' : 'Favorit'"
              :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              @click="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)"
              class="w-full"
              severity="warn"
              text
            />
            <Button
              v-if="canDelete && selectedPhoto.curation_status !== 'hidden'"
              label="Ausblenden"
              icon="pi pi-eye-slash"
              @click="handleDelete(selectedPhoto.id)"
              class="w-full"
              severity="danger"
              text
            />
          </div>

          <div class="info-group mt-4" v-if="auth.hasPermission('people.view')">
            <label>Erkannte Personen</label>
            <div v-if="loadingFaces" class="flex items-center gap-2 text-sm text-gray-500">
              <i class="pi pi-spin pi-spinner"></i>
              Lade Personen...
            </div>
            <div v-else-if="detectedFaces.filter(f => !f.ignored).length === 0" class="text-sm text-gray-500 italic">
              Keine Personen erkannt
            </div>
            <div v-else class="flex flex-col gap-2 mt-1">
              <div 
                v-for="face in detectedFaces.filter(f => !f.ignored)" 
                :key="face.id"
                class="flex items-center justify-between p-2 bg-gray-50 rounded border"
              >
                <span class="text-sm font-medium">{{ getPersonName(face.person_id) }}</span>
                <Button 
                  icon="pi pi-user-minus" 
                  severity="secondary" 
                  text 
                  rounded 
                  size="small"
                  @click="handleIgnoreFace(face.id)"
                  v-tooltip="'Person aus Bild entfernen'"
                />
              </div>
            </div>
            
            <Button 
              label="Gesichter neu suchen" 
              icon="pi pi-search" 
              @click="handleReindexPhoto"
              :loading="reindexingPhoto"
              class="w-full mt-4"
              severity="secondary"
              outlined
              size="small"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="isFullscreen && selectedPhoto" class="fullscreen-overlay" @click="isFullscreen = false">
      <!-- Preload next and previous image -->
      <div style="display: none">
        <HeicImage v-if="prevPhoto" :src="getPhotoUrl(prevPhoto.filename)" />
        <HeicImage v-if="nextPhoto" :src="getPhotoUrl(nextPhoto.filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(selectedPhoto.filename)" :alt="selectedPhoto.original_name" objectFit="contain" />

        <!-- Top bar: back | date | toolbar -->
        <div class="fs-topbar">
          <Button icon="pi pi-arrow-left" class="fs-topbar-btn" rounded text
            aria-label="Zurück"
            @click="isFullscreen = false" />
          <div class="fs-date-bar">{{ formatPhotoDateFull(selectedPhoto) }}</div>
          <div class="fs-toolbar">
            <Button
              v-if="selectedPhoto.curation_status === 'hidden'"
              icon="pi pi-eye"
              class="fs-topbar-btn" rounded text
              severity="warn"
              aria-label="Auswählen, um das Bild wieder anzuzeigen"
              @click="handleRestore(selectedPhoto.id)"
            />
            <Button
              v-else
              icon="pi pi-eye-slash"
              class="fs-topbar-btn" rounded text
              severity="info"
              aria-label="Auswählen, um das Bild auszublenden"
              @click="handleDelete(selectedPhoto.id)"
            />
            <Button
              :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              class="fs-topbar-btn" rounded text
              :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'"
              :aria-label="selectedPhoto.curation_status === 'favorite' ? 'Auswählen, um den Favoritenstatus zu entfernen' : 'Auswählen, um als Favorit zu markieren'"
              @click="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)"
            />
          </div>
        </div>

        <!-- Left/right navigation -->
        <Button v-if="selectedIndex > 0" icon="pi pi-chevron-left" class="fs-nav-left-right fs-nav-left" rounded text
          @click="selectedIndex > 0 && selectedIndex--" />
        <Button v-if="selectedIndex < photos.length - 1" icon="pi pi-chevron-right" class="fs-nav-left-right  fs-nav-right" rounded text
          @click="selectedIndex < photos.length - 1 && selectedIndex++" />
      </div>
    </div>

    <!-- Photo Compare Mode -->
    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :allPhotos="photos"
      :totalUnreviewed="unreviewedGroupCount"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.progress-container {
  margin-bottom: 2rem;
  background: var(--surface-card);
  padding: 1rem;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.progress-info {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
  color: var(--text-color-secondary);
}

.info-text {
  text-align: center;
  margin: 3rem 0;
  color: var(--text-color-secondary);
}

.photo-grid-virtual {
  flex: 1;
  min-width: 0;
}

.photo-row {
  display: grid;
  grid-template-columns: repeat(v-bind(columnCount), 1fr);
  gap: 1rem;
  padding-bottom: 1rem;
}

.gallery-container {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
  position: relative;
}

.timeline-nav {
  position: sticky;
  top: 1rem;
  width: 80px;
  background: var(--surface-card);
  padding: 1rem 0.5rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  z-index: 100;
  flex-shrink: 0;
}

.details-sidebar {
  position: sticky;
  top: 1rem;
  width: 300px;
  background: var(--surface-card);
  padding: 1.5rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  z-index: 90;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 0.5rem;
  margin-bottom: 0.5rem;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 1.2rem;
}

.preview-container {
  position: relative;
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 1rem;
}

.preview-container :deep(.heic-image-container) {
  height: 180px;
  width: 100%;
}

.preview-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s;
  color: white;
  font-size: 1.5rem;
}

.preview-container:hover .preview-overlay {
  opacity: 1;
}

.info-group {
  margin-bottom: 1.25rem;
}

.info-group label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-color-secondary);
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.info-group .value {
  font-size: 0.95rem;
  word-break: break-all;
  color: var(--text-color);
}

.date-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.date-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--surface-ground);
  border-radius: 6px;
}

.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 1rem;
}

.w-full {
  width: 100%;
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

.nav-year:hover {
  background: var(--p-primary-50);
}

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

.nav-year.active {
  background: var(--p-primary-color);
  color: white;
}

.nav-month.active {
  color: var(--p-primary-color);
  font-weight: bold;
  background: var(--p-primary-50);
}

.year-title {
  border-bottom: 2px solid var(--p-primary-color);
  padding-bottom: 0.5rem;
  margin-top: 2.5rem;
  margin-bottom: 0.5rem;
  font-size: 1.5rem;
}

.month-title {
  color: var(--text-color-secondary);
  font-weight: 500;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
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

.photo-item:hover {
  transform: scale(1.02);
}

.photo-item.selected {
  border-color: var(--p-primary-color);
  transform: scale(1.05);
  box-shadow: 0 0 15px var(--p-primary-color);
  z-index: 10;
}

.photo-item.selected :deep(img) {
  filter: brightness(1.1);
}

/* .photo-grid:has(.photo-item.selected) .photo-item:not(.selected) {
  opacity: 0.7;
  filter: grayscale(0.2);
} */

.photo-item :deep(.heic-image-container) {
  width: 100%;
  height: 200px;
}

.photo-info {
  padding: 0.25rem 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.photo-item:hover .photo-info, .photo-item.selected .photo-info {
  opacity: 1;
}

.photo-info .name {
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  color: white;
}

.photo-actions {
  display: flex;
  gap: 0;
}

.photo-item.is-hidden {
  opacity: 0.35;
}

.photo-item.is-hidden:hover {
  opacity: 0.7;
}

.photo-item.is-favorite {
  border-color: var(--p-yellow-500);
}

.favorite-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--p-yellow-500);
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}

.hidden-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  color: white;
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}

.toggle-hidden {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Semantic Search Bar */
.search-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0 0.5rem;
  flex-wrap: wrap;
}

.search-input-wrapper {
  position: relative;
  flex: 1;
  min-width: 240px;
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
  padding: 0.5rem 2.25rem 0.5rem 2.25rem;
  border: 1px solid var(--surface-300);
  border-radius: 6px;
  background: var(--surface-0);
  color: var(--text-color);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
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
  align-items: center;
  border-radius: 4px;
}

.search-clear:hover {
  color: var(--text-color);
  background: var(--surface-100);
}

.search-result-count {
  font-size: 0.875rem;
  color: var(--text-color-secondary);
  white-space: nowrap;
}

/* Stack styles — layered cards behind the cover photo */
.photo-item.is-stack {
  position: relative;
  margin: 6px 6px 6px 6px;
}

.photo-item.is-stack::before,
.photo-item.is-stack::after {
  content: '';
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  background: var(--surface-card);
  border-radius: 8px;
  z-index: -1;
  border: 1px solid var(--surface-300);
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}

.photo-item.is-stack::before {
  transform: rotate(-3deg);
  top: -4px;
  left: -5px;
}

.photo-item.is-stack::after {
  transform: rotate(2.5deg);
  top: -3px;
  right: -5px;
}

.stack-badge {
  position: absolute;
  top: 8px;
  left: 8px;
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
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.stack-reviewed-badge {
  position: absolute;
  top: 8px;
  left: 42px;
  background: var(--p-green-500);
  color: white;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  font-size: 0.7rem;
  border-radius: 11px;
  z-index: 5;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--p-slate-950);
  z-index: 1100;
}

.fullscreen-content {
  position: relative;
  width: 100%;
  height: 100%;
}

.fullscreen-content :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.fullscreen-content :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.fs-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.25rem;
  pointer-events: none;
  background-color: var(--p-neutral-50);
}

.fs-topbar > * {
  display: flex;
  pointer-events: auto;
  color: var(--p-text-color);
}

.fs-date-bar {
  white-space: nowrap;
  pointer-events: none;
}

.fs-toolbar {
  display: flex;
  gap: 0.25rem;
}

.fs-nav-left-right {
  position: absolute;
  top: 50%;
  z-index: 10;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.fullscreen-content:hover .fs-nav-left-right {
  opacity: 1;
}

.fs-nav-left {
  left: 0.75rem;
}

.fs-nav-right {
  right: 0.75rem;
}

.edit-actions {
  display: flex;
  gap: 0.5rem;
}

@media (max-width: 1200px) {
  .details-sidebar {
    width: 250px;
  }
}

@media (max-width: 1024px) {
  .gallery-container {
    flex-direction: column;
    gap: 1rem;
  }

  .photo-grid-virtual {
    width: 100%;
  }

  .timeline-nav {
    width: 100%;
    order: -1;
    position: sticky;
    top: 0.5rem;
    max-height: none;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.5rem;
    gap: 0.75rem;
    z-index: 120;
  }

  .nav-year-group {
    flex-direction: row;
    align-items: center;
    white-space: nowrap;
  }

  .nav-months {
    flex-direction: row;
    white-space: nowrap;
  }

  .details-sidebar {
    width: 100%;
    position: static;
    max-height: none;
  }
}

@media (max-width: 640px) {
  .gallery-container {
    gap: 0.75rem;
  }

  .timeline-nav {
    top: 0;
    padding: 0.4rem;
    gap: 0.5rem;
    border-radius: 6px;
  }

  .nav-year-group {
    gap: 0.35rem;
  }

  .nav-year {
    font-size: 0.8rem;
    padding: 0.15rem 0.35rem;
  }

  .nav-months {
    gap: 0.15rem;
  }

  .nav-month {
    font-size: 0.68rem;
    padding: 0.1rem 0.25rem;
  }

  .photo-row {
    gap: 0.625rem;
    padding-bottom: 0.75rem;
  }

  .photo-item {
    border-radius: 6px;
  }

  .photo-item :deep(.heic-image-container) {
    height: 170px;
  }

  .details-sidebar {
    padding: 1rem;
    gap: 0.75rem;
    border-radius: 6px;
  }

  .sidebar-header h3 {
    font-size: 1.05rem;
  }

  .info-group {
    margin-bottom: 0.9rem;
  }

  .info-group label {
    font-size: 0.7rem;
  }

  .info-group .value {
    font-size: 0.9rem;
  }

  .sidebar-actions {
    gap: 0.4rem;
    padding-top: 0.75rem;
  }

  .close-btn {
    right: 0.5rem;
    top: 0.5rem;
  }
}

.drag-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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
  background: var(--surface-card);
  padding: 2rem 3rem;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.1);
  color: var(--p-primary-color);
  font-size: 1.5rem;
  font-weight: bold;
}

.drag-message i {
  font-size: 3rem;
}
</style>
