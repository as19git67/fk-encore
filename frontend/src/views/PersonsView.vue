<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted, nextTick } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import { useConfirm } from 'primevue/useconfirm'
import InputText from 'primevue/inputtext'
import HeicImage from '../components/HeicImage.vue'
import { listPersons, updatePerson, mergePersons, getPhotoUrl, getPersonDetails, ignoreFace, ignorePersonFaces, updatePhotoCuration, deletePhoto, type CurationStatus, type Person, type Photo, type PersonDetails } from '../api/photos'

const persons = ref<Person[]>([])
const enableLocalFaces = ref(true)
const loading = ref(true)
const error = ref('')

// Detailed view state
const selectedPersonDetail = ref<PersonDetails | null>(null)
const loadingDetails = ref(false)

// Fullscreen state
const isFullscreen = ref(false)
const selectedIndex = ref(-1)

const personFaceItems = computed(() => {
    if (!selectedPersonDetail.value) return []
    return selectedPersonDetail.value.faces
        .filter(f => !!f.photo)
        .map(f => ({ face: f, photo: f.photo as Photo }))
})

const personPhotos = computed(() => {
    return personFaceItems.value.map(item => item.photo)
})

const firstPersonFaceItem = computed(() => {
    return personFaceItems.value[0] ?? null
})

const selectedPersonPhoto = computed(() => {
    if (selectedIndex.value < 0) return null
    return personPhotos.value[selectedIndex.value] ?? null
})

const prevPersonPhoto = computed(() => {
    if (selectedIndex.value <= 0) return null
    return personPhotos.value[selectedIndex.value - 1] ?? null
})

const nextPersonPhoto = computed(() => {
    if (selectedIndex.value < 0 || selectedIndex.value >= personPhotos.value.length - 1) return null
    return personPhotos.value[selectedIndex.value + 1] ?? null
})

const selectedPersonFace = computed(() => {
    if (selectedIndex.value < 0) return null
    return personFaceItems.value[selectedIndex.value]?.face ?? null
})

const showRenameDialog = ref(false)
const personToRename = ref<Person | null>(null)
const newName = ref('')
const inlineRenamePersonId = ref<number | null>(null)
const inlineRenameValue = ref('')
const inlineRenameSaving = ref(false)
const inlineRenameInputRef = ref<HTMLInputElement | null>(null)

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

const showMergeDialog = ref(false)
const mergeSourceIds = ref<number[]>([])
const mergeTargetId = ref<number | null>(null)

const selectedPersonIds = ref<number[]>([])
const multiSelectMode = ref(false)
const confirm = useConfirm()

function toggleSelect(id: number) {
    if (!multiSelectMode.value) return
    const index = selectedPersonIds.value.indexOf(id)
    if (index === -1) {
        selectedPersonIds.value.push(id)
    } else {
        selectedPersonIds.value.splice(index, 1)
    }
}

function cancelMultiSelect() {
    multiSelectMode.value = false
    selectedPersonIds.value = []
}

function openMergeDialog() {
    if (selectedPersonIds.value.length < 2) return
    mergeSourceIds.value = [...selectedPersonIds.value]
    // Default target: first selected named person (can be changed in dialog)
    const firstNamed = mergeSourceIds.value.find(id => {
        const p = persons.value.find(p => p.id === id)
        return p && p.name !== 'Unbenannt'
    })
    mergeTargetId.value = firstNamed ?? null
    showMergeDialog.value = true
}

async function handleMerge() {
    if (mergeTargetId.value == null || mergeSourceIds.value.length < 2) return

    // sourceIds for backend should not include targetId (backend handles it anyway, but cleaner)
    const sources = mergeSourceIds.value.filter(id => id !== mergeTargetId.value)
    
    try {
        await mergePersons(sources, mergeTargetId.value)
        showMergeDialog.value = false
        multiSelectMode.value = false
        selectedPersonIds.value = []
        await loadData()
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Zusammenführen'
    }
}

const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024)

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await listPersons()
    enableLocalFaces.value = res.enableLocalFaces
    // Filter out persons with 0 faces (orphans) to keep the list clean
    // Some backend databases might return faceCount as string, ensure it's a number
    persons.value = res.persons
        .filter(p => {
            const count = Number(p.faceCount || 0)
            return count > 0
        })
        .sort((a, b) => {
            if (a.name === 'Unbenannt' && b.name !== 'Unbenannt') return 1
            if (a.name !== 'Unbenannt' && b.name === 'Unbenannt') return -1
            const countA = Number(a.faceCount || 0)
            const countB = Number(b.faceCount || 0)
            return countB - countA
        })
    
    // Refresh detailed view if open
    if (selectedPersonDetail.value) {
        await openPersonDetails(selectedPersonDetail.value)
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Personen'
  } finally {
    loading.value = false
  }
}

async function openPersonDetails(person: Pick<Person, 'id'>) {
    loadingDetails.value = true
    error.value = ''
    try {
        selectedPersonDetail.value = await getPersonDetails(person.id)
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Laden der Details'
    } finally {
        loadingDetails.value = false
    }
}

function closePersonDetails() {
    selectedPersonDetail.value = null
    isFullscreen.value = false
    selectedIndex.value = -1
}

function openRename(person: Person) {
    personToRename.value = person
    newName.value = person.name === 'Unbenannt' ? '' : person.name
    showRenameDialog.value = true
}

function startInlineRename(person: Person) {
    if (multiSelectMode.value || inlineRenameSaving.value) return
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
    const person = persons.value.find((p) => p.id === inlineRenamePersonId.value)
    if (!person) {
        cancelInlineRename()
        return
    }

    const trimmedName = inlineRenameValue.value.trim()
    if (!trimmedName || trimmedName.toLowerCase() === 'unbenannt') return
    if (trimmedName === person.name.trim()) {
        cancelInlineRename()
        return
    }

    personToRename.value = person
    newName.value = inlineRenameValue.value
    inlineRenameSaving.value = true
    const renamed = await handleRename()
    inlineRenameSaving.value = false

    if (renamed) {
        inlineRenamePersonId.value = null
        inlineRenameValue.value = ''
    }
}

function handlePersonInfoClick(person: Person) {
    if (multiSelectMode.value) {
        toggleSelect(person.id)
        return
    }
    startInlineRename(person)
}

async function handleRename(): Promise<boolean> {
    if (!personToRename.value) return false

    const sourcePersonId = personToRename.value.id
    const trimmedName = newName.value.trim()
    if (!trimmedName || trimmedName.toLowerCase() === 'unbenannt') return false

    const mergeCandidate = duplicateNamePerson.value
    let detailIdToReload: number | null = null

    if (selectedPersonDetail.value) {
        const selectedId = selectedPersonDetail.value.id
        if (selectedId === sourcePersonId || (mergeCandidate && selectedId === mergeCandidate.id)) {
            detailIdToReload = sourcePersonId
        }
    }

    try {
        await updatePerson(sourcePersonId, trimmedName)

        // If another person already has this name, merge both identities into the renamed one.
        if (mergeCandidate) {
            await mergePersons([mergeCandidate.id], sourcePersonId)
        }

        showRenameDialog.value = false
        await loadData()

        if (detailIdToReload) {
            await openPersonDetails({ id: detailIdToReload })
        } else if (selectedPersonDetail.value && selectedPersonDetail.value.id === sourcePersonId) {
            selectedPersonDetail.value.name = trimmedName
        }
        return true
    } catch (err: any) {
        error.value = err.message || 'Fehler beim Umbenennen'
        return false
    }
}

async function handleIgnoreFace(faceId: number) {
    confirm.require({
        message: 'Dieses Gesicht wirklich ignorieren? Es wird aus allen Personenlisten entfernt.',
        header: 'Bestätigung',
        icon: 'pi pi-exclamation-triangle',
        rejectProps: {
            label: 'Abbrechen',
            severity: 'secondary',
            outlined: true
        },
        acceptProps: {
            label: 'Ignorieren',
            severity: 'danger'
        },
        accept: async () => {
            try {
                await ignoreFace(faceId)

                // Remove from current detail view
                if (selectedPersonDetail.value) {
                    selectedPersonDetail.value.faces = selectedPersonDetail.value.faces.filter(f => f.id !== faceId)

                    // If no faces left, close details and refresh list
                    if (selectedPersonDetail.value.faces.length === 0) {
                        closePersonDetails()
                        await loadData()
                    } else {
                        // Adjust selected index if needed
                        if (selectedIndex.value >= selectedPersonDetail.value.faces.length) {
                            selectedIndex.value = selectedPersonDetail.value.faces.length - 1
                        }
                    }
                }
            } catch (err: any) {
                error.value = err.message || 'Fehler beim Ignorieren des Gesichts'
            }
        }
    })
}

async function handleIgnorePerson(personId: number) {
    confirm.require({
        message: 'Diese Person und alle ihre Gesichtserkennungen wirklich ignorieren?',
        header: 'Bestätigung',
        icon: 'pi pi-exclamation-triangle',
        rejectProps: {
            label: 'Abbrechen',
            severity: 'secondary',
            outlined: true
        },
        acceptProps: {
            label: 'Ignorieren',
            severity: 'danger'
        },
        accept: async () => {
            try {
                await ignorePersonFaces(personId)
                closePersonDetails()
                await loadData()
            } catch (err: any) {
                error.value = err.message || 'Fehler beim Ignorieren der Person'
            }
        }
    })
}


function getCoverUrl(person: Person) {
    if (person.cover_filename) {
        return getPhotoUrl(person.cover_filename)
    }
    return 'https://www.primefaces.org/wp-content/uploads/2020/05/placeholder.png'
}

function getFaceStyle(
    person: Person | { cover_bbox?: any },
    options?: {
        targetFaceRatio?: number
        maxZoom?: number
        objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'
    }
) {
    if (!person.cover_bbox) return {}
    
    // cover_bbox values should be relative (0..1)
    const { x, y, width, height } = person.cover_bbox
    const objectFit = options?.objectFit ?? 'cover'
    
    // If we have absolute values (likely old data), fallback to cover
    if (x > 1.1 || y > 1.1 || width > 1.1 || height > 1.1) {
        return { objectFit }
    }
    
    // We want to center the face. 
    // The center of the face in relative coordinates:
    const centerX = x + width / 2
    const centerY = y + height / 2
    
    // Tune zoom so large hero images do not over-zoom on small/very tight detections.
    const targetFaceRatio = options?.targetFaceRatio ?? 0.6
    const maxZoom = options?.maxZoom ?? 4
    const zoom = Math.max(1, Math.min(maxZoom, targetFaceRatio / Math.max(width, height)))

    return {
        transform: `scale(${zoom})`,
        transformOrigin: `${centerX * 100}% ${centerY * 100}%`,
        objectFit,
        display: 'block'
    }
}

function getHeroFaceTransform(bbox: any) {
    if (!bbox) return {}

    const { x, y, width, height } = bbox
    if (x > 1.1 || y > 1.1 || width > 1.1 || height > 1.1) return {}

    const centerX = x + width / 2
    const centerY = y + height / 2
    const heroWidth = Math.min(1024, Math.max(320, viewportWidth.value - 32))
    const targetFaceRatio = Math.max(0.25, Math.min(0.35, 300 / heroWidth))
    const zoom = Math.max(1, Math.min(2.4, targetFaceRatio / Math.max(width, height, 0.01)))

    return {
        transform: `scale(${zoom})`,
        transformOrigin: `${centerX * 100}% ${centerY * 100}%`
    }
}

function getHeroImageStyle(bbox: any) {
    return {
        objectFit: 'scale-down',
        display: 'block',
        ...getHeroFaceTransform(bbox)
    }
}

function getHeroFaceHighlightStyle(bbox: any) {
    // Use only the base style without additional transform
    // The image itself is already transformed, so the highlight should stay in place
    return getFaceHighlightStyle(bbox)
}

function handleResize() {
    viewportWidth.value = window.innerWidth
}

function getFaceHighlightStyle(bbox: any, isGridItem: boolean = false) {
    if (!bbox || isGridItem) return { display: 'none' }
    
    // bbox values should be relative (0..1)
    // If they are > 1, they are likely old absolute pixel values (e.g. 2793)
    // In that case, we can't display them correctly without image dimensions.
    // We cap them to avoid UI explosion (like 279345%).
    const { x, y, width, height } = bbox
    
    // Check if values are likely absolute pixel values
    const isAbsolute = x > 1.1 || y > 1.1 || width > 1.1 || height > 1.1
    
    if (isAbsolute) {
        // Return a dummy style or something that indicates an error
        // But better to just not show it or try to guess if it's very large
        return { display: 'none' }
    }
    
    const style: any = {
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
        position: 'absolute',
        pointerEvents: 'none'
    }

    return style
}

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

async function handleHidePhoto(id: number) {
  confirm.require({
    message: 'Foto ausblenden? Es kann jederzeit wiederhergestellt werden.',
    header: 'Foto ausblenden',
    icon: 'pi pi-eye-slash',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Ausblenden', severity: 'warn' },
    accept: async () => {
      try {
        await deletePhoto(id)
        if (selectedPersonDetail.value) {
          const photo = personPhotos.value[selectedIndex.value]
          if (photo) photo.curation_status = 'hidden'
        }
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Ausblenden'
      }
    }
  })
}

async function handleRestorePhoto(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    const photo = personPhotos.value[selectedIndex.value]
    if (photo) photo.curation_status = 'visible'
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Wiederherstellen'
  }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  const photo = personPhotos.value[selectedIndex.value]
  if (photo) photo.curation_status = newStatus
  try {
    await updatePhotoCuration(id, newStatus)
  } catch (err: any) {
    if (photo) photo.curation_status = currentStatus
    error.value = err.message || 'Fehler beim Ändern des Favoriten-Status'
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (!isFullscreen.value || selectedIndex.value === -1) return

  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < personPhotos.value.length - 1) selectedIndex.value++
    e.preventDefault()
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
    e.preventDefault()
  } else if (e.key === 'Escape' || e.key === ' ') {
    isFullscreen.value = false
    e.preventDefault()
  } else if ((e.key === 'x' || e.key === 'X') && selectedPersonPhoto.value) {
    if (selectedPersonPhoto.value.curation_status !== 'hidden') {
      handleHidePhoto(selectedPersonPhoto.value.id)
    } else {
      handleRestorePhoto(selectedPersonPhoto.value.id)
    }
    e.preventDefault()
  } else if ((e.key === 'f' || e.key === 'F') && selectedPersonPhoto.value) {
    handleToggleFavorite(selectedPersonPhoto.value.id, selectedPersonPhoto.value.curation_status)
    e.preventDefault()
  }
}

onMounted(() => {
  loadData()
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <div class="p-4">
    <div class="flex justify-between items-center mb-6">
      <div class="flex items-center gap-4">
          <Button v-if="selectedPersonDetail" icon="pi pi-arrow-left" class="p-button-text p-button-rounded" @click="closePersonDetails" />
          <h1 class="text-3xl font-bold">{{ selectedPersonDetail ? selectedPersonDetail.name : 'Personen' }}</h1>
          <div v-if="!selectedPersonDetail && multiSelectMode" class="flex items-center gap-2 ml-4">
              <span class="text-lg font-medium">{{ selectedPersonIds.length }} ausgewählt</span>
              <Button label="Abbrechen" class="p-button-text p-button-sm" @click="cancelMultiSelect" />
          </div>
      </div>
      <div class="flex items-center gap-4">
          <div class="flex gap-4">
              <template v-if="!selectedPersonDetail">
                  <Button v-if="multiSelectMode" icon="pi pi-clone" label="Zusammenführen" class="p-button-success" @click="openMergeDialog" :disabled="selectedPersonIds.length < 2" />
                  <Button v-else-if="persons.length > 0" icon="pi pi-check-square" label="Auswählen" class="p-button-outlined" @click="multiSelectMode = true" />
              </template>
              <template v-if="selectedPersonDetail">
                  <Button icon="pi pi-pencil" label="Umbenennen" class="p-button-outlined" @click="openRename(selectedPersonDetail)" />
                  <Button icon="pi pi-trash" label="Ignorieren" class="p-button-outlined p-button-danger" @click="handleIgnorePerson(selectedPersonDetail.id)" v-tooltip="'Diese Person und alle ihre Gesichtserkennungen dauerhaft ignorieren'" />
              </template>
              <Button icon="pi pi-refresh" label="Aktualisieren" @click="loadData" :loading="loading" />
          </div>
      </div>
    </div>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

    <!-- Person List View -->
    <div v-if="!selectedPersonDetail">
        <div v-if="persons.some(p => p.cover_bbox && (p.cover_bbox.x > 1.1 || p.cover_bbox.width > 1.1))" class="mb-4">
            <Message severity="warn" :closable="false">
                Einige Gesichtskoordinaten scheinen veraltet zu sein. Bitte scannen Sie alle Fotos erneut unter <b>Datenverwaltung</b>.
            </Message>
        </div>

        <div v-if="loading && persons.length === 0" class="text-center p-8">
          <i class="pi pi-spin pi-spinner text-4xl mb-2"></i>
          <p>Personen werden geladen...</p>
        </div>

        <div v-else-if="persons.length === 0" class="text-center p-8 bg-gray-50 rounded-xl border-2 border-dashed">
          <i class="pi pi-users text-5xl text-gray-400 mb-4"></i>
          <p class="text-xl text-gray-500">Keine Personen erkannt.</p>
          <p class="text-gray-400">Lade Fotos hoch, um die automatische Erkennung zu starten.</p>
        </div>

        <div v-else class="persons-grid">
          <div 
            v-for="person in persons" 
            :key="person.id"
            class="person-item"
            :class="{ 'selected': selectedPersonIds.includes(person.id) }"
            @click="multiSelectMode ? toggleSelect(person.id) : openPersonDetails(person)"
          >
            <div class="person-cover">
              <HeicImage 
                :src="getCoverUrl(person)" 
                :alt="person.name"
                class="person-img"
                objectFit="scale-down"
                :imageStyle="getFaceStyle(person, { objectFit: 'scale-down' })"
              >
                <div class="face-highlight" :style="getFaceHighlightStyle(person.cover_bbox, true)" style="border: none !important; box-shadow: none !important;"></div>
              </HeicImage>
              <div v-if="multiSelectMode" class="selection-overlay">
                  <div class="selection-checkbox" :class="{ 'checked': selectedPersonIds.includes(person.id) }">
                      <i v-if="selectedPersonIds.includes(person.id)" class="pi pi-check"></i>
                  </div>
              </div>
              <div class="person-badge">
                {{ person.faceCount }} {{ person.faceCount === 1 ? 'Foto' : 'Fotos' }}
              </div>
            </div>
            <div class="person-info" @click.stop="handlePersonInfoClick(person)">
              <div v-if="inlineRenamePersonId === person.id" class="person-rename-row">
                <input
                  ref="inlineRenameInputRef"
                  v-model="inlineRenameValue"
                  class="person-name-input"
                  type="text"
                  autocomplete="off"
                  :disabled="inlineRenameSaving"
                  @click.stop
                  @keydown.enter.prevent.stop="submitInlineRename"
                  @keydown.esc.prevent.stop="cancelInlineRename"
                />
                <Button
                  icon="pi pi-check"
                  class="person-rename-btn p-button-rounded p-button-sm p-button-text"
                  :disabled="inlineRenameSaving || !inlineRenameValue.trim() || inlineRenameValue.trim().toLowerCase() === 'unbenannt'"
                  @click.stop="submitInlineRename"
                />
                <Button
                  icon="pi pi-times"
                  class="person-rename-btn p-button-rounded p-button-sm p-button-text"
                  :disabled="inlineRenameSaving"
                  @click.stop="cancelInlineRename"
                />
              </div>
              <h3 v-else class="person-name truncate">{{ person.name }}</h3>
            </div>
          </div>
        </div>
    </div>

    <!-- Person Details View (Photo Grid) -->
    <div v-else>
        <div v-if="loadingDetails" class="text-center p-8">
            <i class="pi pi-spin pi-spinner text-4xl mb-2"></i>
            <p>Fotos werden geladen...</p>
        </div>
        <div v-else>
            <div
                v-if="firstPersonFaceItem"
                class="person-hero"
                @click="selectedIndex = 0; isFullscreen = true"
            >
                <HeicImage
                    :src="getPhotoUrl(firstPersonFaceItem.photo.filename)"
                    :alt="firstPersonFaceItem.photo.original_name"
                    class="person-hero-image"
                    objectFit="scale-down"
                    :imageStyle="getHeroImageStyle(firstPersonFaceItem.face.bbox)"
                >
                    <div class="face-highlight" :style="getHeroFaceHighlightStyle(firstPersonFaceItem.face.bbox)"></div>
                </HeicImage>
            </div>

            <div class="photo-grid">
            <div
                v-for="(item, idx) in personFaceItems.slice(1)"
                :key="item.face.id"
                class="photo-item"
                @click="selectedIndex = idx + 1; isFullscreen = true"
            >
                <HeicImage :src="getPhotoUrl(item.photo.filename)" :alt="item.photo.original_name">
                    <div class="face-highlight" :style="getFaceHighlightStyle(item.face.bbox, true)"></div>
                </HeicImage>
                <div class="photo-overlay">
                    <div class="photo-name">{{ item.photo.original_name }}</div>
                    <Button 
                        icon="pi pi-trash" 
                        class="p-button-rounded p-button-danger p-button-text ignore-btn" 
                        @click.stop="handleIgnoreFace(item.face.id)"
                        v-tooltip="'Gesicht ignorieren'"
                    />
                </div>
            </div>
            </div>
        </div>
    </div>

    <!-- Fullscreen Overlay -->
    <div v-if="isFullscreen && selectedPersonPhoto" class="fullscreen-overlay" @click="isFullscreen = false">
      <div style="display: none">
        <HeicImage v-if="prevPersonPhoto" :src="getPhotoUrl(prevPersonPhoto.filename)" />
        <HeicImage v-if="nextPersonPhoto" :src="getPhotoUrl(nextPersonPhoto.filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(selectedPersonPhoto.filename)" :alt="selectedPersonPhoto.original_name" objectFit="contain">
          <div class="face-highlight" :style="getFaceHighlightStyle(selectedPersonFace?.bbox)"></div>
        </HeicImage>

        <!-- Top bar: back | date | toolbar -->
        <div class="fs-topbar">
          <Button icon="pi pi-arrow-left" class="fs-topbar-btn" rounded text
            aria-label="Zurück"
            @click="isFullscreen = false" />
          <div class="fs-date-bar">{{ formatPhotoDate(selectedPersonPhoto) }}</div>
          <div class="fs-toolbar">
            <Button
              v-if="selectedPersonPhoto.curation_status === 'hidden'"
              icon="pi pi-eye"
              class="fs-topbar-btn" rounded text
              severity="info"
              aria-label="Auswählen, um das Bild wieder anzuzeigen"
              @click.stop="handleRestorePhoto(selectedPersonPhoto.id)"
            />
            <Button
              v-else
              icon="pi pi-eye-slash"
              class="fs-topbar-btn" rounded text
              severity="warn"
              aria-label="Auswählen, um das Bild auszublenden"
              @click.stop="handleHidePhoto(selectedPersonPhoto.id)"
            />
            <Button
              :icon="selectedPersonPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              class="fs-topbar-btn" rounded text
              :severity="selectedPersonPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'"
              :aria-label="selectedPersonPhoto.curation_status === 'favorite' ? 'Auswählen, um den Favoritenstatus zu entfernen' : 'Auswählen, um als Favorit zu markieren'"
              @click.stop="handleToggleFavorite(selectedPersonPhoto.id, selectedPersonPhoto.curation_status)"
            />
            <Button
              v-if="selectedPersonFace"
              icon="pi pi-trash"
              label="Gesicht ignorieren"
              class="fs-topbar-btn" rounded text
              severity="danger"
              aria-label="Gesicht ignorieren"
              @click.stop="handleIgnoreFace(selectedPersonFace.id)"
            />
          </div>
        </div>

        <!-- Left/right navigation -->
        <Button icon="pi pi-chevron-left" class="fs-nav-left-right fs-nav-left" rounded text
          :disabled="selectedIndex === 0"
          @click="selectedIndex > 0 && selectedIndex--" />
        <Button icon="pi pi-chevron-right" class="fs-nav-left-right fs-nav-right" rounded text
          :disabled="selectedIndex === personPhotos.length - 1"
          @click="selectedIndex < personPhotos.length - 1 && selectedIndex++" />
      </div>
    </div>

    <Dialog v-model:visible="showMergeDialog" header="Personen zusammenführen" :modal="true" class="w-full max-w-lg">
        <div class="flex flex-col gap-4 mt-2">
            <p>Es werden {{ mergeSourceIds.length }} Personen zusammengeführt. Alle Fotos werden der Zielperson zugeordnet.</p>
            
            <div class="mt-2">
                <label class="font-bold block mb-2">Zielperson auswählen:</label>
                <div class="flex flex-col gap-2 max-h-60 overflow-y-auto border rounded p-2">
                    <div 
                        v-for="id in mergeSourceIds" 
                        :key="id"
                        v-show="persons.find(p => p.id === id)?.name !== 'Unbenannt'"
                        class="flex items-center gap-3 p-2 hover:bg-gray-100 rounded cursor-pointer"
                        @click="mergeTargetId = id"
                    >
                        <input type="radio" :id="'target-' + id" name="mergeTarget" :value="id" v-model="mergeTargetId" />
                        <label :for="'target-' + id" class="flex items-center gap-3 cursor-pointer flex-1">
                            <HeicImage 
                                :src="getCoverUrl(persons.find(p => p.id === id)!)" 
                                class="w-10 h-10 rounded-full overflow-hidden flex-shrink-0"
                                :imageStyle="getFaceStyle(persons.find(p => p.id === id)!)"
                            />
                            <span class="font-medium">{{ persons.find(p => p.id === id)?.name }}</span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="flex justify-end gap-2 mt-4">
                <Button label="Abbrechen" icon="pi pi-times" class="p-button-text" @click="showMergeDialog = false" />
                <Button label="Zusammenführen" icon="pi pi-clone" class="p-button-success" @click="handleMerge" :disabled="!mergeTargetId || persons.find(p => p.id === mergeTargetId)?.name === 'Unbenannt'" />
            </div>
        </div>
    </Dialog>

    <Dialog v-model:visible="showRenameDialog" header="Person umbenennen" :modal="true" class="w-full max-w-md">
      <div class="rename-rows">
        <div class="rename-field-row">
          <label for="name" class="font-bold rename-field-label">Name</label>
          <InputText id="name" v-model="newName" class="flex-auto" autocomplete="off" @keyup.enter="handleRename"/>
          <div class="flex justify-end gap-2 mt-4">
            <Button label="Abbrechen" icon="pi pi-times" class="p-button-text" @click="showRenameDialog = false"/>
            <Button :label="renameWillMerge ? 'Zusammenführen' : 'Speichern'"
                    :icon="renameWillMerge ? 'pi pi-clone' : 'pi pi-check'" @click="handleRename"
                    :disabled="!newName.trim() || newName.trim().toLowerCase() === 'unbenannt'"/>
          </div>
        </div>
        <div class="rename-field-row">
          <Message v-if="newName.trim().toLowerCase() === 'unbenannt'" severity="error" :closable="false">
            Der Name "Unbenannt" ist nicht zulässig.
          </Message>
          <Message v-if="renameWillMerge && newName.trim().toLowerCase() !== 'unbenannt'" severity="warn" :closable="false">
            <div>Eine andere Person heißt bereits <b>{{ duplicateNamePerson?.name }}</b>.</div>
            <div class="merge-warning-line">Beim Speichern werden beide Personen zusammengeführt.</div>
          </Message>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.persons-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.5rem;
  padding: 0.5rem;
}

.person-item {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  background: white;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  border: 1px solid #e5e7eb;
}

.person-item:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

.person-item.selected {
  border-color: #3b82f6;
  background-color: rgba(59, 130, 246, 0.05);
  box-shadow: 0 0 0 2px #3b82f6;
}

.selection-overlay {
    position: absolute;
    inset: 0;
    padding: 0.5rem;
    pointer-events: none;
}

.selection-checkbox {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    background: white;
    border: 2px solid rgba(0,0,0,0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.selection-checkbox.checked {
    background: #3b82f6;
    border-color: #3b82f6;
    color: white;
}

.person-cover {
  position: relative;
  height: 200px;
  width: 100%;
  overflow: hidden;
  background-color: #f3f4f6;
  flex-shrink: 0;
}

.person-img :deep(img) {
  width: 100%;
  height: 100%;
  transition: transform 0.5s;
}

.person-badge {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 0.25rem 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  backdrop-filter: blur(4px);
}

.person-info {
  min-height: 2.2rem;
  padding: 0.25rem 0.55rem;
  display: flex;
  align-items: center;
  cursor: text;
}

.person-name {
  font-weight: 600;
  color: #111827;
  margin: 0;
  line-height: 1.1;
  width: 100%;
}

.person-rename-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
  min-width: 0;
}

.person-name-input {
  flex: 1 1 auto;
  width: 0;
  min-width: 0;
  font-weight: 600;
  color: #111827;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  padding: 0.2rem 0.4rem;
  line-height: 1.1;
  outline: none;
}

.person-name-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
}

.person-rename-btn {
  width: 1.55rem;
  height: 1.55rem;
  min-width: 1.55rem;
  padding: 0;
  flex: 0 0 auto;
}

/* Photo Grid (for Details) */
.photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
}

.person-hero {
    width: 100%;
    max-width: 1024px;
    margin: 0 auto 1.25rem;
    border-radius: 12px;
    overflow: hidden;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    cursor: pointer;
    aspect-ratio: 16 / 9;
}

.person-hero-image :deep(.heic-image-container) {
    width: 100%;
    height: clamp(220px, 52vw, 620px);
}

.person-hero-image :deep(img) {
    width: 100%;
    height: 100%;
    object-fit: scale-down;
}

@media (max-width: 640px) {
    .person-hero {
        aspect-ratio: 4 / 3;
    }

    .person-hero-image :deep(.heic-image-container) {
        height: clamp(220px, 62vw, 360px);
    }
}

@media (min-width: 1024px) {
    .person-hero-image :deep(.heic-image-container) {
        height: clamp(420px, 58vh, 760px);
    }
}

.photo-item {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
}

.photo-item :deep(.heic-image-container) {
    position: absolute;
    inset: 0;
}

.photo-item :deep(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s;
}

.photo-item:hover :deep(img) {
    transform: scale(1.05);
}

.photo-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(transparent, rgba(0,0,0,0.7));
    padding: 1.5rem 0.5rem 0.5rem;
    color: white;
    opacity: 0;
    transition: opacity 0.2s;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
}

.ignore-btn {
    color: white !important;
}

.ignore-btn:hover {
    background: rgba(255, 255, 255, 0.2) !important;
}

.photo-item:hover .photo-overlay {
    opacity: 1;
}

.photo-name {
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-bottom: 0.25rem;
    flex: 1;
}

/* Fullscreen Viewer */
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

/* Utility-Fallbacks (Tailwind nicht aktiv in diesem Projekt) */
.flex { display: flex; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.mb-6 { margin-bottom: 1.5rem; }
.gap-4 { column-gap: 1rem; row-gap: 1rem; }
.gap-3 { column-gap: 0.75rem; row-gap: 0.75rem; }

.rename-rows {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.rename-field-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.rename-field-label {
    min-width: 52px;
    line-height: 1;
}

.merge-warning-line {
    margin-top: 0.35rem;
}

.face-highlight {
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.5);
    border: 2px solid #ffff00 !important;
    z-index: 50;
}

.relative { position: relative; }
.overflow-hidden { overflow: hidden; }
.flex-1 { flex: 1; }
.justify-center { justify-content: center; }

</style>
