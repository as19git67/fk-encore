<script setup lang="ts">
import { ref, shallowRef, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoGrid from '../components/PhotoGrid.vue'
import Chip from 'primevue/chip'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import SortMenu from '../components/SortMenu.vue'
import { useFilter } from '../composables/useFilter'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import {
  listPhotoIndex, uploadPhotoWithProgress, updatePhotoDate, reindexPhoto, ignoreFace,
  getPhotoFaces, getPhotoLandmarks, updatePhotoCuration,
  listPhotoGroups, computeFileHash, checkPhotoHash,
  type Photo, type Face, type CurationStatus, type PhotoGroup,
  type LandmarkItem,
} from '../api/photos'
import { listPersons, type Person } from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import type { YearGroup, PhotoItem } from '../composables/usePhotoGrouping'
import { usePhotoSelection } from '../composables/usePhotoSelection'
import { usePhotoHydration } from '../composables/usePhotoHydration'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useNaturalSearch } from '../composables/useNaturalSearch'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const route = useRoute()
const router = useRouter()

// ── Data ─────────────────────────────────────────────────────────────────────
const photos = ref<Photo[]>([])
const loading = ref(true)
const uploading = ref(false)
const uploadAbortController = ref<AbortController | null>(null)
const error = ref('')

// ── Filter state ─────────────────────────────────────────────────────────────
// Unified filter system replaces the old boolean `showHidden` toggle. The
// applied filter drives data fetching; the draft is edited in FilterMenu and
// committed to `applied` when the user presses "Anwenden".
const { applied: filter, draft: filterDraft, activeCount, openEdit, apply: applyFilter, reset: resetFilter, removeKey } =
  useFilter({ preserveKeys: ['photoId', 'sortBy', 'sortDir'] })
const filterMenuOpen = ref(false)

function openFilterMenu() {
  openEdit()
  filterMenuOpen.value = true
}

async function onApplyFilter() {
  applyFilter()
  await loadPhotos()
}

async function onResetFilter() {
  resetFilter()
  await loadPhotos()
}

async function onRemoveFilterKey(keys: Array<keyof typeof filter.value>) {
  removeKey(keys)
  await loadPhotos()
}

// ── Sort state ───────────────────────────────────────────────────────────────
const SORT_FIELDS: SortField[] = [
  { value: 'taken_at', label: 'Aufnahmedatum' },
  { value: 'created_at', label: 'Importdatum' },
  { value: 'ai_quality_score', label: 'Qualität' },
  { value: 'filename', label: 'Dateiname' },
  { value: 'size', label: 'Dateigröße' },
]
const DEFAULT_SORT: SortState = { field: 'taken_at', direction: 'asc' }
const {
  applied: sort,
  draft: sortDraft,
  isDefault: isSortDefault,
  fieldLabel: sortFieldLabel,
  openEdit: openSortEdit,
  apply: applySort,
  reset: resetSort,
} = useSort({ fields: SORT_FIELDS, defaultState: DEFAULT_SORT })
const sortMenuOpen = ref(false)

function openSortMenu() {
  openSortEdit()
  sortMenuOpen.value = true
}
function onApplySort() {
  applySort()
  sortMenuOpen.value = false
}
function onResetSort() {
  resetSort()
  sortMenuOpen.value = false
}
const sortChipLabel = computed(() =>
  `Sortierung: ${sortFieldLabel.value} ${sort.value.direction === 'asc' ? '↑' : '↓'}`
)

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const canManageData = computed(() => auth.hasPermission('data.manage'))

// ── Photo groups (stacks) ─────────────────────────────────────────────────────
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)

const photoToGroup = computed(() => {
  const map = new Map<number, PhotoGroup>()
  // Reviewed first, unreviewed last — so unreviewed groups win for photos
  // that belong to both (happens transiently when members were added and a
  // new superset group was created alongside the old reviewed one).
  for (const group of photoGroupsList.value) {
    if (!group.reviewed_at) continue
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  for (const group of photoGroupsList.value) {
    if (group.reviewed_at) continue
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
const {
  searchQuery,
  searchResultIds,
  loading: searchLoading,
  error: searchError,
  executeSearch: runSearch,
  clearSearch,
  locationChip,
  dateChip,
  semanticChip,
  hasParsedChips,
} = useNaturalSearch()

async function executeSearch() {
  await runSearch()
  // Search hits are shown via searchResultIds → photos.value mapping.
  // Prioritize hydrating the matching photos so the sidebar/details show
  // full data immediately when a hit is clicked.
  if (searchResultIds.value && searchResultIds.value.length > 0) {
    hydration.ensureLoaded(searchResultIds.value)
  }
}

const searchResultCount = computed(() => searchResultIds.value?.length ?? 0)

// ── Sort & flat photo list (no year/month grouping) ──────────────────────────
// Photos in `photos.value` are kept in display order: that keeps arrow-key
// navigation (which steps `selectedIndex` through `photos.value`) aligned with
// what the user sees. `groupedPhotos` just wraps the list in a single
// synthetic YearGroup so PhotoGrid's existing contract still works, with the
// year and month titles both empty so neither renders.
function compareByField(a: Photo, b: Photo, field: string): number {
  switch (field) {
    case 'taken_at':
      return new Date(a.taken_at || a.created_at).getTime() -
        new Date(b.taken_at || b.created_at).getTime()
    case 'created_at':
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'ai_quality_score':
      return (a.ai_quality_score ?? -Infinity) - (b.ai_quality_score ?? -Infinity)
    case 'filename':
      return (a.filename ?? '').localeCompare(b.filename ?? '')
    case 'size':
      return (a.size ?? 0) - (b.size ?? 0)
    default:
      return 0
  }
}
function sortPhotosByApplied(list: Photo[]): Photo[] {
  const { field, direction } = sort.value
  const mult = direction === 'asc' ? 1 : -1
  return [...list].sort((a, b) => mult * compareByField(a, b, field))
}
watch(sort, () => {
  photos.value = sortPhotosByApplied(photos.value)
}, { deep: true })

const groupedPhotos = computed<YearGroup[]>(() => {
  const ids = searchResultIds.value
  const hidden = hiddenByStack.value
  const groupMap = photoToGroup.value

  const indexById = new Map<number, number>()
  for (let i = 0; i < photos.value.length; i++) indexById.set(photos.value[i]!.id, i)

  let base: Photo[]
  if (ids !== null) {
    const byId = new Map<number, Photo>()
    for (const p of photos.value) byId.set(p.id, p)
    base = ids.map((id) => byId.get(id)).filter((p): p is Photo => p !== undefined)
  } else {
    base = photos.value.filter((p) => !hidden.has(p.id))
  }

  const items: PhotoItem[] = base.map((photo) => {
    const index = indexById.get(photo.id) ?? -1
    const stackGroup = ids === null ? groupMap.get(photo.id) : undefined
    const group = stackGroup && !stackGroup.reviewed_at ? stackGroup : undefined
    return { photo, index, group }
  })

  return [{
    year: '',
    sectionId: 'all',
    months: [{ month: '', sectionId: 'all', photos: items }],
  }]
})

// ── Selection (via composable) ────────────────────────────────────────────────
const { selectedIndex, selectedPhotoIds, selectedPhoto, selectedPhotos, selectPhoto } =
  usePhotoSelection(photos)

// ── Two-stage loading: lightweight index first, full details on demand ───────
// The /photos/index endpoint returns just the columns needed to render the
// grid (id, filename, dates, curation_status, auto_crop). Heavy fields
// (location, GPS, ai_quality_*, description) are hydrated lazily via the
// /photos/details batch endpoint as photos become visible / selected.
// Smaller batch size + the 60s per-request timeout in getPhotoDetailsBatch
// keep hung responses from piling up in memory on overloaded servers.
const hydration = usePhotoHydration(photos, { batchSize: 50, backgroundPauseMs: 50 })

// Expand selection: if any selected photo is in a group, include all group members
const expandedSelectedPhotos = computed<Photo[]>(() => {
  const expanded = new Set<number>()
  for (const photo of selectedPhotos.value) {
    expanded.add(photo.id)
    const group = photoToGroup.value.get(photo.id)
    if (group && !group.reviewed_at) {
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
const mobileSidebarOpen = ref(false)

// ── Select mode (mobile + desktop) ──────────────────────────────────────────
const selectMode = ref(false)

// Selektion im Auswahlmodus vollständig getrennt von usePhotoSelection (kein Watch-Interferenz)
const selectModeIds = shallowRef<Set<number>>(new Set())
const selectModePhotos = computed<Photo[]>(() =>
  photos.value.filter(p => selectModeIds.value.has(p.id))
)

// Welche IDs an PhotoGrid übergeben werden – im Auswahlmodus die separaten IDs
const activeSelectedPhotoIds = computed<Set<number>>(() =>
  selectMode.value ? selectModeIds.value : selectedPhotoIds.value
)

function enterSelectMode() {
  selectModeIds.value = new Set()
  selectMode.value = true
}

function exitSelectMode() {
  selectMode.value = false
  selectModeIds.value = new Set()
  mobileSidebarOpen.value = false
}

function handlePhotoClick(item: PhotoItem, event: MouseEvent) {
  if (selectMode.value) {
    // Auswahlmodus: lokalen State direkt togglen, usePhotoSelection komplett umgehen
    const photoId = item.photo.id
    const next = new Set(selectModeIds.value)
    if (next.has(photoId)) next.delete(photoId)
    else next.add(photoId)
    selectModeIds.value = next
  } else {
    selectPhoto(item.index, event)
    // Mobile: Single-Tap öffnet Fullscreen (kein Sidebar sichtbar)
    if (window.innerWidth <= 768) isFullscreen.value = true
  }
}

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

const LAST_PHOTO_KEY = 'photos_last_selected_id'

// Watch the selected photo's ID (primitive) rather than the computed
// `selectedPhoto` ref. The underlying Photo object is replaced on every
// hydration batch (photos.value gets a new array with new objects at the
// hydrated indices), so watching the ref directly would re-fire all of the
// below requests on every background hydration batch.
watch(() => selectedPhoto.value?.id ?? null, (photoId) => {
  isEditingDate.value = false
  if (photoId !== null) {
    console.log('[PhotosView] Saving selected photo to localStorage:', photoId)
    localStorage.setItem(LAST_PHOTO_KEY, String(photoId))
    // Make sure heavy fields (location, GPS, ai_quality_*, description) are
    // available for the sidebar/fullscreen view even if background hydration
    // hasn't reached this photo yet.
    hydration.ensureLoaded([photoId])
    loadDetectedFaces(photoId)
    loadLandmarks(photoId)
    // Persons list is independent of which photo is selected — loaded once
    // at init (see below). Re-fetching it on every selection change adds to
    // the request burst that fires when the gallery opens and keeps every
    // arrow-key navigation hammering /persons for no benefit.
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

watch(isFullscreen, (val) => {
  if (!val) {
    isEditingDate.value = false
    // Nach Schließen des Fullscreen: Grid zum aktuellen Foto scrollen
    nextTick(() => photoGridRef.value?.scrollToPhoto(selectedIndex.value, 'instant'))
  }
})

// ── Column count (received from PhotoGrid) ────────────────────────────────────
const columnCount = ref(4)

// ── Ref to PhotoGrid component ────────────────────────────────────────────────
const photoGridRef = ref<InstanceType<typeof PhotoGrid> | null>(null)

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
  onUp() {
    if (selectedIndex.value < 0) return
    const next = selectedIndex.value - columnCount.value
    if (next >= 0) selectedIndex.value = next
  },
  onDown() {
    if (selectedIndex.value < 0) return
    const next = selectedIndex.value + columnCount.value
    if (next < photos.value.length) selectedIndex.value = next
  },
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
  hydration.reset()
  try {
    // Stage 1: lightweight index (small payload, fast even with thousands of photos)
    const [indexRes, groupsRes] = await Promise.all([
      listPhotoIndex(filter.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    photos.value = sortPhotosByApplied(indexRes.photos as Photo[])
    photoGroupsList.value = groupsRes.groups

    // Determine which photo to focus: query param > localStorage > newest
    let targetIdx = -1

    const queryPhotoId = Number(route.query.photoId)
    const storedPhotoId = Number(localStorage.getItem(LAST_PHOTO_KEY))

    console.log('[PhotosView] loadPhotos: queryPhotoId=', queryPhotoId, 'storedPhotoId=', storedPhotoId, 'photosCount=', photos.value.length)

    if (queryPhotoId) {
      targetIdx = photos.value.findIndex(p => p.id === queryPhotoId && !hiddenByStack.value.has(p.id))
      console.log('[PhotosView] queryPhotoId targetIdx=', targetIdx)
      router.replace({ query: { ...route.query, photoId: undefined } })
    }

    if (targetIdx < 0 && storedPhotoId) {
      targetIdx = photos.value.findIndex(p => p.id === storedPhotoId && !hiddenByStack.value.has(p.id))
      console.log('[PhotosView] storedPhotoId targetIdx=', targetIdx)
    }

    if (targetIdx < 0 && photos.value.length > 0) {
      // Fallback: neuestes sichtbares Foto
      const lastVisible = [...photos.value].reverse().findIndex(p => !hiddenByStack.value.has(p.id))
      targetIdx = lastVisible >= 0 ? photos.value.length - 1 - lastVisible : photos.value.length - 1
      console.log('[PhotosView] fallback targetIdx=', targetIdx)
    }

    const isMobile = window.innerWidth <= 768
    console.log('[PhotosView] isMobile=', isMobile, 'final targetIdx=', targetIdx)

    // On mobile: only skip pre-selection if there's no explicit target (query param or stored)
    if (isMobile && !queryPhotoId && !storedPhotoId) {
      selectedIndex.value = -1
    } else {
      selectedIndex.value = targetIdx
    }
    console.log('[PhotosView] selectedIndex set to', selectedIndex.value)

    // Now reveal the grid (PhotoGrid will mount with correct selectedIndex)
    loading.value = false

    // Stage 2: hydrating the focused photo is handled by the watcher on
    // selectedPhoto.id above — assigning selectedIndex (from -1 to targetIdx)
    // fires it. A full-library background hydration used to start here, but
    // on large libraries (45k+ photos) with a loaded server that fired
    // hundreds of /photos/details batches which could hang and blow up
    // browser memory. Heavy fields are now fetched on demand — when the user
    // selects a photo, opens the compare view, or runs a search.
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Fotos'
    loading.value = false
  }
}

async function reloadPhotosInPlace() {
  try {
    const [indexRes, groupsRes] = await Promise.all([
      listPhotoIndex(filter.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    hydration.reset()
    photos.value = sortPhotosByApplied(indexRes.photos as Photo[])
    photoGroupsList.value = groupsRes.groups
    if (selectedIndex.value >= 0) {
      const focused = photos.value[selectedIndex.value]
      if (focused) hydration.ensureLoaded([focused.id])
    }
  } catch { /* silently fail */ }
}

// ── Curation ──────────────────────────────────────────────────────────────────
async function handleDelete(id: number) {
  try {
    await updatePhotoCuration(id, 'hidden')
    await reloadPhotosInPlace()
    if (selectedIndex.value >= photos.value.length) selectedIndex.value = photos.value.length - 1
  } catch (err: any) { error.value = err.message || 'Fehler' }
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
  if (selectMode.value) {
    // Mobile: alle Gruppenfotos in den isolierten mobilen State einfügen
    const next = new Set(selectModeIds.value)
    for (const pid of group.photo_ids) next.add(pid)
    selectModeIds.value = next
  } else {
    // Desktop: usePhotoSelection + Cursor auf Cover-Foto setzen
    const newSet = new Set(selectedPhotoIds.value)
    for (const pid of group.photo_ids) newSet.add(pid)
    selectedPhotoIds.value = newSet
    const coverIdx = photos.value.findIndex(p => p.id === (group.cover_photo_id ?? group.photo_ids[0]))
    if (coverIdx >= 0) selectedIndex.value = coverIdx
  }
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

async function handleGroupNext(reviewedGroupId: number) {
  // Capture the just-reviewed group's photo set before it's cleared, so we can
  // skip any "next" candidate that is actually the same logical group after
  // background regrouping (same members, new id).
  const reviewed = activeGroup.value
  const reviewedSet = reviewed ? new Set(reviewed.photo_ids) : null

  // Reload groups first so handleGroupNext picks from fresh data. Without this
  // a stale cached entry (old id, old composition) can be re-opened here.
  await reloadPhotosInPlace()

  const next = photoGroupsList.value.find((g) => {
    if (g.reviewed_at) return false
    if (g.id === reviewedGroupId) return false
    if (
      reviewedSet &&
      g.photo_ids.length === reviewedSet.size &&
      g.photo_ids.every((id) => reviewedSet.has(id))
    ) {
      return false
    }
    return true
  })

  if (next) {
    activeGroup.value = next
  } else {
    activeGroup.value = null
    selectAfterGroup(reviewed)
  }
}

function handleStartGroupReview() {
  const first = photoGroupsList.value.find(g => !g.reviewed_at)
  if (first) activeGroup.value = first
}

// When a stack/compare view opens, hydrate all of its photos up front so the
// comparison UI has full metadata (quality scores, descriptions, …) without
// waiting for the background loop.
watch(activeGroup, (group) => {
  if (group?.photo_ids?.length) hydration.ensureLoaded(group.photo_ids)
})

// ── Upload / Drag & Drop ──────────────────────────────────────────────────────
const uploadErrors = ref<string[]>([])
const showErrorFlyout = ref(false)

const isDragging = ref(false)
const dragCounter = ref(0)

// Upload progress tracking
const uploadCurrent = ref(0)
const uploadTotal = ref(0)
const uploadProgress = ref(0) // 0-100 overall progress
const uploadSuccessCount = ref(0)
const uploadResultMessage = ref('')
let uploadResultTimeout: ReturnType<typeof setTimeout> | undefined

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
  uploadCurrent.value = 0
  uploadTotal.value = files.length
  uploadProgress.value = 0
  uploadSuccessCount.value = 0
  uploadResultMessage.value = ''
  if (uploadResultTimeout) { clearTimeout(uploadResultTimeout); uploadResultTimeout = undefined }
  const duplicates: string[] = []
  const unsupported: string[] = []
  const errors: string[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break
      const file = files[i]!
      uploadCurrent.value = i + 1
      try {
        // Client-side duplicate check: compute SHA-256 locally and ask the
        // server if that hash already exists for this user. Skipping the
        // upload of a duplicate avoids transferring the file over the
        // network (saves bandwidth and mobile data).
        const fileHash = await computeFileHash(file)
        if (fileHash && !abortController.signal.aborted) {
          try {
            const { exists } = await checkPhotoHash(fileHash)
            if (exists) {
              duplicates.push(file.name)
              uploadProgress.value = Math.round(((i + 1) / files.length) * 100)
              continue
            }
          } catch {
            // If the pre-check fails (e.g. network error), fall through to
            // the actual upload — the server will reject duplicates anyway.
          }
        }

        await uploadPhotoWithProgress(
          file,
          abortController.signal,
          (loaded, total) => {
            const filePct = loaded / total
            uploadProgress.value = Math.round(((i + filePct) / files.length) * 100)
          }
        )
        uploadSuccessCount.value++
      }
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
    // Show success count in status bar
    const count = uploadSuccessCount.value
    if (count > 0 && !abortController.signal.aborted) {
      uploadResultMessage.value = count === 1
        ? '1 neues Foto hochgeladen'
        : `${count} neue Fotos hochgeladen`
      uploadResultTimeout = setTimeout(() => { uploadResultMessage.value = '' }, 8000)
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
loadPersons()
serviceHealth.startPolling()

import { onUnmounted } from 'vue'
onUnmounted(() => {
  serviceHealth.stopPolling()
  if (uploadResultTimeout) clearTimeout(uploadResultTimeout)
  hydration.cancel()
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
          <Button
            v-if="!loading && photos.length > 0"
            class="desktop-select-toggle"
            :icon="selectMode ? 'pi pi-times' : 'pi pi-check-square'"
            :label="selectMode ? 'Auswahl beenden' : 'Auswählen'"
            size="small"
            :severity="selectMode ? 'danger' : 'secondary'"
            :outlined="!selectMode"
            @click="selectMode ? exitSelectMode() : enterSelectMode()"
          />
          <Button
            :icon="activeCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
            :label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
            size="small"
            :severity="activeCount > 0 ? 'primary' : 'secondary'"
            :outlined="activeCount === 0"
            @click="openFilterMenu"
          />
          <Button
            icon="pi pi-sort-alt"
            :label="isSortDefault ? 'Sortierung' : `Sortierung: ${sortFieldLabel}`"
            size="small"
            :severity="isSortDefault ? 'secondary' : 'primary'"
            :outlined="isSortDefault"
            @click="openSortMenu"
          />
          <Button
            v-if="canManageData && unreviewedGroupCount > 0"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images"
            severity="success"
            @click="handleStartGroupReview"
          />
          <template v-if="canUpload">
            <Button
              v-if="uploading"
              label="Abbrechen"
              icon="pi pi-times"
              severity="danger"
              @click="cancelUpload"
            />
            <label v-else class="upload-button-label">
              <input
                type="file"
                accept="image/*"
                multiple
                class="upload-input-hidden"
                @change="handleUpload({ files: ($event.target as HTMLInputElement).files ? Array.from(($event.target as HTMLInputElement).files!) : [] })"
              />
              <Button label="Fotos hochladen" icon="pi pi-upload" as="span" />
            </label>
          </template>
        </div>
      </div>

      <NaturalSearchBar
        v-model="searchQuery"
        :loading="searchLoading"
        :result-count="searchResultIds !== null ? searchResultCount : null"
        :has-parsed-chips="hasParsedChips"
        :location-chip="locationChip"
        :date-chip="dateChip"
        :semantic-chip="semanticChip"
        @search="executeSearch"
        @clear="clearSearch"
      />

      <div class="chip-row">
        <FilterChips :filter="filter" @remove="onRemoveFilterKey" />
        <Chip
          v-if="!isSortDefault"
          :label="sortChipLabel"
          removable
          @remove="onResetSort"
        />
      </div>
    </div>

    <FilterMenu
      v-model:visible="filterMenuOpen"
      v-model:draft="filterDraft"
      @apply="onApplyFilter"
      @reset="onResetFilter"
    />

    <SortMenu
      v-model:visible="sortMenuOpen"
      v-model:draft="sortDraft"
      :fields="SORT_FIELDS"
      @apply="onApplySort"
      @reset="onResetSort"
    />

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

    <!-- Upload progress bar -->
    <div v-if="uploading" class="upload-progress-bar">
      <div class="upload-progress-bar__info">
        <i class="pi pi-upload" />
        <span>Foto {{ uploadCurrent }} von {{ uploadTotal }} wird hochgeladen…</span>
        <span class="upload-progress-bar__pct">{{ uploadProgress }}%</span>
      </div>
      <div class="upload-progress-bar__track">
        <div class="upload-progress-bar__fill" :style="{ width: uploadProgress + '%' }" />
      </div>
    </div>

    <!-- Upload result message -->
    <div v-if="uploadResultMessage && !uploading" class="upload-result-bar">
      <i class="pi pi-check-circle" />
      <span>{{ uploadResultMessage }}</span>
    </div>

    <div v-if="!uploading && loading" class="info-text">Lade Fotos…</div>
    <div v-else-if="photos.length === 0" class="info-text">Keine Fotos hochgeladen.</div>

    <template v-else>
      <!-- Desktop: Auswahl-Aktionsleiste -->
      <div v-if="selectMode && selectModePhotos.length > 0" class="desktop-select-bar">
        <span class="desktop-select-count">
          <i class="pi pi-check-square" />
          {{ selectModePhotos.length }} ausgewählt
        </span>
        <div class="desktop-select-actions">
          <Button
            label="Details / Album"
            icon="pi pi-book"
            size="small"
            @click="mobileSidebarOpen = true"
          />
          <Button
            label="Auswahl aufheben"
            icon="pi pi-replay"
            size="small"
            severity="secondary"
            outlined
            @click="selectModeIds = new Set()"
          />
        </div>
      </div>

      <!-- Two-column layout: PhotoGrid | Sidebar -->
      <div class="gallery-layout">
      <!-- CENTER: Photo grid -->
      <PhotoGrid
        ref="photoGridRef"
        :groupedPhotos="groupedPhotos"
        :photos="photos"
        :selectedIndex="selectedIndex"
        :selectedPhotoIds="activeSelectedPhotoIds"
        :canDelete="canDelete"
        :hasStacks="true"
        :suppressScroll="isFullscreen"
        :selectMode="selectMode"
        @update:columnCount="columnCount = $event"
        @photo-click="handlePhotoClick"
        @photo-dblclick="isFullscreen = true"

        @stack-click="activeGroup = $event"
        @group-multi-select="handleGroupMultiSelect"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleDelete"
        @restore="handleRestore"
      />

      <!-- RIGHT: Details sidebar – auf Mobile als Bottom-Sheet -->
      <div class="sidebar-sheet" :class="{ 'is-open': mobileSidebarOpen }">
        <div class="sidebar-sheet-header">
          <button class="sidebar-sheet-close" @click="mobileSidebarOpen = false" aria-label="Schließen">
            <i class="pi pi-times" />
          </button>
        </div>
        <PhotoDetailSidebar
          v-if="selectMode ? selectModePhotos.length > 0 : selectedPhotos.length > 0"
          :photo="selectMode ? selectModePhotos[0]! : (selectedPhoto || selectedPhotos[0])!"
          :selectedPhotos="selectMode ? selectModePhotos : expandedSelectedPhotos"
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
          :location-menu-exclude-all-photos="true"
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
    </div>
    </template>

    <!-- Fullscreen overlay -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="canDelete"
      :showDetailsButton="true"
      :detailsActive="false"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleDelete"
      @restore="handleRestore"
      @show-details="isFullscreen = false; mobileSidebarOpen = true"
    />
    <!-- end fullscreen overlay -->

    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :allPhotos="photos"
      :totalUnreviewed="unreviewedGroupCount"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />

    <!-- Mobile: Backdrop zum Schließen des Sidebar-Drawers -->
    <div
      v-if="mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileSidebarOpen = false"
    />

    <!-- Mobile: Floating-Button Auswahlmodus starten (nur wenn nicht im Auswahlmodus) -->
    <button
      v-if="!loading && !uploading && photos.length > 0 && !selectMode"
      class="mobile-fab mobile-fab--select"
      @click="enterSelectMode"
      aria-label="Fotos auswählen"
    >
      <i class="pi pi-check-square" />
    </button>


    <!-- Mobile: Action-Bar im Auswahlmodus -->
    <div v-if="selectMode" class="mobile-select-bar">
      <span class="mobile-select-count">
        <i class="pi pi-check-square" />
        {{ selectModePhotos.length > 0 ? `${selectModePhotos.length} ausgewählt` : 'Fotos antippen zum Auswählen' }}
      </span>
      <div class="mobile-select-actions">
        <Button
          v-if="selectModePhotos.length > 0"
          label="Details / Album"
          icon="pi pi-book"
          size="small"
          @click="mobileSidebarOpen = true"
        />
        <Button
          label="Abbrechen"
          icon="pi pi-times"
          size="small"
          severity="secondary"
          outlined
          @click="exitSelectMode"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── Upload progress bar ──────────────────────────────────────────────────── */
.upload-progress-bar {
  padding: 0.5rem 1rem;
  background: var(--p-blue-50);
  border-bottom: 1px solid var(--p-blue-200);
}
.upload-progress-bar__info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--p-blue-700);
  margin-bottom: 0.35rem;
}
.upload-progress-bar__pct {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.upload-progress-bar__track {
  height: 4px;
  background: var(--p-blue-100);
  border-radius: 2px;
  overflow: hidden;
}
.upload-progress-bar__fill {
  height: 100%;
  background: var(--p-blue-500);
  border-radius: 2px;
  transition: width 0.15s ease;
}

.upload-result-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--p-green-50);
  border-bottom: 1px solid var(--p-green-200);
  color: var(--p-green-700);
  font-size: 0.875rem;
  animation: upload-result-fade-in 0.3s ease;
}
.upload-result-bar .pi-check-circle {
  color: var(--p-green-500);
}

@keyframes upload-result-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Dark mode */
.p-dark .upload-progress-bar {
  background: var(--p-blue-900);
  border-color: var(--p-blue-700);
}
.p-dark .upload-progress-bar__info { color: var(--p-blue-200); }
.p-dark .upload-progress-bar__track { background: var(--p-blue-800); }
.p-dark .upload-progress-bar__fill  { background: var(--p-blue-400); }

.p-dark .upload-result-bar {
  background: var(--p-green-900);
  border-color: var(--p-green-700);
  color: var(--p-green-200);
}
.p-dark .upload-result-bar .pi-check-circle { color: var(--p-green-400); }

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

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.info-text {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--p-text-muted-color);
}

.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

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
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
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
  border-bottom: 1px solid var(--p-content-border-color);
  flex-shrink: 0;
}

.error-flyout-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--p-text-muted-color);
  padding: 0.25rem;
  border-radius: 4px;
}
.error-flyout-close:hover { color: var(--p-text-color); background: var(--p-content-hover-background); }

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
  border-bottom: 1px solid var(--p-content-hover-background);
}

.error-flyout-list li:last-child { border-bottom: none; }

/* ── Desktop Select Bar ──────────────────────────────────────────────────── */
.desktop-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  background: var(--p-primary-50, #eff6ff);
  border-bottom: 1px solid var(--p-primary-200, #bfdbfe);
  gap: 0.75rem;
}

.desktop-select-count {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--p-primary-700, #1d4ed8);
}

.desktop-select-actions {
  display: flex;
  gap: 0.5rem;
}

/* ── Desktop Select Toggle (hidden on mobile – FAB is used instead) ──────── */
.desktop-select-toggle {
  display: inline-flex;
}

/* ── Mobile Backdrop ─────────────────────────────────────────────────────── */
.mobile-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: var(--z-mobile-backdrop);
}

/* ── Mobile FABs ─────────────────────────────────────────────────────────── */
.mobile-fab {
  display: none;
  position: fixed;
  bottom: 1.5rem;
  z-index: var(--z-mobile-fab);
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

.mobile-fab--select {
  left: 1rem;
  background: var(--p-content-background);
  color: var(--p-text-muted-color);
  border: 1px solid var(--p-content-border-color);
}


/* ── Mobile Select Action-Bar ────────────────────────────────────────────── */
.mobile-select-bar {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: var(--z-mobile-fab);
  background: var(--p-content-background);
  border-top: 1px solid var(--p-content-border-color);
  padding: 0.75rem 1rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.12);
}

.mobile-select-count {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--p-text-color);
  flex-shrink: 1;
  min-width: 0;
}

.mobile-select-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* ── Sidebar Sheet Wrapper ───────────────────────────────────────────────── */
.sidebar-sheet {
  /* Desktop: normaler Flex-Child, Wrapper unsichtbar */
  display: contents;
}

/* Schließen-Button + Header nur auf Mobile sichtbar */
.sidebar-sheet-header { display: none; }
.sidebar-sheet-close { display: none; }

/* ── Mobile Breakpoint ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .mobile-backdrop { display: block; }
  .mobile-fab { display: flex; }
  .mobile-select-bar { display: flex; }

  /* Sidebar Sheet → Bottom Sheet */
  .sidebar-sheet {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: calc(100dvh - var(--menubar-height, 3.5rem));
    z-index: var(--z-mobile-drawer);
    background: var(--p-content-background);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--p-content-border-color);
    transform: translateY(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .sidebar-sheet.is-open {
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

  /* Desktop-Auswahl auf Mobile ausblenden (FABs + Mobile-Bar übernehmen) */
  .desktop-select-toggle { display: none; }
  .desktop-select-bar { display: none; }

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
}

</style>
