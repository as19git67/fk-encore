<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoGrid from '../components/PhotoGrid.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import SortMenu from '../components/SortMenu.vue'
import { useFilter } from '../composables/useFilter'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import { matchesPhotoFilter, type PhotoFilterContext } from '../utils/photoFilter'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))
import {
  type AlbumWithPhotos,
  deleteAlbum,
  getPhotoFaces,
  getAlbum,
  getPhotoLandmarks,
  ignoreFace,
  leaveAlbum,
  listPhotoGroups,
  reindexPhoto,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type Photo,
  type PhotoFilter,
  type PhotoGroup,
  updatePhotoCuration,
  updatePhotoDate,
  updateAlbum,
  updateAlbumUserSettings,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoNavStore } from '../stores/photoNav'
import { usePhotoGrouping } from '../composables/usePhotoGrouping'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useNaturalSearch } from '../composables/useNaturalSearch'
import { useReferenceData } from '../composables/useReferenceData'
import type { PhotoItem } from '../composables/usePhotoGrouping'
import { onUnmounted } from 'vue'
import { useRealtimeEvent } from '../composables/useRealtime'
import {
  albumsViewQueryFromStorage,
  rememberFocusedAlbumId,
} from '../utils/albumsViewState'

const route = useRoute()
const router = useRouter()
const albumId = computed(() => Number(route.params.id))
const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const photoNav = usePhotoNavStore()

// Shared with AlbumsView: when the user navigates back from this detail view,
// the album list restores focus and scroll position to this album.
const rememberFocusedAlbum = rememberFocusedAlbumId

// Read the persisted filter/sort/search from storage and hand it to the
// router as query params, so the URL reflects the user's last filters
// from the very first paint of the list view. Without this, leaving an
// album lands on `/fotos/alben` (no query) and the user briefly sees an
// unfiltered list before AlbumsView re-applies state from localStorage.
function navigateBackToAlbums() {
  rememberFocusedAlbum(albumId.value)
  router.push({ name: 'fotos-albums', query: albumsViewQueryFromStorage() })
}

// ── Data ──────────────────────────────────────────────────────────────────────
const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)

// Per-album map of the last photo the user had selected, so reopening an
// album restores the scroll/selection position rather than snapping to top.
const LAST_PHOTO_MAP_KEY = 'albums_last_photo_by_album'

function loadLastPhotoMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_PHOTO_MAP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveLastPhotoForAlbum(id: number, photoId: number) {
  const map = loadLastPhotoMap()
  map[String(id)] = photoId
  localStorage.setItem(LAST_PHOTO_MAP_KEY, JSON.stringify(map))
}

const isFullscreen = ref(false)
watch(isFullscreen, (val) => {
  if (!val) nextTick(() => photoGridRef.value?.scrollToPhoto(selectedIndex.value, 'instant'))
})

// ── Filter state ──────────────────────────────────────────────────────────────
// Client-side filter over the album photos returned by the server. The backend
// always serves the complete album (see `loadData` where settings.active_view
// is forced to "all"); filtering happens here via FilterMenu.
const { applied: filter, draft: filterDraft, activeCount, openEdit, apply: applyFilter, reset: resetFilter, removeKey } =
  useFilter({ preserveKeys: ['photoId'] })
const filterMenuOpen = ref(false)
// Lazy-Mount: siehe GalleryView. Spart /persons + /albums beim Album-Öffnen.
const filterMenuMounted = ref(false)
const FILTER_AVAILABLE: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'> = [
  'hiddenMode', 'favorite', 'groupHighlight', 'inGroup',
  'othersFavorited', 'othersHidden',
  'qualityRange', 'mediaTypes', 'hasGps',
  'dateRange', 'sizeRange',
]

function openFilterMenu() {
  openEdit()
  filterMenuMounted.value = true
  filterMenuOpen.value = true
}
function onApplyFilter() {
  applyFilter()
}
function onResetFilter() {
  resetFilter()
}
function onRemoveFilterKey(keys: Array<keyof typeof filter.value>) {
  removeKey(keys)
}

// ── Sort state ────────────────────────────────────────────────────────────────
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

function comparePhotos(a: Photo, b: Photo): number {
  const { field, direction } = sort.value
  const dir = direction === 'asc' ? 1 : -1
  switch (field) {
    case 'taken_at':
    case 'created_at': {
      const ta = new Date((a as any)[field] || a.created_at).getTime()
      const tb = new Date((b as any)[field] || b.created_at).getTime()
      return (ta - tb) * dir
    }
    case 'ai_quality_score': {
      const qa = a.ai_quality_score ?? -Infinity
      const qb = b.ai_quality_score ?? -Infinity
      return (qa - qb) * dir
    }
    case 'filename':
      return a.filename.localeCompare(b.filename) * dir
    case 'size':
      return (a.size - b.size) * dir
    default:
      return 0
  }
}

// Raw album photos, sorted per the applied sort state (pre-filter). Used as
// the source for grouping (stacks) and the filter-context sets so that
// client-side filtering doesn't cause the stacks to shrink.
const rawAlbumPhotos = computed<Photo[]>(() =>
  [...((album.value?.photos ?? []) as Photo[])].sort(comparePhotos)
)

const curationStatsMap = computed(() => {
  const m = new Map<number, { fav_count: number; hide_count: number }>()
  for (const p of (album.value?.photos ?? [])) {
    if (p.curation_stats) m.set(p.id, p.curation_stats)
  }
  return m
})

// ── Similar-photo groups (stacks) ─────────────────────────────────────────────
// Load all user's groups; filter to those with 2+ members in this album.
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)

const albumPhotoIds = computed(() => new Set(rawAlbumPhotos.value.map(p => p.id)))

// Groups scoped to this album: only include groups where at least 2 photos
// are in the album. Trim each group's member list to the album members and
// choose an album-internal cover photo.
const albumPhotoGroups = computed<PhotoGroup[]>(() => {
  const result: PhotoGroup[] = []
  for (const g of photoGroupsList.value) {
    const membersInAlbum = g.photo_ids.filter(id => albumPhotoIds.value.has(id))
    if (membersInAlbum.length < 2) continue
    const coverInAlbum = g.cover_photo_id && albumPhotoIds.value.has(g.cover_photo_id)
      ? g.cover_photo_id
      : membersInAlbum[0]
    result.push({
      ...g,
      photo_ids: membersInAlbum,
      cover_photo_id: coverInAlbum,
      member_count: membersInAlbum.length,
    })
  }
  return result
})

const photoToGroup = computed(() => {
  const map = new Map<number, PhotoGroup>()
  // Reviewed first, unreviewed last — so unreviewed groups win for photos
  // that belong to both (happens transiently when members were added and a
  // new superset group was created alongside the old reviewed one).
  for (const group of albumPhotoGroups.value) {
    if (!group.reviewed_at) continue
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  for (const group of albumPhotoGroups.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  return map
})

const unreviewedGroupCount = computed(() =>
  albumPhotoGroups.value.filter(g => !g.reviewed_at).length
)

const hiddenByStack = computed(() => {
  const set = new Set<number>()
  for (const group of albumPhotoGroups.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) {
      if (pid !== group.cover_photo_id) set.add(pid)
    }
  }
  return set
})

// Album photos after applying the FilterMenu criteria. Stacks / grouping run
// on top of this filtered set, so filtering narrows the grid naturally.
const albumPhotos = computed<Photo[]>(() => {
  const ctx: PhotoFilterContext = {
    curationStats: curationStatsMap.value,
    groupCoverIds: new Set(
      albumPhotoGroups.value
        .map(g => g.cover_photo_id)
        .filter((id): id is number => id != null),
    ),
    inGroupIds: new Set(albumPhotoGroups.value.flatMap(g => g.photo_ids)),
  }
  return rawAlbumPhotos.value.filter(p => matchesPhotoFilter(p, filter.value, ctx))
})

// When the filter narrows the visible photos, clamp selectedIndex so the
// sidebar/keyboard nav don't point past the end of the list.
watch(() => albumPhotos.value.length, (len) => {
  if (len === 0) { selectedIndex.value = -1; return }
  if (selectedIndex.value >= len) selectedIndex.value = len - 1
})

// ── Search ────────────────────────────────────────────────────────────────────
// Uses the natural-language search endpoint (spaCy-parsed location + date
// filters combined with CLIP semantic search). Results are global across
// the user's library; usePhotoGrouping's id-filter discards hits that
// aren't in this album.
const {
  searchQuery,
  searchResultIds,
  loading: searchLoading,
  error: searchError,
  executeSearch,
  clearSearch,
  locationChip,
  dateChip,
  semanticChip,
  hasParsedChips,
} = useNaturalSearch()

// Count of hits that actually land in this album (global search minus
// photos from other albums) so the displayed number matches what the user
// sees in the grid.
const searchResultCountInAlbum = computed<number | null>(() => {
  const ids = searchResultIds.value
  if (ids === null) return null
  return ids.filter(id => albumPhotoIds.value.has(id)).length
})

// Album photos narrowed to the active search hits. When no search is
// running, returns the full album. Used by the map view, which doesn't go
// through usePhotoGrouping.
const albumPhotosFiltered = computed<Photo[]>(() => {
  const ids = searchResultIds.value
  if (ids === null) return albumPhotos.value
  const hitSet = new Set(ids)
  return albumPhotos.value.filter(p => hitSet.has(p.id))
})

// ── Grouping (via composable) ─────────────────────────────────────────────────
const { groupedPhotos } = usePhotoGrouping(albumPhotos, {
  hiddenByStack,
  photoToGroup,
  searchResultIds,
})

// ── Navigation refs ───────────────────────────────────────────────────────────
const photoGridRef = ref<InstanceType<typeof PhotoGrid> | null>(null)

// ── Keyboard navigation (via composable) ─────────────────────────────────────
useGalleryKeyboard({
  isBlocked: () => !!activeGroup.value,
  onLeft() {
    if (isFullscreen.value) { if (selectedIndex.value > 0) selectedIndex.value--; return }
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = albumPhotos.value.length - 1
  },
  onRight() {
    if (isFullscreen.value) {
      if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++; return
    }
    if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  },
  onUp() {},
  onDown() {},
  onSpace() {
    if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value
  },
  onExtra(e) {
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
    else if (e.key === 'Enter' && !isFullscreen.value && selectedIndex.value !== -1) { isFullscreen.value = true; e.preventDefault() }
    else if ((e.key === 'f' || e.key === 'F') && selectedPhoto.value) { handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status); e.preventDefault() }
  },
})

// ── Computed ──────────────────────────────────────────────────────────────────
const selectedPhoto = computed(() =>
  selectedIndex.value >= 0 ? albumPhotos.value[selectedIndex.value] ?? null : null
)
const prevPhoto = computed(() =>
  selectedIndex.value > 0 ? albumPhotos.value[selectedIndex.value - 1] ?? null : null
)
const nextPhoto = computed(() =>
  selectedIndex.value < albumPhotos.value.length - 1
    ? albumPhotos.value[selectedIndex.value + 1] ?? null : null
)

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const isOwner = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const canManageData = computed(() => auth.hasPermission('data.manage'))
const showPersons = computed(() => auth.hasPermission('people.view'))

// ── Display mode ─────────────────────────────────────────────────────────────
// `album.display_mode` is the album-level setting: 'map' = map enabled,
// 'grid' = map disabled. When map is enabled the user can flip between
// raster and map view on the fly via `viewMode`; otherwise we lock to grid.
const mapEnabled = computed(() => album.value?.display_mode === 'map')
const viewMode = ref<'grid' | 'map'>('grid')

watch(album, (a) => {
  if (!a) return
  // Default to the user's last choice when revisiting the album within the
  // session; on initial load fall back to map view if the album has it
  // enabled (the curated experience), otherwise grid.
  viewMode.value = a.display_mode === 'map' ? 'map' : 'grid'
}, { immediate: true })

const viewModeOptions: Array<{ label: string; value: 'grid' | 'map'; icon: string }> = [
  { label: 'Raster', value: 'grid', icon: 'pi pi-th-large' },
  { label: 'Karte', value: 'map', icon: 'pi pi-map' },
]

// ── Map fullscreen ───────────────────────────────────────────────────────────
const tripMapRef = ref<{ selectStopByPhotoId: (id: number) => boolean } | null>(null)
const mapFullscreenPhotos = ref<Photo[]>([])
const mapFullscreenIndex = ref(0)
const isMapFullscreen = ref(false)

// When navigating to this album via ?photoId= and the album is in map mode,
// we need to select the stop containing that photo once TripMap has mounted.
// TripMap is a defineAsyncComponent so it isn't available synchronously.
const pendingMapSelectPhotoId = ref<number | null>(null)

watch(tripMapRef, (ref) => {
  if (ref && pendingMapSelectPhotoId.value !== null) {
    ref.selectStopByPhotoId(pendingMapSelectPhotoId.value)
    pendingMapSelectPhotoId.value = null
  }
})

function handleMapFullscreen(stopPhotos: Photo[], startIndex: number) {
  // Use all album photos so left/right navigation works across stops
  const allPhotos = albumPhotos.value
  const targetPhoto = stopPhotos[startIndex]
  const globalIndex = targetPhoto ? allPhotos.findIndex(p => p.id === targetPhoto.id) : -1
  mapFullscreenPhotos.value = allPhotos
  mapFullscreenIndex.value = globalIndex >= 0 ? globalIndex : 0
  isMapFullscreen.value = true
}

function closeMapFullscreen() {
  // Sync the map's selected stop with the photo the user ended on, so that
  // navigating beyond the original stop inside fullscreen is reflected on
  // the map once the overlay is closed.
  const ended = mapSelectedPhoto.value
  if (ended && tripMapRef.value) {
    tripMapRef.value.selectStopByPhotoId(ended.id)
  }
  isMapFullscreen.value = false
}

const mapSelectedPhoto = computed(() =>
  mapFullscreenIndex.value >= 0 ? mapFullscreenPhotos.value[mapFullscreenIndex.value] ?? null : null
)
const mapPrevPhoto = computed(() =>
  mapFullscreenIndex.value > 0 ? mapFullscreenPhotos.value[mapFullscreenIndex.value - 1] ?? null : null
)
const mapNextPhoto = computed(() =>
  mapFullscreenIndex.value < mapFullscreenPhotos.value.length - 1
    ? mapFullscreenPhotos.value[mapFullscreenIndex.value + 1] ?? null : null
)

// ── Sidebar state ─────────────────────────────────────────────────────────────
const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const { persons, fetchPersons, invalidateAlbums } = useReferenceData()

// The sidebar (including the fullscreen details flyout) follows either
// the grid selection or, when the map fullscreen is open, the photo
// currently shown in the map overlay. Watch the effective photo so
// faces/landmarks reflect what the user actually sees.
const activeDetailPhoto = computed(() =>
  isMapFullscreen.value ? mapSelectedPhoto.value : selectedPhoto.value
)

watch(activeDetailPhoto, (photo) => {
  if (photo) {
    loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

watch(selectedIndex, () => {
  const photo = selectedPhoto.value
  if (photo && !isFullscreen.value) {
    const el = photoGridRef.value?.scrollRef?.querySelector(`[data-photo-id="${photo.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
})

watch(selectedPhoto, (photo) => {
  if (photo && album.value) {
    saveLastPhotoForAlbum(album.value.id, photo.id)
    photoNav.selectPhoto(photo.id)
  }
})

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  loading.value = true
  try {
    const [albumRes, groupsRes] = await Promise.all([
      getAlbum(albumId.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    album.value = albumRes
    photoGroupsList.value = groupsRes.groups

    // Legacy view presets (favorites / consensus / others-favorites) are
    // replaced by the client-side FilterMenu. If a user has a non-default
    // preset persisted from the old UI, silently reset it to "all" so the
    // backend returns the complete album and the filter can take over.
    if (album.value?.settings && album.value.settings.active_view !== 'all') {
      try {
        await updateAlbumUserSettings(albumId.value, { active_view: 'all' })
        album.value.settings.active_view = 'all'
        const reloaded = await getAlbum(albumId.value)
        album.value = reloaded
      } catch { /* ignore – filter still narrows the returned set */ }
    }

    // Honor ?photoId=… query: pre-select and scroll to that photo.
    // If the target photo is hidden as a stack member, fall back to the
    // stack's cover photo (which is what's actually rendered in the grid).
    const queryPhotoId = Number(route.query.photoId)
    let targetIdx = -1
    function resolveToIndex(photoId: number): number {
      let effectiveId = photoId
      if (hiddenByStack.value.has(photoId)) {
        const group = photoToGroup.value.get(photoId)
        if (group?.cover_photo_id) effectiveId = group.cover_photo_id
      }
      return albumPhotos.value.findIndex(p => p.id === effectiveId)
    }
    if (queryPhotoId) {
      targetIdx = resolveToIndex(queryPhotoId)
      if (targetIdx >= 0) {
        router.replace({ query: { ...route.query, photoId: undefined } })
        // In map mode the grid index is irrelevant; request the TripMap to
        // select the stop containing this photo once it has mounted.
        if (albumRes.display_mode === 'map') {
          pendingMapSelectPhotoId.value = queryPhotoId
        }
      }
    }
    if (targetIdx < 0) {
      // Fall back chain: album-specific last photo → shared nav store → none.
      const storedPhotoId = loadLastPhotoMap()[String(albumId.value)]
        ?? photoNav.selectedPhotoId
        ?? null
      if (storedPhotoId) targetIdx = resolveToIndex(storedPhotoId)
    }
    if (targetIdx < 0) {
      selectedIndex.value = album.value.photos.length > 0 ? 0 : -1
    } else {
      selectedIndex.value = targetIdx
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Albums'
  } finally {
    loading.value = false
  }
}

async function loadPersons() {
  try { await fetchPersons() } catch { /* ignore */ }
}

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

// ── Curation ──────────────────────────────────────────────────────────────────
// Mutate the photo object directly so that Vue's reactive proxy picks up the
// change and re-renders every template that reads `curation_status`
// (PhotoGrid tile, PhotoDetailSidebar, FullscreenOverlay toolbar). Replacing
// the whole `photos` array works for computeds that depend on the array
// reference, but the `selectedPhoto` reference passed to FullscreenOverlay
// stays tied to a stale object because `albumPhotos` is a sorted copy — so a
// targeted mutation is the more reliable approach here.
function updatePhotoStatus(id: number, status: CurationStatus) {
  if (!album.value) return
  const photo = album.value.photos.find(p => p.id === id)
  if (!photo) return
  const prev = photo.curation_status
  if (prev === status) return
  photo.curation_status = status
  // Keep the per-photo aggregate counters shown under "Meinungen" in sync
  // with the current user's own toggle. The server re-aggregates across all
  // members, but until the next reload we adjust locally so the opinion
  // bars reflect the new state immediately.
  const stats = photo.curation_stats
  if (stats) {
    if (prev === 'favorite' && status !== 'favorite') stats.fav_count = Math.max(0, stats.fav_count - 1)
    if (prev !== 'favorite' && status === 'favorite') stats.fav_count += 1
    if (prev === 'hidden' && status !== 'hidden') stats.hide_count = Math.max(0, stats.hide_count - 1)
    if (prev !== 'hidden' && status === 'hidden') stats.hide_count += 1
  }
}

async function handleHidePhoto(id: number) {
  const photo = album.value?.photos.find(p => p.id === id)
  const prev = photo?.curation_status
  updatePhotoStatus(id, 'hidden')
  try { await updatePhotoCuration(id, 'hidden') }
  catch (err: any) { if (prev) updatePhotoStatus(id, prev); error.value = err.message || 'Fehler' }
}

async function handleRestorePhoto(id: number) {
  const photo = album.value?.photos.find(p => p.id === id)
  const prev = photo?.curation_status
  updatePhotoStatus(id, 'visible')
  try { await updatePhotoCuration(id, 'visible') }
  catch (err: any) { if (prev) updatePhotoStatus(id, prev); error.value = err.message || 'Fehler' }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  updatePhotoStatus(id, newStatus)
  try { await updatePhotoCuration(id, newStatus) }
  catch (err: any) { updatePhotoStatus(id, currentStatus); error.value = err.message || 'Fehler' }
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try { await ignoreFace(faceId); detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId) }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

// ── Photo date editing (sidebar pencil) ───────────────────────────────────────
const isEditingDate = ref(false)
const editDate = ref<Date | null>(null)
const updatingDate = ref(false)
const dateEditingPhoto = ref<Photo | null>(null)

function startEditingDate() {
  // Pick the currently active photo: map mode uses `mapSelectedPhoto`,
  // otherwise the grid/fullscreen selection.
  const photo = mapSelectedPhoto.value || selectedPhoto.value
  if (!photo) return
  dateEditingPhoto.value = photo
  editDate.value = new Date(photo.taken_at || photo.created_at)
  isEditingDate.value = true
}

async function handleUpdateDate() {
  const photo = dateEditingPhoto.value
  if (!editDate.value || !photo || !album.value) return
  updatingDate.value = true
  try {
    const takenAt = editDate.value.toISOString()
    await updatePhotoDate(photo.id, takenAt)
    album.value.photos = album.value.photos.map(p => p.id === photo.id ? { ...p, taken_at: takenAt } : p)
    isEditingDate.value = false
    dateEditingPhoto.value = null
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Aktualisieren des Datums'
  } finally {
    updatingDate.value = false
  }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try { await reindexPhoto(selectedPhoto.value.id); await loadSidebarData(selectedPhoto.value.id) }
  catch (err: any) { error.value = err.message || 'Fehler' }
  finally { reindexingPhoto.value = false }
}

function applyViewerCoverOverride(id: number | null) {
  if (!album.value) return
  if (album.value.settings) {
    album.value.settings.cover_photo_id = id
  } else {
    // Viewer has never persisted any setting yet – synthesise a minimal
    // local settings object so the UI reflects the toggled cover instantly.
    album.value.settings = {
      album_id: album.value.id,
      user_id: 0,
      hide_mode: 'mine',
      active_view: 'all',
      cover_photo_id: id,
    }
  }
}

function handleCoverPhotoIdUpdate(id: number | null) {
  if (!album.value) return
  if (canWrite.value) {
    album.value.cover_photo_id = id ?? undefined
  } else {
    applyViewerCoverOverride(id)
  }
}

async function handleSetMapCover(photoId: number) {
  if (!album.value) return
  const newCoverId = effectiveCoverPhotoId.value === photoId ? null : photoId
  try {
    if (canWrite.value) {
      await updateAlbum(albumId.value, { coverPhotoId: newCoverId })
      invalidateAlbums()
      album.value.cover_photo_id = newCoverId ?? undefined
    } else {
      await updateAlbumUserSettings(albumId.value, { cover_photo_id: newCoverId })
      applyViewerCoverOverride(newCoverId)
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Setzen des Covers'
  }
}

// ── Delete album ─────────────────────────────────────────────────────────────
const showDeleteDialog = ref(false)
const deletingAlbum = ref(false)

async function handleDeleteAlbum() {
  if (!album.value) return
  deletingAlbum.value = true
  try {
    await deleteAlbum(album.value.id)
    invalidateAlbums()
    showDeleteDialog.value = false
    router.push({ name: 'fotos-albums', query: albumsViewQueryFromStorage() })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    deletingAlbum.value = false
  }
}

// ── Leave album share ────────────────────────────────────────────────────────
const showLeaveDialog = ref(false)
const leavingAlbum = ref(false)

async function handleLeaveAlbum() {
  if (!album.value) return
  leavingAlbum.value = true
  try {
    await leaveAlbum(album.value.id)
    showLeaveDialog.value = false
    router.push({ name: 'fotos-albums', query: albumsViewQueryFromStorage() })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Verlassen der Freigabe'
  } finally {
    leavingAlbum.value = false
  }
}

// ── Grid interaction ──────────────────────────────────────────────────────────
function handlePhotoClick(item: PhotoItem) {
  selectedIndex.value = item.index
  // Mobile: Single-Tap öffnet Fullscreen (kein Sidebar sichtbar)
  if (window.innerWidth <= 768) isFullscreen.value = true
}

// ── Stack / similar-photo group handling ─────────────────────────────────────
function handleStackClick(group: PhotoGroup) {
  activeGroup.value = group
}

function selectAfterGroup(group: PhotoGroup | null) {
  if (!group || albumPhotos.value.length === 0) {
    selectedIndex.value = albumPhotos.value.length > 0 ? 0 : -1
    return
  }
  const groupPhotoIds = new Set(group.photo_ids)
  const visible = albumPhotos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id) && !hiddenByStack.value.has(photo.id))
  if (visible.length > 0) {
    selectedIndex.value = visible[0]!.index
    return
  }
  selectedIndex.value = albumPhotos.value.findIndex(p => !hiddenByStack.value.has(p.id))
}

async function handleGroupClose() {
  const group = activeGroup.value
  activeGroup.value = null
  await loadData() // reloads album photos and groups
  selectAfterGroup(group)
}

async function handleGroupNext(reviewedGroupId: number) {
  const candidateId = albumPhotoGroups.value.find(g => !g.reviewed_at && g.id !== reviewedGroupId)?.id
  await loadData()
  if (candidateId !== undefined) {
    // Re-resolve against the freshly loaded list so photo_ids reflect the latest album state.
    const refreshed = albumPhotoGroups.value.find(g => g.id === candidateId && !g.reviewed_at)
    activeGroup.value = refreshed ?? null
  } else {
    const group = activeGroup.value
    activeGroup.value = null
    selectAfterGroup(group)
  }
}

function handleStartGroupReview() {
  const first = albumPhotoGroups.value.find(g => !g.reviewed_at)
  if (first) activeGroup.value = first
}

// ── Album cover ───────────────────────────────────────────────────────────────
// Effective cover: user-specific setting takes precedence over album-level
// cover. An explicit `null` in the user settings means "the user hid the
// cover for themselves" and must NOT fall back to the album-level cover.
const effectiveCoverPhotoId = computed<number | null | undefined>(() => {
  if (!album.value) return undefined
  const userCover = album.value.settings?.cover_photo_id
  if (userCover !== undefined) return userCover // number | null
  return album.value.cover_photo_id
})

async function scrollToCover() {
  if (!effectiveCoverPhotoId.value) return
  const idx = albumPhotos.value.findIndex(p => p.id === effectiveCoverPhotoId.value)
  if (idx >= 0) selectedIndex.value = idx
}

// ── Description editing ───────────────────────────────────────────────────────
const updatingAlbum = ref(false)
const editingDescription = ref(false)
const descDraft = ref('')

function startEditDesc() {
  if (!album.value) return
  descDraft.value = album.value.description || ''
  editingDescription.value = true
}

async function saveDescription() {
  if (!album.value) return
  updatingAlbum.value = true
  try {
    await updateAlbum(albumId.value, { description: descDraft.value })
    invalidateAlbums()
    album.value.description = descDraft.value
    editingDescription.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Beschreibung'
  } finally {
    updatingAlbum.value = false
  }
}

// ── Mobile drawer state ───────────────────────────────────────────────────────
const mobileSidebarOpen = ref(false)
/** Whether the details flyout inside the fullscreen overlay is open.
 *  Shared between the grid- and map-mode fullscreens (only one is ever
 *  visible at a time). Kept as a persistent ref so that navigating
 *  between photos does not close the flyout. */
const fullscreenDetailsOpen = ref(false)

// ── Init ──────────────────────────────────────────────────────────────────────
rememberFocusedAlbum(albumId.value)
void loadData()
if (showPersons.value) void loadPersons()
serviceHealth.startPolling()
onUnmounted(() => serviceHealth.stopPolling())

// Reload when navigating between album-detail routes (same component is
// reused by Vue Router on param changes). Without this, jumping from one
// album to another via the Jump Dialog updates the URL but keeps the old
// album's data, so subsequent jumps appear to do nothing.
watch(albumId, (id) => {
  rememberFocusedAlbum(id)
  album.value = null
  selectedIndex.value = -1
  activeGroup.value = null
  detectedFaces.value = []
  detectedLandmarks.value = []
  pendingMapSelectPhotoId.value = null
  void loadData()
})

// Reload when someone else adds a photo to the album we're currently viewing,
// so shared participants see new photos without a manual refresh.
useRealtimeEvent('albums', 'photo_added', (ev) => {
  if (Number(ev.resourceId) !== albumId.value) return
  void loadData()
})

// Refresh when another participant favourites or hides a photo from
// this album. Repaints the heart icon, fav-count badge and the
// "Meinungen" bars in the open detail view.
useRealtimeEvent('photos', 'curation.changed', (ev) => {
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  if (!album.value?.photos?.some((p) => p.id === photoId)) return
  void loadData()
})
</script>

<template>
  <div class="album-detail-view">
    <ServiceStatusBar />

    <div v-if="album" class="subheader">
      <div class="header">
        <!-- 1. Album name + role badge -->
        <div class="header__title-group">
          <Button
            icon="pi pi-arrow-left"
            size="small"
            text
            rounded
            class="header__back"
            aria-label="Zurück zur Albumübersicht"
            v-tooltip="'Zurück zur Albumübersicht'"
            @click="navigateBackToAlbums"
          />
          <h1 class="header__title">{{ album.name }}</h1>
          <span :class="['header__badge', `header__badge--${album.role}`]">{{ album.role }}</span>
        </div>

        <!-- 2. Metadata -->
        <div class="header__meta">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            &bull; {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </div>

        <!-- 3. Description with edit -->
        <div v-if="viewMode !== 'map'" class="header__description">
          <div v-if="!editingDescription" class="header__description-view">
            <span :class="{ 'header__description-text--empty': !album.description }" class="header__description-text">
              {{ album.description || 'Keine Beschreibung' }}
            </span>
            <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc" />
          </div>
          <div v-else class="header__description-edit">
            <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="2" />
            <div class="header__description-edit-actions">
              <Button :loading="updatingAlbum" icon="pi pi-check" size="small" @click="saveDescription" />
              <Button :disabled="updatingAlbum" icon="pi pi-times" size="small" text @click="editingDescription = false" />
            </div>
          </div>
        </div>

        <!-- 5. Filter -->
        <div class="header__filter">
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
        </div>

        <!-- 6. Action buttons -->
        <div class="header__actions">
          <SelectButton
            v-if="mapEnabled"
            v-model="viewMode"
            :options="viewModeOptions"
            optionLabel="label"
            optionValue="value"
            :allowEmpty="false"
            class="view-mode-switch"
            aria-label="Ansicht umschalten"
          >
            <template #option="slotProps">
              <i :class="slotProps.option.icon" v-tooltip.bottom="slotProps.option.label" />
              <span class="view-mode-switch__label">{{ slotProps.option.label }}</span>
            </template>
          </SelectButton>
          <Button
            v-if="canManageData && unreviewedGroupCount > 0 && viewMode !== 'map'"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images" severity="success" size="small"
            @click="handleStartGroupReview"
          />
          <Button v-if="effectiveCoverPhotoId && viewMode !== 'map'" icon="pi pi-image" size="small" text v-tooltip="'Cover fokussieren'" @click="scrollToCover" />
          <Button v-if="isOwner" icon="pi pi-trash" size="small" text severity="danger" v-tooltip="'Album löschen'" @click="showDeleteDialog = true" />
          <Button v-if="!isOwner" icon="pi pi-sign-out" size="small" text severity="danger" v-tooltip="'Freigabe verlassen'" @click="showLeaveDialog = true" />
        </div>
      </div>

      <!-- Natural-language search: global search, results filtered to this album -->
      <div v-if="albumPhotos.length > 0" class="album-search">
        <NaturalSearchBar
          v-model="searchQuery"
          :loading="searchLoading"
          :result-count="searchResultCountInAlbum"
          :has-parsed-chips="hasParsedChips"
          :location-chip="locationChip"
          :date-chip="dateChip"
          :semantic-chip="semanticChip"
          placeholder="Fotos in diesem Album suchen…"
          @search="executeSearch"
          @clear="clearSearch"
        />
        <Message v-if="searchError" severity="error" :closable="false">{{ searchError }}</Message>
      </div>

      <div v-if="activeCount > 0 || !isSortDefault" class="chip-row">
        <FilterChips :filter="filter" @remove="onRemoveFilterKey" />
        <Chip
          v-if="!isSortDefault"
          :label="sortChipLabel"
          removable
          @remove="onResetSort"
        />
        <Chip
          v-if="activeCount > 0 && rawAlbumPhotos.length > 0"
          :label="`${albumPhotos.length} von ${rawAlbumPhotos.length}`"
        />
      </div>
    </div>

    <FilterMenu
      v-if="filterMenuMounted"
      v-model:visible="filterMenuOpen"
      v-model:draft="filterDraft"
      :available="FILTER_AVAILABLE"
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

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && !album" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <!-- Map mode -->
    <TripMap
      v-if="album && viewMode === 'map' && albumPhotos.length > 0"
      ref="tripMapRef"
      :photos="albumPhotosFiltered"
      :albumName="album.name"
      :albumDescription="album.description"
      @open-fullscreen="handleMapFullscreen"
    />

    <!-- Two-column layout: PhotoGrid | Sidebar -->
    <div v-else-if="album && groupedPhotos.length > 0" class="gallery-layout">
      <!-- CENTER: Photo grid -->
      <PhotoGrid
        ref="photoGridRef"
        :groupedPhotos="groupedPhotos"
        :photos="albumPhotos"
        :selectedIndex="selectedIndex"
        :selectedPhotoIds="new Set(selectedPhoto ? [selectedPhoto.id] : [])"
        :canDelete="false"
        :hasStacks="true"
        :suppressScroll="isFullscreen"
        @update:columnCount="() => {}"
        @photo-click="handlePhotoClick"
        @photo-dblclick="isFullscreen = true"
        @stack-click="handleStackClick"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
      />

      <!-- RIGHT: Details sidebar – auf Mobile als Bottom-Sheet -->
      <div class="sidebar-sheet" :class="{ 'is-open': mobileSidebarOpen }">
        <div class="sidebar-sheet-header">
          <button class="sidebar-sheet-close" @click="mobileSidebarOpen = false" aria-label="Schließen">
            <i class="pi pi-times" />
          </button>
        </div>
        <PhotoDetailSidebar
          v-if="selectedPhoto"
          :photo="selectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :reindexing-photo="reindexingPhoto"
          :updating-date="updatingDate"
          :album-id="albumId"
          :cover-photo-id="effectiveCoverPhotoId"
          :album-role="album.role"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @fullscreen="isFullscreen = true"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @start-edit-date="startEditingDate"
          @update-date="handleUpdateDate"
          @cancel-edit-date="isEditingDate = false"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </div>
    </div>

    <div v-else-if="album" class="info-text">Keine Fotos in dieser Ansicht.</div>

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileSidebarOpen = false"
    />


    <!-- Fullscreen overlay (Grid mode) -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="fullscreenDetailsOpen"
      @close="isFullscreen = false; fullscreenDetailsOpen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
    >
      <!-- Mobile users open fullscreen with a single tap and have no
           visible sidebar to reach "Als Cover setzen" from. Surface the
           toggle directly in the topbar (matching the map-mode overlay)
           so the action is one tap away on every screen size. -->
      <template #topbar-actions-before>
        <Button
          icon="pi pi-image"
          rounded text
          :severity="effectiveCoverPhotoId === selectedPhoto.id ? 'warn' : 'secondary'"
          :class="{ 'fs-toolbar-btn--active': effectiveCoverPhotoId === selectedPhoto.id }"
          v-tooltip.bottom="(effectiveCoverPhotoId === selectedPhoto.id ? 'Vom Cover entfernen' : 'Als Cover setzen') + ' (C)'"
          @click="handleSetMapCover(selectedPhoto.id)"
        />
      </template>
      <template #details-flyout>
        <PhotoDetailSidebar
          :in-flyout="true"
          :photo="selectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :reindexing-photo="reindexingPhoto"
          :updating-date="updatingDate"
          :album-id="albumId"
          :cover-photo-id="effectiveCoverPhotoId"
          :album-role="album?.role"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @start-edit-date="startEditingDate"
          @update-date="handleUpdateDate"
          @cancel-edit-date="isEditingDate = false"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </template>
    </FullscreenOverlay>

    <!-- Fullscreen overlay (Map mode – scoped to stop photos) -->
    <FullscreenOverlay
      v-if="isMapFullscreen && mapSelectedPhoto"
      :photo="mapSelectedPhoto"
      :prevPhoto="mapPrevPhoto"
      :nextPhoto="mapNextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="fullscreenDetailsOpen"
      @close="closeMapFullscreen(); fullscreenDetailsOpen = false"
      @prev="mapFullscreenIndex--"
      @next="mapFullscreenIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
    >
      <template #topbar-actions-before>
        <Button
          icon="pi pi-image"
          rounded text
          :severity="effectiveCoverPhotoId === mapSelectedPhoto.id ? 'warn' : 'secondary'"
          :class="{ 'fs-toolbar-btn--active': effectiveCoverPhotoId === mapSelectedPhoto.id }"
          v-tooltip.bottom="(effectiveCoverPhotoId === mapSelectedPhoto.id ? 'Vom Cover entfernen' : 'Als Cover setzen') + ' (C)'"
          @click="handleSetMapCover(mapSelectedPhoto.id)"
        />
      </template>
      <template #details-flyout>
        <PhotoDetailSidebar
          :in-flyout="true"
          :photo="mapSelectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :reindexing-photo="reindexingPhoto"
          :updating-date="updatingDate"
          :album-id="albumId"
          :cover-photo-id="effectiveCoverPhotoId"
          :album-role="album?.role"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @start-edit-date="startEditingDate"
          @update-date="handleUpdateDate"
          @cancel-edit-date="isEditingDate = false"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </template>
    </FullscreenOverlay>

    <!-- Similar-photo group review overlay -->
    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :allPhotos="albumPhotos"
      :totalUnreviewed="unreviewedGroupCount"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />

    <!-- Delete album confirmation dialog -->
    <Dialog v-model:visible="showDeleteDialog" header="Album löschen" :modal="true" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du dieses Album wirklich löschen?</p>
        <p class="muted">Es werden keine Fotos gelöscht. Sie bleiben unter <b>Alle Fotos</b> erhalten.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showDeleteDialog = false" />
        <Button label="Löschen" severity="danger" :loading="deletingAlbum" @click="handleDeleteAlbum" />
      </template>
    </Dialog>

    <!-- Leave album share confirmation dialog -->
    <Dialog v-model:visible="showLeaveDialog" header="Freigabe verlassen" :modal="true" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du die Freigabe dieses Albums wirklich verlassen?</p>
        <p class="muted">Du verlierst den Zugriff auf dieses Album. Der Eigentümer kann dich später erneut einladen.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showLeaveDialog = false" />
        <Button label="Verlassen" severity="danger" :loading="leavingAlbum" @click="handleLeaveAlbum" />
      </template>
    </Dialog>

  </div>
</template>

<style scoped>
.album-detail-view {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--menubar-height, 3.5em));
  overflow: hidden;
}

@media (min-width: 800px) {
  .album-detail-view { margin-inline: 0.5em; }
}

.subheader {
  flex-shrink: 0;
  background: var(--p-content-background);
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
}

/* ── Flat header flex container ────────────────────────────────────────── */
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  padding: 0.75em 1em;
  gap: 0.5em 0.75em;
}

.header__actions { display: flex; align-items: center; gap: 0.25em; flex-wrap: wrap; }

/* Compact icon-first toggle: shows just the icon on narrow screens and adds
   the label next to it once there's room. PrimeVue's SelectButton renders
   each option as a button, so we lean on the slot to control content. */
.view-mode-switch :deep(.p-togglebutton) {
  padding: 0.25rem 0.5rem;
  min-width: 2rem;
}
.view-mode-switch__label { display: none; margin-left: 0.35em; }
@media (min-width: 600px) {
  .view-mode-switch__label { display: inline; }
}

.header__title-group {
  display: flex;
  align-items: center;
  gap: 0.5em;
}

.header__title {
  font-size: 1.5em;
  font-weight: 600;
  margin: 0;
}

.header__badge {
  font-size: 0.75em;
  padding: 0.2em 0.5em;
  border-radius: 4px;
  background: var(--p-content-border-color);
  text-transform: uppercase;
}
.header__badge--owner { background: var(--p-red-100); color: var(--p-red-700); }
.header__badge--contributor { background: var(--p-green-100); color: var(--p-green-700); }

@media (prefers-color-scheme: dark) {
  .header__badge--owner { background: var(--p-red-900); color: var(--p-red-200); }
  .header__badge--contributor { background: var(--p-green-900); color: var(--p-green-200); }
}

.header__description {
  flex: 1 1 auto;
  min-width: 0;
}
.header__description-view { display: flex; align-items: center; gap: 0.5em; }
.header__description-text { font-size: 0.9em; }
.header__description-text--empty { color: var(--p-text-muted-color); font-style: italic; }
.header__description-edit { display: flex; align-items: center; gap: 0.5em; width: 100%; }
.header__description-edit textarea { flex: 1; min-height: 2.5em; }
.header__description-edit-actions { display: flex; gap: 0.25em; }

.header__meta {
  font-size: 0.85em;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.header__filter { display: flex; align-items: center; gap: 0.5em; }

.chip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0 1em 0.5em;
}

/* ── Album-scoped natural search bar (inside subheader) ──────────────────── */
.album-search {
  padding: 0 1em 0.5em;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* ── Three-column layout ─────────────────────────────────────────────────── */
.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.info-text {
  text-align: center;
  padding: 3em 1em;
  color: var(--p-text-muted-color);
}

/* ── Sidebar Sheet Wrapper ───────────────────────────────────────────────── */
.sidebar-sheet { display: contents; }
.sidebar-sheet-header { display: none; }
.sidebar-sheet-close { display: none; }

/* ── Mobile Backdrop ─────────────────────────────────────────────────────── */
.mobile-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: var(--z-mobile-backdrop);
}

/* ── Mobile Breakpoint ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .mobile-backdrop { display: block; }

  .album-detail-view { margin-inline: 0; }

  .sidebar-sheet {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: calc(100dvh - var(--menubar-height, 3.5em));
    z-index: var(--z-mobile-drawer);
    background: var(--p-content-background);
    border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--p-content-border-color);
    transform: translateY(100%);
    transition: transform 0.3s ease;
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .sidebar-sheet.is-open { transform: translateY(0); }

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
    font-size: 0.85em;
    width: 1.75em;
    height: 1.75em;
    margin-top: 0.5em;
    margin-right: 0.5em;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    flex-shrink: 0;
  }
  .sidebar-sheet-close:hover {
    background: var(--p-content-hover-background);
  }

  .header__filter { order: 10; }

  /* Put action icons on the same row as the filter button */
  .header__actions { order: 11; }

  /* Compact header on mobile */
  .header { padding: 0.35em 0.65em; gap: 0.25em 0.5em; }
  .header__title { font-size: 1.1em; }
  .header__description { flex: 1 1 100%; }
  .header__description-text--empty { display: none; }
}

/* ── Delete dialog ──────────────────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 0.5em; padding: 0.5em 0; }
.dialog-body .muted { color: var(--p-text-muted-color); font-size: 0.9em; }

</style>
