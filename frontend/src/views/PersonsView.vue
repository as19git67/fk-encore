<script setup lang="ts">
import { ref, computed, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import SelectButton from 'primevue/selectbutton'
import InputNumber from 'primevue/inputnumber'
import Chip from 'primevue/chip'
import { useConfirm } from 'primevue/useconfirm'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import FacePhotoGrid from '../components/FacePhotoGrid.vue'
import PersonsGrid from '../components/PersonsGrid.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import SortMenu from '../components/SortMenu.vue'
import DateRangePresets from '../components/DateRangePresets.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import { useFilter } from '../composables/useFilter'
import { matchesPhotoFilter } from '../utils/photoFilter'
import type { SortField, SortState } from '../composables/useSort'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import {
  listPersons, updatePerson, mergePersons, getPersonDetails,
  ignoreFace, ignorePersonFaces, updatePhotoCuration, reindexPhoto,
  getPhotoFaces, getPhotoLandmarks,
  type CurationStatus, type Person, type Photo, type PersonDetails,
  type Face, type LandmarkItem, type PhotoFilter,
} from '../api/photos'
import { faceBoxStyle } from '../utils/faceBbox'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoNavStore } from '../stores/photoNav'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useReferenceData } from '../composables/useReferenceData'

// Eigene gefilterte Liste (nur Personen mit faceCount > 1) — wir teilen sie
// nicht mit dem app-weiten Composable, invalidieren aber dessen Cache nach
// Umbenennen/Mergen, damit Galerie/FilterMenu die geänderten Namen sehen.
const { invalidatePersons } = useReferenceData()

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const photoNav = usePhotoNavStore()
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
const isFullscreen = ref(false)
const selectedIndex = ref(-1)
const nameFilter = ref('')

// ── Photo-level filter (detail view of a selected person) ───────────────────
// Replaces the former `showHidden` toggle: hiddenMode + a handful of
// photo-level criteria. Only shown when a person is opened.
const {
  applied: photoFilter,
  draft: photoFilterDraft,
  activeCount: photoFilterActiveCount,
  openEdit: openPhotoFilterEdit,
  apply: applyPhotoFilter,
  reset: resetPhotoFilter,
  removeKey: removePhotoFilterKey,
} = useFilter({ preserveKeys: ['personId', 'photoId'] })
const photoFilterMenuOpen = ref(false)
// Lazy-Mount: siehe GalleryView. Beim Öffnen einer Personenseite vermeiden wir
// dadurch einen unnötigen /albums- und /persons-Roundtrip.
const photoFilterMenuMounted = ref(false)
const PHOTO_FILTER_AVAILABLE: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'> = [
  'hiddenMode', 'favorite', 'mediaTypes', 'hasGps',
  'qualityRange', 'dateRange', 'sizeRange',
]

function openPhotoFilterMenu() {
  openPhotoFilterEdit()
  photoFilterMenuMounted.value = true
  photoFilterMenuOpen.value = true
}
function onApplyPhotoFilter() {
  applyPhotoFilter()
}
function onResetPhotoFilter() {
  resetPhotoFilter()
}
function onRemovePhotoFilterKey(keys: Array<keyof PhotoFilter>) {
  removePhotoFilterKey(keys)
}

// ── Person filter menu ──────────────────────────────────────────────────────
type PersonNamedFilter = 'all' | 'named' | 'unnamed'

interface PersonFilter {
  named: PersonNamedFilter
  faceCountMin?: number
  dateFrom?: string  // ISO YYYY-MM-DD
  dateTo?: string
}

const EMPTY_PERSON_FILTER: PersonFilter = { named: 'all' }
const appliedPersonFilter = ref<PersonFilter>({ ...EMPTY_PERSON_FILTER })
const draftPersonFilter = ref<PersonFilter>({ ...EMPTY_PERSON_FILTER })
const showPersonFilterMenu = ref(false)
const draftPersonDateFrom = ref<Date | null>(null)
const draftPersonDateTo = ref<Date | null>(null)

const namedOptions: Array<{ label: string; value: PersonNamedFilter }> = [
  { label: 'Alle', value: 'all' },
  { label: 'Mit Namen', value: 'named' },
  { label: 'Unbenannt', value: 'unnamed' },
]

const activePersonFilterCount = computed(() => {
  const f = appliedPersonFilter.value
  let n = 0
  if (f.named !== 'all') n++
  if (f.faceCountMin !== undefined) n++
  if (f.dateFrom || f.dateTo) n++
  return n
})

function openPersonFilterMenu() {
  draftPersonFilter.value = { ...appliedPersonFilter.value }
  draftPersonDateFrom.value = appliedPersonFilter.value.dateFrom ? parseLocalDate(appliedPersonFilter.value.dateFrom) : null
  draftPersonDateTo.value = appliedPersonFilter.value.dateTo ? parseLocalDate(appliedPersonFilter.value.dateTo) : null
  showPersonFilterMenu.value = true
}

function applyPersonFilter() {
  appliedPersonFilter.value = {
    ...draftPersonFilter.value,
    dateFrom: draftPersonDateFrom.value ? toLocalIsoDate(draftPersonDateFrom.value) : undefined,
    dateTo: draftPersonDateTo.value ? toLocalIsoDate(draftPersonDateTo.value) : undefined,
  }
  showPersonFilterMenu.value = false
}

function resetPersonFilter() {
  draftPersonFilter.value = { ...EMPTY_PERSON_FILTER }
  draftPersonDateFrom.value = null
  draftPersonDateTo.value = null
  appliedPersonFilter.value = { ...EMPTY_PERSON_FILTER }
}

function personFilterChips(): Array<{ label: string; clear: () => void }> {
  const f = appliedPersonFilter.value
  const chips: Array<{ label: string; clear: () => void }> = []
  if (f.named !== 'all') {
    chips.push({
      label: f.named === 'named' ? 'Mit Namen' : 'Unbenannt',
      clear: () => { appliedPersonFilter.value = { ...f, named: 'all' } },
    })
  }
  if (f.faceCountMin !== undefined) {
    chips.push({
      label: `Mind. ${f.faceCountMin} Fotos`,
      clear: () => { appliedPersonFilter.value = { ...f, faceCountMin: undefined } },
    })
  }
  if (f.dateFrom || f.dateTo) {
    chips.push({
      label: `Foto ${f.dateFrom ?? '…'} – ${f.dateTo ?? '…'}`,
      clear: () => { appliedPersonFilter.value = { ...f, dateFrom: undefined, dateTo: undefined } },
    })
  }
  return chips
}

function matchesPersonFilter(p: Person, f: PersonFilter): boolean {
  const isUnnamed = !p.name || p.name === 'Unbenannt'
  if (f.named === 'named' && isUnnamed) return false
  if (f.named === 'unnamed' && !isUnnamed) return false
  if (f.faceCountMin !== undefined && Number(p.faceCount || 0) < f.faceCountMin) return false
  if (f.dateFrom || f.dateTo) {
    // A person matches when at least one of their photos falls inside the
    // range. Use the aggregated [oldest_photo_at, newest_photo_at] span to
    // test for overlap with [dateFrom, dateTo].
    const oldest = p.oldest_photo_at ? new Date(p.oldest_photo_at).getTime() : 0
    const newest = p.newest_photo_at ? new Date(p.newest_photo_at).getTime() : 0
    if (!oldest || !newest) return false
    if (f.dateFrom && newest < new Date(f.dateFrom).getTime()) return false
    if (f.dateTo) {
      const end = new Date(f.dateTo).getTime() + 86400000
      if (oldest >= end) return false
    }
  }
  return true
}

// ── Person sort menu ────────────────────────────────────────────────────────
const PERSON_SORT_FIELDS: SortField[] = [
  { value: 'faceCount', label: 'Foto-Anzahl' },
  { value: 'name', label: 'Name' },
  { value: 'updated_at', label: 'Zuletzt gesehen' },
]
const DEFAULT_PERSON_SORT: SortState = { field: 'faceCount', direction: 'desc' }
const appliedPersonSort = ref<SortState>({ ...DEFAULT_PERSON_SORT })
const draftPersonSort = ref<SortState>({ ...DEFAULT_PERSON_SORT })
const showPersonSortMenu = ref(false)

const isPersonSortDefault = computed(() =>
  appliedPersonSort.value.field === DEFAULT_PERSON_SORT.field &&
  appliedPersonSort.value.direction === DEFAULT_PERSON_SORT.direction
)
const personSortFieldLabel = computed(() =>
  PERSON_SORT_FIELDS.find(f => f.value === appliedPersonSort.value.field)?.label ?? appliedPersonSort.value.field
)
const personSortChipLabel = computed(() =>
  `Sortierung: ${personSortFieldLabel.value} ${appliedPersonSort.value.direction === 'asc' ? '↑' : '↓'}`
)

function openPersonSortMenu() {
  draftPersonSort.value = { ...appliedPersonSort.value }
  showPersonSortMenu.value = true
}
function applyPersonSort() {
  appliedPersonSort.value = { ...draftPersonSort.value }
  showPersonSortMenu.value = false
}
function resetPersonSort() {
  draftPersonSort.value = { ...DEFAULT_PERSON_SORT }
  appliedPersonSort.value = { ...DEFAULT_PERSON_SORT }
  showPersonSortMenu.value = false
}

function comparePersonsByField(a: Person, b: Person, field: string): number {
  switch (field) {
    case 'faceCount':
      return Number(a.faceCount || 0) - Number(b.faceCount || 0)
    case 'name':
      return a.name.localeCompare(b.name)
    case 'updated_at': {
      const da = a.updated_at ? new Date(a.updated_at).getTime() : 0
      const db = b.updated_at ? new Date(b.updated_at).getTime() : 0
      return da - db
    }
    default:
      return 0
  }
}

const sortedPersons = computed(() => {
  const { field, direction } = appliedPersonSort.value
  const mult = direction === 'asc' ? 1 : -1
  return [...persons.value].sort((a, b) => {
    // Keep "Unbenannt" pinned at the end regardless of sort.
    if (a.name === 'Unbenannt' && b.name !== 'Unbenannt') return 1
    if (a.name !== 'Unbenannt' && b.name === 'Unbenannt') return -1
    const primary = mult * comparePersonsByField(a, b, field)
    if (primary !== 0) return primary
    return a.name.localeCompare(b.name)
  })
})

const filteredPersons = computed(() => {
  const q = nameFilter.value.trim().toLocaleLowerCase()
  const f = appliedPersonFilter.value
  return sortedPersons.value.filter(p => {
    if (q && !p.name.toLocaleLowerCase().includes(q)) return false
    return matchesPersonFilter(p, f)
  })
})

// Remember the most recently opened person across reloads, plus a per-person
// map of the last photo the user had selected, so reopening a person restores
// the previous scroll/selection position instead of snapping back to the top.
const LAST_PERSON_KEY = 'persons_last_selected_id'
const personsGridRef = ref<InstanceType<typeof PersonsGrid> | null>(null)
// ID of the last person the user opened — drives scroll restoration when
// returning to the persons grid after viewing a person's detail page.
const rememberedPersonId = ref<number | null>(
  Number(localStorage.getItem(LAST_PERSON_KEY)) || null
)
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
  const f = photoFilter.value
  return selectedPersonDetail.value.faces
    .filter(face => !!face.photo && !face.ignored && matchesPhotoFilter(face.photo as Photo, f))
    .map(face => ({ face, photo: face.photo as Photo }))
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
    photoNav.selectPhoto(photo.id)
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
    persons.value = res.persons.filter(p => Number(p.faceCount || 0) > 1)
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
    rememberedPersonId.value = person.id
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

// After filter or sort changes the visible set shrinks / reorders; the
// virtualizer keeps its absolute scroll offset so we re-apply the remembered
// position so the user doesn't get stranded at the top.
watch(filteredPersons, () => {
  void personsGridRef.value?.rescrollToRemembered()
})

// ── Grid events ───────────────────────────────────────────────────────────────
async function handlePersonSelected(person: Person) {
  await selectPersonItem(person)
}

function backToGrid() {
  const lastId = selectedPerson.value?.id ?? null
  selectedPerson.value = null
  selectedPersonDetail.value = null
  selectedIndex.value = -1
  detectedFaces.value = []
  detectedLandmarks.value = []
  // After Vue re-renders (grid visible again), scroll to and highlight the
  // person the user just came back from.
  if (lastId) {
    requestAnimationFrame(() => {
      personsGridRef.value?.scrollToPerson(lastId, { highlight: true })
    })
  }
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
    invalidatePersons()
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
import { useRealtimeEvent } from '../composables/useRealtime'
onUnmounted(() => serviceHealth.stopPolling())

// Refresh the opened person's photos when their curation state
// changes elsewhere so the heart, fav-count and "Meinungen" bars in
// the detail sidebar stay current. We only reload when a person is
// actually open — the grid-level overview doesn't show stats.
useRealtimeEvent('photos', 'curation.changed', async (ev) => {
  if (!selectedPerson.value) return
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  const hits = selectedPersonDetail.value?.faces.some(
    (f) => f.photo && f.photo.id === photoId,
  )
  if (!hits) return
  try {
    selectedPersonDetail.value = await getPersonDetails(selectedPerson.value.id)
  } catch {
    // Ignore — next reload will re-sync.
  }
})
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
          <Button
            v-if="selectedPersonDetail"
            :icon="photoFilterActiveCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
            :label="photoFilterActiveCount > 0 ? `Filter (${photoFilterActiveCount})` : 'Filter'"
            size="small"
            :severity="photoFilterActiveCount > 0 ? 'primary' : 'secondary'"
            :outlined="photoFilterActiveCount === 0"
            @click="openPhotoFilterMenu"
          />
          <template v-if="selectedPerson">
            <Button icon="pi pi-pencil" label="Umbenennen" outlined @click="openRename(selectedPerson)" />
            <Button icon="pi pi-trash" label="Ignorieren" outlined severity="danger"
              v-tooltip="'Person und alle Gesichter dauerhaft ignorieren'"
              @click="handleIgnorePerson(selectedPerson)" />
          </template>
        </div>
      </div>
      <div v-if="selectedPersonDetail && photoFilterActiveCount > 0" class="person-photo-filter-chips">
        <FilterChips :filter="photoFilter" @remove="onRemovePhotoFilterKey" />
      </div>
    </div>

    <FilterMenu
      v-if="photoFilterMenuMounted"
      v-model:visible="photoFilterMenuOpen"
      v-model:draft="photoFilterDraft"
      :available="PHOTO_FILTER_AVAILABLE"
      @apply="onApplyPhotoFilter"
      @reset="onResetPhotoFilter"
    />

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
        <Button
          :icon="activePersonFilterCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
          :label="activePersonFilterCount > 0 ? `Filter (${activePersonFilterCount})` : 'Filter'"
          size="small"
          :severity="activePersonFilterCount > 0 ? 'primary' : 'secondary'"
          :outlined="activePersonFilterCount === 0"
          @click="openPersonFilterMenu"
        />
        <Button
          icon="pi pi-sort-alt"
          label="Sortierung"
          size="small"
          :severity="isPersonSortDefault ? 'secondary' : 'primary'"
          :outlined="isPersonSortDefault"
          @click="openPersonSortMenu"
        />
        <span class="persons-filter-count">
          {{ filteredPersons.length }} von {{ persons.length }}
        </span>
      </div>
      <div v-if="activePersonFilterCount > 0 || !isPersonSortDefault" class="persons-filter-chips">
        <Chip
          v-for="(chip, i) in personFilterChips()"
          :key="`f-${i}`"
          :label="chip.label"
          removable
          @remove="chip.clear()"
        />
        <Chip
          v-if="!isPersonSortDefault"
          :label="personSortChipLabel"
          removable
          @remove="resetPersonSort()"
        />
      </div>

      <PersonsGrid
        ref="personsGridRef"
        :persons="filteredPersons"
        :remembered-person-id="rememberedPersonId"
        @person-click="handlePersonSelected"
      />
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
      <template #actions>
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

    <!-- Person filter dialog -->
    <Dialog v-model:visible="showPersonFilterMenu" header="Filter" modal :style="{ width: 'min(100%, 480px)' }">
      <div class="person-filter-menu">
        <div class="pfm-row">
          <label class="pfm-label">Benennung</label>
          <SelectButton
            v-model="draftPersonFilter.named"
            :options="namedOptions" option-label="label" option-value="value"
            :allow-empty="false"
          />
        </div>
        <div class="pfm-row">
          <label class="pfm-label">Mindestanzahl Fotos</label>
          <InputNumber v-model="draftPersonFilter.faceCountMin" :min="0" show-buttons />
        </div>
        <div class="pfm-row">
          <label class="pfm-label">Fotodatum</label>
          <DateRangePresets v-model:from="draftPersonDateFrom" v-model:to="draftPersonDateTo" />
        </div>
      </div>
      <template #footer>
        <Button label="Zurücksetzen" text severity="secondary" @click="resetPersonFilter" />
        <Button label="Abbrechen" text @click="showPersonFilterMenu = false" />
        <Button label="Anwenden" icon="pi pi-check" @click="applyPersonFilter" />
      </template>
    </Dialog>

    <SortMenu
      v-model:visible="showPersonSortMenu"
      v-model:draft="draftPersonSort"
      :fields="PERSON_SORT_FIELDS"
      @apply="applyPersonSort"
      @reset="resetPersonSort"
    />
  </div>
</template>

<style scoped>
.persons-view {
  display: flex;
  flex-direction: column;
  /* `100dvh` (not `100vh`) so the view matches the visible viewport on mobile;
     `100vh` is the large viewport and made the page scroll under the navbar. */
  height: calc(100dvh - var(--menubar-height, 3.5rem));
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

.person-photo-filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding-top: 0.4rem;
}

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
  display: flex;
  flex-direction: column;
  padding: 0.75rem 0.75rem 0;
  gap: 0.5rem;
  overflow: hidden;
}

.persons-filter-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.persons-filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-block: 0.25rem 0.5rem;
}

.person-filter-menu { display: flex; flex-direction: column; gap: 1rem; }
.pfm-row { display: flex; flex-direction: column; gap: 0.5rem; }
.pfm-label { font-weight: 500; font-size: 0.9rem; color: var(--p-text-muted-color); }

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
