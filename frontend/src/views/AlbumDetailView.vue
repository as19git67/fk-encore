<script lang="ts" setup>
import { computed, defineAsyncComponent, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Chip from 'primevue/chip'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import { useConfirm } from 'primevue/useconfirm'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import VirtualGallery from '../components/VirtualGallery.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import PhotoAlbumDialog from '../components/PhotoAlbumDialog.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import SortMenu from '../components/SortMenu.vue'
import { useFilter } from '../composables/useFilter'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import { matchesPhotoFilter, type PhotoFilterContext } from '../utils/photoFilter'
import {
  type GalleryGridEntry,
  type GalleryGridGroup,
  type GallerySortDir,
  type GallerySortField,
} from '../api/gallery'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))
import {
  type AlbumAccessLevel,
  type AlbumPublicLink,
  type AlbumShareWithUser,
  type AlbumWithPhotos,
  type BatchDeleteSkippedPhoto,
  type PublicLinkExpiry,
  addPhotoToAlbum,
  batchDeletePhotos,
  batchUpdateAlbumPhotos,
  checkPhotoHash,
  computeFileHash,
  uploadPhotoWithProgress,
  createAlbumPublicLink,
  deleteAlbum,
  deleteAlbumPublicLink,
  getAlbum,
  getAlbumPhotos,
  getAlbumShareableUsers,
  getAlbumShares,
  getPhotoDetailsBatch,
  getPhotoFaces,
  getPhotoLandmarks,
  getPhotoPoiMatches,
  ignoreFace,
  leaveAlbum,
  listPhotoGroups,
  reindexPhoto,
  removeAlbumShare,
  shareAlbum,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type PoiMatchItem,
  type Photo,
  type PhotoFilter,
  type PhotoGroup,
  type ShareableUser,
  updateAlbum,
  updateAlbumUserSettings,
  updatePhotoCuration,
  updatePhotoDate,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoNavStore } from '../stores/photoNav'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useNaturalSearch } from '../composables/useNaturalSearch'
import { useReferenceData } from '../composables/useReferenceData'
import { onMounted, onUnmounted } from 'vue'
import { useRealtimeEvent } from '../composables/useRealtime'
import {
  albumsViewQueryFromStorage,
  rememberFocusedAlbumId,
} from '../utils/albumsViewState'
import { toLocalIsoDateTime } from '../utils/dateFormat'
import { newestIndex, jumpTargetIndex } from '../utils/galleryJump'

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
// True when we arrived here from the content feed (it links with
// `?from=stream`). The back button then returns to the feed — which restores
// its scroll position — instead of the album list.
const cameFromFeed = computed(() => route.query.from === 'stream')

function navigateBackToAlbums() {
  rememberFocusedAlbum(albumId.value)
  if (cameFromFeed.value) {
    // The feed view restores its cached list + scroll position on mount.
    router.push({ name: 'fotos-stream' })
    return
  }
  // Prevent AlbumsView from jumping back into this album when it mounts.
  photoNav.consumeAlbumJump()
  router.push({ name: 'fotos-albums', query: albumsViewQueryFromStorage() })
}

// ── Data ──────────────────────────────────────────────────────────────────────
const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

// On a phone in portrait the header runs out of width, so the metadata wraps
// onto a second line. There we compact it: drop the "Fotos" unit word (CSS) and
// shorten the date range (start without year, end with a 2-digit year), e.g.
// "484 • 1.1. – 1.6.26" instead of "484 Fotos • 1.1.2026 – 1.6.2026".
const compactHeader = ref(false)
const headerMql = typeof window !== 'undefined'
  ? window.matchMedia('(max-width: 768px) and (orientation: portrait)')
  : null
function syncCompactHeader() {
  compactHeader.value = headerMql?.matches ?? false
}
syncCompactHeader()
onMounted(() => headerMql?.addEventListener('change', syncCompactHeader))
onUnmounted(() => headerMql?.removeEventListener('change', syncCompactHeader))

const headerDateRange = computed(() => {
  const o = album.value?.oldest_photo_at
  const n = album.value?.newest_photo_at
  if (!o || !n) return ''
  const od = new Date(o)
  const nd = new Date(n)
  if (compactHeader.value) {
    const start = `${od.getDate()}.${od.getMonth() + 1}.`
    const yy = String(nd.getFullYear() % 100).padStart(2, '0')
    const end = `${nd.getDate()}.${nd.getMonth() + 1}.${yy}`
    return `${start} – ${end}`
  }
  return `${od.toLocaleDateString()} – ${nd.toLocaleDateString()}`
})

// Per-album persisted view mode (raster vs map) for map-enabled albums, so
// reopening an album restores the user's last chosen view instead of always
// snapping back to the album default. Mirrors the last-photo persistence above.
const VIEW_MODE_MAP_KEY = 'albums_view_mode_by_album'

function loadViewModeMap(): Record<string, 'grid' | 'map'> {
  try {
    const raw = localStorage.getItem(VIEW_MODE_MAP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function loadViewModeForAlbum(id: number): 'grid' | 'map' | null {
  const v = loadViewModeMap()[String(id)]
  return v === 'grid' || v === 'map' ? v : null
}

function saveViewModeForAlbum(id: number, mode: 'grid' | 'map') {
  const map = loadViewModeMap()
  map[String(id)] = mode
  try { localStorage.setItem(VIEW_MODE_MAP_KEY, JSON.stringify(map)) } catch { /* quota / private-mode — ignore */ }
}

const isFullscreen = ref(false)

// ── VirtualGallery grid + cursor state (#304) ───────────────────────────────
const galleryRef = ref<InstanceType<typeof VirtualGallery> | null>(null)
const cursorIndex = ref<number | null>(null)
// Photo to center on when VirtualGallery mounts (passed as aroundPhotoId).
// Set by map stop selection and map fullscreen close so that switching from
// map to grid always loads entries around the right photo.
const galleryAnchorPhotoId = ref<number | null>(null)
const cursorPhoto = ref<Photo | null>(null)
const cursorPrev = ref<Photo | null>(null)
const cursorNext = ref<Photo | null>(null)
// Similar-photo-group context for the cursor cell, mirrored into
// FullscreenOverlay so the `+N` Track-I badge shows up in the album's
// fullscreen view too (it was previously only wired up in GalleryView).
const cursorGroup = ref<GalleryGridGroup | null>(null)
let hydrateToken = 0
let curationVersion = 0

// ── Filter state ──────────────────────────────────────────────────────────────
// Client-side filter over the album photos returned by the server. The backend
// always serves the complete album (see `loadData` where settings.active_view
// is forced to "all"); filtering happens here via FilterMenu.
const { applied: filter, draft: filterDraft, activeCount, openEdit, apply: applyFilter, reset: resetFilter, removeKey } =
  useFilter({ preserveKeys: ['photoId'] })
const filterMenuOpen = ref(false)
// Lazy-Mount: siehe GalleryView. Spart /persons + /albums beim Album-Öffnen.
const filterMenuMounted = ref(false)
const FILTER_AVAILABLE = computed<Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'>>(() => {
  const arr: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'> = [
    'hiddenMode', 'favorite', 'inGroup',
    'othersFavorited', 'othersHidden',
    'qualityRange', 'mediaTypes', 'hasGps',
    'dateRange', 'sizeRange',
  ]
  // Group-Highlight toggle only when the album actually has enough of
  // them — otherwise the choice would be either empty or invisible.
  if (groupHighlightAvailable.value) {
    arr.splice(2, 0, 'groupHighlight')
  }
  return arr
})

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

// Server-side filter for VirtualGallery: user's filter + album scope.
// `albumScopeId` (not `albumIds`) tells the grid endpoint this is the
// album-detail view, so it scopes to album membership with an access
// check instead of the caller's own photos — otherwise a non-owner
// viewing a shared album gets an empty grid.
const albumGridFilter = computed<PhotoFilter>(() => ({
  ...filter.value,
  albumScopeId: albumId.value,
}))
const sortByForGallery = computed<GallerySortField>(() => sort.value.field as GallerySortField)
const sortDirForGallery = computed<GallerySortDir>(() => sort.value.direction as GallerySortDir)

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

// ── Jump to newest / oldest (mirrors GalleryView) ────────────────────────────
// "Newest / oldest" only has a meaningful semantic for date sorts.
const isDateSort = computed(
  () => sort.value.field === 'taken_at' || sort.value.field === 'created_at',
)
const scrollEnds = ref({ atStart: true, atEnd: false })
function onGridEndsChanged(ends: { atStart: boolean; atEnd: boolean }) {
  scrollEnds.value = ends
}
const jumpButton = computed(() => {
  if (!isDateSort.value) return null
  const ascending = sort.value.direction === 'asc'
  // Newest sits at the end for asc, at the start for desc; the icon points at
  // the list edge the jump lands on (fast-backward = start, fast-forward = end).
  const atNewest = ascending ? scrollEnds.value.atEnd : scrollEnds.value.atStart
  if (atNewest) {
    return { label: 'Zum ältesten', icon: ascending ? 'pi pi-fast-backward' : 'pi pi-fast-forward', target: 'oldest' as const }
  }
  return { label: 'Zum neuesten', icon: ascending ? 'pi pi-fast-forward' : 'pi pi-fast-backward', target: 'newest' as const }
})
function onJumpEnd() {
  if (!galleryRef.value || !jumpButton.value) return
  const total = galleryRef.value.getTotal()
  if (total === 0) return
  const targetIdx = jumpTargetIndex(jumpButton.value.target, total, sort.value.direction as GallerySortDir)
  galleryRef.value.scrollToIndex(targetIdx, 'start')
  cursorIndex.value = targetIdx
  void hydrateCursor(targetIdx)
}

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

// Curation opinions (fav/hide across album participants) for the photo the
// fullscreen/split cursor currently shows. The cursor photo is hydrated from
// the grid + photo-details batch and doesn't carry this album-only data, so we
// resolve it from album.photos here and feed it to the detail sidebar. Reactive
// so it lights up once the (lazy-loaded) album photo array arrives.
const cursorCurationStats = computed(() => {
  const id = cursorPhoto.value?.id
  if (id == null) return undefined
  return album.value?.photos.find((p) => p.id === id)?.curation_stats
})

// ── Similar-photo groups (stacks) ─────────────────────────────────────────────
// Load all user's groups; filter to those with 2+ members in this album.
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)
// Photo the user had selected before a group review started. Closing the
// review restores it instead of snapping to the first album photo (#374).
const preReviewPhotoId = ref<number | null>(null)

// ── Multi-select (mirrors GalleryView; album-context adds "Aus Album entfernen") ──
const confirm = useConfirm()
const selectMode = ref(false)
const selectedIds = ref<Set<number>>(new Set())
const selectedCount = computed(() => selectedIds.value.size)
const curationBusy = ref(false)
const removeBusy = ref(false)
const deleteBusy = ref(false)
const deleteSkipped = ref<BatchDeleteSkippedPhoto[]>([])
const showDeleteSkippedDialog = ref(false)
const albumDialogVisible = ref(false)
const albumDialogPhotoIds = computed(() => Array.from(selectedIds.value))

function enterSelectMode() {
  selectMode.value = true
  selectedIds.value = new Set()
}
function exitSelectMode() {
  selectMode.value = false
  selectedIds.value = new Set()
}
function clearSelection() {
  selectedIds.value = new Set()
}
function onToggleSelect(entry: GalleryGridEntry) {
  // Replace the Set so reactivity fires (Set internal mutations are not
  // tracked unless the ref reference itself changes).
  const next = new Set(selectedIds.value)
  if (next.has(entry.id)) next.delete(entry.id)
  else next.add(entry.id)
  selectedIds.value = next
}
function openAlbumDialog() {
  if (selectedIds.value.size === 0) return
  albumDialogVisible.value = true
}

async function applyCurationToSelection(target: CurationStatus) {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  curationBusy.value = true
  try {
    for (const id of ids) {
      galleryRef.value?.updateEntry(id, { curation: target })
      try {
        await updatePhotoCuration(id, target)
      } catch {
        await galleryRef.value?.reload()
        break
      }
    }
  } finally {
    curationBusy.value = false
    exitSelectMode()
  }
}

function deleteFromSelection() {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  confirm.require({
    message: `${ids.length} ${ids.length === 1 ? 'Foto' : 'Fotos'} endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    header: 'Fotos löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performBatchDelete(ids),
  })
}

async function performBatchDelete(ids: number[]) {
  deleteBusy.value = true
  try {
    const result = await batchDeletePhotos(ids)
    if (result.skipped.length > 0) {
      deleteSkipped.value = result.skipped
      showDeleteSkippedDialog.value = true
    }
    if (result.deleted.length > 0) {
      await loadData()
      await galleryRef.value?.reload()
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Fehler beim Löschen der Fotos.'
  } finally {
    deleteBusy.value = false
    exitSelectMode()
  }
}

function removeFromAlbumSelection() {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  confirm.require({
    message: `${ids.length} ${ids.length === 1 ? 'Foto' : 'Fotos'} aus diesem Album entfernen? Die Fotos bleiben in der Bibliothek erhalten.`,
    header: 'Aus Album entfernen',
    icon: 'pi pi-info-circle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Entfernen',
    accept: () => void performRemoveFromAlbum(ids),
  })
}

async function performRemoveFromAlbum(ids: number[]) {
  removeBusy.value = true
  try {
    await batchUpdateAlbumPhotos([albumId.value], ids, 'remove')
    await loadData()
    await galleryRef.value?.reload()
  } catch (err: any) {
    error.value = err?.message ?? 'Fehler beim Entfernen aus dem Album.'
  } finally {
    removeBusy.value = false
    exitSelectMode()
  }
}

const albumPhotoIds = computed(() => new Set(rawAlbumPhotos.value.map(p => p.id)))

// Album photos that are still visible (not hidden via curation). A group whose
// members have mostly been hidden is no longer reviewable, so groups are scoped
// to these rather than to every album photo.
const visibleAlbumPhotoIds = computed(
  () => new Set(rawAlbumPhotos.value.filter(p => p.curation_status !== 'hidden').map(p => p.id)),
)

// Groups scoped to this album: only include groups where at least 2 *visible*
// (non-hidden) photos are in the album — once a near-duplicate has been
// deselected there is nothing left to compare. Trim each group's member list to
// the visible album members and choose a visible cover photo.
const albumPhotoGroups = computed<PhotoGroup[]>(() => {
  const result: PhotoGroup[] = []
  for (const g of photoGroupsList.value) {
    const membersInAlbum = g.photo_ids.filter(id => visibleAlbumPhotoIds.value.has(id))
    if (membersInAlbum.length < 2) continue
    const coverInAlbum = g.cover_photo_id && visibleAlbumPhotoIds.value.has(g.cover_photo_id)
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

const unreviewedGroupCount = computed(() =>
  albumPhotoGroups.value.filter(g => !g.reviewed_at).length
)

// Album photos after applying the FilterMenu criteria. Used by the map view
// and filter chip display (not by the VirtualGallery grid).
const groupCoverIds = computed<Set<number>>(() =>
  new Set(
    albumPhotoGroups.value
      .map(g => g.cover_photo_id)
      .filter((id): id is number => id != null),
  ),
)

const groupHighlightAvailable = computed<boolean>(() => {
  const total = rawAlbumPhotos.value.length
  if (total === 0) return false
  return groupCoverIds.value.size / total >= 0.1
})

const albumPhotos = computed<Photo[]>(() => {
  const ctx: PhotoFilterContext = {
    curationStats: curationStatsMap.value,
    groupCoverIds: groupCoverIds.value,
    inGroupIds: new Set(albumPhotoGroups.value.flatMap(g => g.photo_ids)),
  }
  return rawAlbumPhotos.value.filter(p => matchesPhotoFilter(p, filter.value, ctx))
})


// ── Search ────────────────────────────────────────────────────────────────────
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

// Search IDs forwarded to VirtualGallery for search-mode rendering.
const searchPhotoIds = computed<number[] | null>(() => searchResultIds.value)

// Album photos narrowed to the active search hits. Used by the map view.
const albumPhotosFiltered = computed<Photo[]>(() => {
  const ids = searchResultIds.value
  if (ids === null) return albumPhotos.value
  const hitSet = new Set(ids)
  return albumPhotos.value.filter(p => hitSet.has(p.id))
})

// ── Grid cursor hydration (#304) ─────────────────────────────────────────────
function entryToMinimalPhoto(entry: GalleryGridEntry): Photo {
  return {
    id: entry.id,
    user_id: 0,
    filename: entry.filename,
    original_name: entry.filename,
    mime_type: '',
    size: 0,
    created_at: '',
    curation_status: entry.curation,
    auto_crop: entry.auto_crop,
  }
}

async function hydrateCursor(index: number): Promise<void> {
  if (!galleryRef.value) return
  const myToken = ++hydrateToken
  const total = galleryRef.value.getTotal()

  const [curEntry, prevEntry, nextEntry] = await Promise.all([
    galleryRef.value.loadEntryAt(index),
    index > 0 ? galleryRef.value.loadEntryAt(index - 1) : Promise.resolve(null),
    index + 1 < total ? galleryRef.value.loadEntryAt(index + 1) : Promise.resolve(null),
  ])
  if (myToken !== hydrateToken) return
  if (!curEntry) return

  cursorPhoto.value = entryToMinimalPhoto(curEntry)
  cursorPrev.value = prevEntry ? entryToMinimalPhoto(prevEntry) : null
  cursorNext.value = nextEntry ? entryToMinimalPhoto(nextEntry) : null
  cursorGroup.value = curEntry.group ?? null

  photoNav.selectPhotoInAlbum(curEntry.id, albumId.value)

  void loadSidebarData(curEntry.id)

  const ids = [curEntry.id]
  if (prevEntry) ids.push(prevEntry.id)
  if (nextEntry) ids.push(nextEntry.id)
  const myCurationVersion = curationVersion
  try {
    const { photos } = await getPhotoDetailsBatch(ids)
    if (myToken !== hydrateToken) return
    const byId = new Map(photos.map((p) => [p.id, p]))
    const preserveCuration = curationVersion !== myCurationVersion
    const merge = (batch: Photo | undefined, cur: Photo | null): Photo | null => {
      if (!batch) return cur
      if (preserveCuration && cur) return { ...batch, curation_status: cur.curation_status }
      return batch
    }
    cursorPhoto.value = merge(byId.get(curEntry.id), cursorPhoto.value)
    cursorPrev.value = prevEntry ? merge(byId.get(prevEntry.id), cursorPrev.value) : null
    cursorNext.value = nextEntry ? merge(byId.get(nextEntry.id), cursorNext.value) : null
  } catch {
    // keep minimal photos
  }
}

async function openGridFullscreenAt(index: number): Promise<void> {
  cursorIndex.value = index
  isFullscreen.value = true
  await hydrateCursor(index)
  galleryRef.value?.scrollToIndex(index)
}

function closeGridFullscreen() {
  isFullscreen.value = false
  fullscreenDetailsOpen.value = false
}

async function gridGoPrev(): Promise<void> {
  if (cursorIndex.value === null || cursorIndex.value === 0) return
  const next = cursorIndex.value - 1
  cursorIndex.value = next
  await hydrateCursor(next)
  galleryRef.value?.scrollToIndex(next)
}

async function gridGoNext(): Promise<void> {
  if (cursorIndex.value === null || !galleryRef.value) return
  const total = galleryRef.value.getTotal()
  if (cursorIndex.value + 1 >= total) return
  const next = cursorIndex.value + 1
  cursorIndex.value = next
  await hydrateCursor(next)
  galleryRef.value?.scrollToIndex(next)
}

// ── Keyboard navigation (#304) ──────────────────────────────────────────────
function moveCursor(delta: number, byRow: boolean) {
  if (!galleryRef.value) return
  const total = galleryRef.value.getTotal()
  if (total === 0) return
  if (cursorIndex.value === null) {
    cursorIndex.value = 0
    galleryRef.value.scrollToIndex(0, 'auto')
    void hydrateCursor(0)
    return
  }
  const cols = galleryRef.value.getCols()
  const step = byRow ? delta * cols : delta
  let next = cursorIndex.value + step
  if (next < 0) next = 0
  if (next >= total) next = total - 1
  cursorIndex.value = next
  galleryRef.value.scrollToIndex(next, 'auto')
  void hydrateCursor(next)
}

async function activateCursor() {
  if (cursorIndex.value === null || !galleryRef.value) return
  if (selectMode.value) {
    // In select mode Space/Enter toggles selection of the cursor cell
    // instead of opening fullscreen — mirrors GalleryView's behaviour.
    const entry = await galleryRef.value.loadEntryAt(cursorIndex.value)
    if (entry) onToggleSelect(entry)
    return
  }
  await openGridFullscreenAt(cursorIndex.value)
}

useGalleryKeyboard({
  isBlocked: () => !!activeGroup.value || isFullscreen.value,
  onLeft: () => moveCursor(-1, false),
  onRight: () => moveCursor(+1, false),
  onUp: () => moveCursor(-1, true),
  onDown: () => moveCursor(+1, true),
  onSpace: () => { void activateCursor() },
  onExtra(e) {
    if (e.key === 'Enter' && cursorIndex.value !== null) {
      e.preventDefault()
      void activateCursor()
    }
  },
})

// ── Computed ──────────────────────────────────────────────────────────────────
const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const isOwner = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const canManageData = computed(() => auth.hasPermission('data.manage'))
const showPersons = computed(() => auth.hasPermission('people.view'))
// Adding photos from THIS album to OTHER albums is gated server-side on the
// caller owning the source photos OR having `write_share` on a containing
// album (photo.service.ts batchUpdateAlbumPhotosLogic). Mirror that rule so
// the "Alben" select-bar button is hidden for read-only viewers and plain
// contributors who'd just hit a 403.
const canReuseAlbumPhotos = computed(() =>
  isOwner.value || album.value?.my_access_level === 'write_share'
)

// ── Display mode ─────────────────────────────────────────────────────────────
// `album.display_mode` is the album-level setting: 'map' = map enabled,
// 'grid' = map disabled. When map is enabled the user can flip between
// raster and map view on the fly via `viewMode`; otherwise we lock to grid.
const mapEnabled = computed(() => album.value?.display_mode === 'map')
const viewMode = ref<'grid' | 'map'>('grid')
let viewModeInitialized = false

watch(album, (a) => {
  if (!a) return
  if (viewModeInitialized) return
  viewModeInitialized = true
  // Map disabled → always grid. Map enabled → restore the user's last choice
  // for this album, falling back to map view as the curated default.
  viewMode.value = a.display_mode === 'map'
    ? (loadViewModeForAlbum(a.id) ?? 'map')
    : 'grid'
}, { immediate: true })

function toggleViewMode() {
  viewMode.value = viewMode.value === 'map' ? 'grid' : 'map'
}

// Selection only applies to the grid view — leaving grid mode cancels it.
watch(viewMode, (mode) => {
  if (mode !== 'grid' && selectMode.value) exitSelectMode()
  // Persist the choice per album (map-enabled only) so reopening restores it.
  if (mapEnabled.value && album.value) saveViewModeForAlbum(album.value.id, mode)
})

// ── Map fullscreen ───────────────────────────────────────────────────────────
const tripMapRef = ref<{
  selectStopByPhotoId: (id: number) => boolean
  openFullscreenByPhotoId: (id: number) => boolean
} | null>(null)
const mapFullscreenPhotos = ref<Photo[]>([])
const mapFullscreenIndex = ref(0)
const isMapFullscreen = ref(false)

// When navigating to this album via ?photoId= (or restoring a stored selection)
// in map mode, we need to select the stop for that photo once TripMap mounts.
// watchEffect re-runs whenever either tripMapRef or pendingMapSelectPhotoId
// changes, covering both "TripMap mounts after photo is resolved" and the
// rarer case where the photo id is resolved after TripMap is already mounted.
const pendingMapSelectPhotoId = ref<number | null>(null)
// Same mechanism, but for notification deep-links: instead of only
// selecting the stop, open the photo directly in the map fullscreen.
const pendingMapFullscreenPhotoId = ref<number | null>(null)

watchEffect(() => {
  const mapRef = tripMapRef.value
  const photoId = pendingMapSelectPhotoId.value
  if (mapRef && photoId !== null) {
    mapRef.selectStopByPhotoId(photoId)
    pendingMapSelectPhotoId.value = null
  }
})

watchEffect(() => {
  const mapRef = tripMapRef.value
  const photoId = pendingMapFullscreenPhotoId.value
  if (mapRef && photoId !== null) {
    mapRef.openFullscreenByPhotoId(photoId)
    pendingMapFullscreenPhotoId.value = null
  }
})

function handleMapFullscreen(photos: Photo[], startIndex: number, _day: string) {
  // TripMap hands us the whole trip's photos in chronological order so the
  // overlay (paging and the idle slideshow) runs continuously across day and
  // stop boundaries. On close we sync the map's selected stop to the photo
  // the user ended on (see closeMapFullscreen).
  mapFullscreenPhotos.value = photos
  mapFullscreenIndex.value = Math.max(0, Math.min(startIndex, photos.length - 1))
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
  // Remember the photo the user ended on so switching to gallery view scrolls
  // there via galleryAnchorPhotoId and the shared nav store.
  if (ended) {
    galleryAnchorPhotoId.value = ended.id
    photoNav.selectPhotoInAlbum(ended.id, albumId.value)
  }
  isMapFullscreen.value = false
}

// Called when the user actively selects a stop in the map (click or keyboard).
// Sets galleryAnchorPhotoId so VirtualGallery loads around the right photo on
// the next map → grid switch.
function handleMapStopSelected(coverPhotoId: number) {
  galleryAnchorPhotoId.value = coverPhotoId
  photoNav.selectPhotoInAlbum(coverPhotoId, albumId.value)
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
const detectedPoiMatches = ref<PoiMatchItem[]>([])
const loadingPoiMatches = ref(false)
const reindexingPhoto = ref(false)
const { persons, fetchPersons, invalidateAlbums } = useReferenceData()

// The sidebar (including the fullscreen details flyout) follows either
// the grid selection or, when the map fullscreen is open, the photo
// currently shown in the map overlay. Watch the effective photo so
// faces/landmarks reflect what the user actually sees.
const activeDetailPhoto = computed(() =>
  isMapFullscreen.value ? mapSelectedPhoto.value : cursorPhoto.value
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


// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  loading.value = true
  try {
    // Metadata only — the grid renders from this (album id + settings) without
    // waiting on the full per-photo payload. The photos array (used by stacks,
    // the map view and the curation-stats overlay) is hydrated in the
    // background by hydrateAlbumPhotos() once the view is interactive.
    const [albumRes, groupsRes] = await Promise.all([
      getAlbum(albumId.value, /* includePhotos */ false),
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
        const reloaded = await getAlbum(albumId.value, /* includePhotos */ false)
        album.value = reloaded
      } catch { /* ignore – filter still narrows the returned set */ }
    }

    // Kick off the (potentially large) photo-array hydration without blocking
    // the loading state: the grid is already usable, and stacks / map / filter
    // context light up as soon as it resolves.
    void hydrateAlbumPhotos()

    // Resolve the anchor photo. Priority: deep-link `photoId` (opens fullscreen,
    // e.g. a notification) → the shared "last focused photo" (photoNav, the
    // single source of truth). Opening a photo from the feed sets photoNav, so
    // it is focused here too.
    const queryPhotoId = Number(route.query.photoId) || null
    const storedPhotoId = queryPhotoId
      ?? photoNav.selectedPhotoId
      ?? null
    if (albumRes.display_mode === 'map') {
      if (queryPhotoId) {
        // Notification deep-link: open the photo straight in the map
        // fullscreen rather than only selecting its stop.
        router.replace({ query: { ...route.query, photoId: undefined } })
        pendingMapFullscreenPhotoId.value = queryPhotoId
      } else if (storedPhotoId) {
        pendingMapSelectPhotoId.value = storedPhotoId
      }
    } else {
      // Grid mode: tell VirtualGallery which photo to center on when it mounts.
      galleryAnchorPhotoId.value = storedPhotoId
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Albums'
  } finally {
    loading.value = false
  }
}

// Background hydration of the album's photo array (split from getAlbum so the
// grid can paint from metadata first). Merges the photos into the already-set
// album object; guarded so a stale response for a previous album is dropped.
async function hydrateAlbumPhotos() {
  const targetId = albumId.value
  try {
    const { photos } = await getAlbumPhotos(targetId)
    if (album.value && album.value.id === targetId) {
      album.value = { ...album.value, photos }
    }
  } catch { /* grid stays usable; stacks/map just won't populate */ }
}

async function loadPersons() {
  try { await fetchPersons() } catch { /* ignore */ }
}

// Lightweight refresh of the group list and album photos (incl. fresh quality
// scores) without the full-screen loading state or the scroll-anchor reset that
// loadData() does. Used when a grid stack badge is tapped before the
// post-upload scans (grouping, quality) have streamed back into our cached
// data — so the first tap works and the compare opens with real scores.
async function refreshGroupsAndPhotos() {
  try {
    const [albumRes, groupsRes] = await Promise.all([
      getAlbum(albumId.value),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    album.value = albumRes
    photoGroupsList.value = groupsRes.groups
  } catch { /* keep current data on failure */ }
}

async function loadSidebarData(photoId: number) {
  loadingFaces.value = true
  loadingLandmarks.value = true
  loadingPoiMatches.value = true
  try {
    // POI matches load alongside faces + landmarks. Each call falls back to
    // an empty result on error (e.g. osm-admin down) so the rest of the
    // sidebar still renders. Previously POIs weren't loaded here at all, so
    // they never showed in the album detail / split-screen sidebar.
    const [facesRes, landmarksRes, poisRes] = await Promise.all([
      getPhotoFaces(photoId).catch(() => ({ faces: [] })),
      getPhotoLandmarks(photoId).catch(() => ({ landmarks: [] })),
      getPhotoPoiMatches(photoId).catch(() => ({ matches: [] })),
    ])
    detectedFaces.value = facesRes.faces ?? []
    detectedLandmarks.value = landmarksRes.landmarks ?? []
    detectedPoiMatches.value = poisRes.matches ?? []
  } catch {
    detectedFaces.value = []
    detectedLandmarks.value = []
    detectedPoiMatches.value = []
  } finally {
    loadingFaces.value = false
    loadingLandmarks.value = false
    loadingPoiMatches.value = false
  }
}

// ── Curation ──────────────────────────────────────────────────────────────────
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

async function applyCurationToAlbumPhoto(id: number, target: CurationStatus): Promise<void> {
  ++curationVersion
  updatePhotoStatus(id, target)
  galleryRef.value?.updateEntry(id, { curation: target })
  for (const r of [cursorPhoto, cursorPrev, cursorNext]) {
    if (r.value && r.value.id === id) {
      r.value = { ...r.value, curation_status: target }
    }
  }
  // Map-mode fullscreen holds its own array snapshot. Mutating a
  // property on the shared photo object doesn't reliably re-trigger the
  // FullscreenOverlay's reactive bindings after the first toggle, so
  // explicitly replace the entry with a fresh object — same pattern as
  // the cursor refs above.
  const mfIdx = mapFullscreenPhotos.value.findIndex(p => p.id === id)
  if (mfIdx >= 0) {
    const next = mapFullscreenPhotos.value.slice()
    next[mfIdx] = { ...next[mfIdx]!, curation_status: target }
    mapFullscreenPhotos.value = next
  }
  try {
    await updatePhotoCuration(id, target)
  } catch (err: any) {
    await galleryRef.value?.reload()
    if (cursorIndex.value !== null) await hydrateCursor(cursorIndex.value)
    error.value = err.message || 'Fehler'
  }
}

function handleHidePhoto(id: number) {
  void applyCurationToAlbumPhoto(id, 'hidden')
}

function handleRestorePhoto(id: number) {
  void applyCurationToAlbumPhoto(id, 'visible')
}

function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  void applyCurationToAlbumPhoto(id, currentStatus === 'favorite' ? 'visible' : 'favorite')
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
  const photo = mapSelectedPhoto.value || cursorPhoto.value
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
    // Wall-clock string: see toLocalIsoDateTime comment and issue #433.
    const takenAt = toLocalIsoDateTime(editDate.value)
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
  if (!cursorPhoto.value) return
  reindexingPhoto.value = true
  try { await reindexPhoto(cursorPhoto.value.id); await loadSidebarData(cursorPhoto.value.id) }
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

// ── Album settings (rename + map mode) ───────────────────────────────────────
const showAlbumSettingsDialog = ref(false)
const albumSettingsName = ref('')
const albumSettingsDesc = ref('')
const albumSettingsMapEnabled = ref(false)
const albumSettingsUpdating = ref(false)

function openAlbumSettingsDialog() {
  if (!album.value) return
  albumSettingsName.value = album.value.name
  albumSettingsDesc.value = album.value.description || ''
  albumSettingsMapEnabled.value = album.value.display_mode === 'map'
  showAlbumSettingsDialog.value = true
}

async function handleSaveAlbumSettings() {
  if (!album.value) return
  const newName = albumSettingsName.value.trim()
  if (!newName) return
  albumSettingsUpdating.value = true
  try {
    await updateAlbum(albumId.value, {
      name: newName,
      description: albumSettingsDesc.value.trim(),
      displayMode: albumSettingsMapEnabled.value ? 'map' : 'grid',
    })
    invalidateAlbums()
    album.value.name = newName
    album.value.description = albumSettingsDesc.value.trim()
    album.value.display_mode = albumSettingsMapEnabled.value ? 'map' : 'grid'
    showAlbumSettingsDialog.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern'
  } finally {
    albumSettingsUpdating.value = false
  }
}

// ── Album sharing ─────────────────────────────────────────────────────────────
const canShareAlbum = computed(() => {
  if (!album.value) return false
  if (isOwner.value) return true
  return album.value.my_access_level === 'write_share'
})

const showShareDialog = ref(false)
const albumSharesList = ref<AlbumShareWithUser[]>([])
const allShareUsers = ref<ShareableUser[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<AlbumAccessLevel>('read')
const sharing = ref(false)
const loadingShares = ref(false)
const publicLink = ref<AlbumPublicLink | null>(null)
const linkCopied = ref(false)
const linkExpiry = ref<string | null>(null)
const expiryOptions = [
  { label: 'Unbegrenzt', value: null },
  { label: '7 Tage', value: '7d' },
  { label: '30 Tage', value: '30d' },
  { label: '90 Tage', value: '90d' },
]
const OWNER_ACCESS_LEVELS: Array<{ label: string; value: AlbumAccessLevel }> = [
  { label: 'Nur lesen', value: 'read' },
  { label: 'Bearbeiten', value: 'write' },
  { label: 'Bearbeiten + Teilen', value: 'write_share' },
]
const DELEGATE_ACCESS_LEVELS: Array<{ label: string; value: AlbumAccessLevel }> =
  OWNER_ACCESS_LEVELS.filter(o => o.value !== 'write_share')

const shareAccessLevelOptions = computed(() =>
  isOwner.value ? OWNER_ACCESS_LEVELS : DELEGATE_ACCESS_LEVELS
)

const shareOwnerId = ref<number>(0)
function canRemoveShare(share: AlbumShareWithUser) {
  if (isOwner.value) return true
  return share.invited_by_user_id === auth.user?.id
}

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumSharesList.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  return allShareUsers.value.filter(u =>
    u.id !== currentUserId && u.id !== shareOwnerId.value && !sharedIds.has(u.id)
  )
})

async function openShareDialogLocal() {
  if (!album.value) return
  shareOwnerId.value = album.value.user_id
  showShareDialog.value = true
  loadingShares.value = true
  try {
    const [sharesRes, usersRes] = await Promise.all([
      getAlbumShares(albumId.value),
      getAlbumShareableUsers(albumId.value),
    ])
    albumSharesList.value = sharesRes.shares
    publicLink.value = sharesRes.publicLink ?? null
    allShareUsers.value = usersRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Freigaben'
  } finally {
    loadingShares.value = false
  }
}

function syncAlbumSharedStatus() {
  if (!album.value) return
  album.value.is_shared = albumSharesList.value.length > 0
}

async function handleShareAlbum() {
  if (!shareUserId.value) return
  sharing.value = true
  try {
    await shareAlbum(albumId.value, shareUserId.value, shareAccessLevel.value)
    albumSharesList.value = (await getAlbumShares(albumId.value)).shares
    syncAlbumSharedStatus()
    shareUserId.value = null
    shareAccessLevel.value = 'read'
  } catch (err: any) { error.value = err.message || 'Fehler beim Freigeben' }
  finally { sharing.value = false }
}

async function handleRemoveShare(userId: number) {
  try {
    await removeAlbumShare(albumId.value, userId)
    albumSharesList.value = albumSharesList.value.filter(s => s.user_id !== userId)
    syncAlbumSharedStatus()
  } catch (err: any) { error.value = err.message || 'Fehler' }
}

function getPublicLinkUrl() {
  if (!publicLink.value) return ''
  return `${window.location.origin}${import.meta.env.BASE_URL}albums/shared/${publicLink.value.token}`
}

async function handleCreatePublicLink() {
  try {
    publicLink.value = await createAlbumPublicLink(albumId.value, (linkExpiry.value as PublicLinkExpiry) ?? undefined)
    await copyPublicLink()
  } catch (err: any) { error.value = err.message || 'Fehler beim Erstellen des Links' }
}

async function handleDeletePublicLink() {
  try {
    await deleteAlbumPublicLink(albumId.value)
    publicLink.value = null
    linkCopied.value = false
  } catch (err: any) { error.value = err.message || 'Fehler beim Löschen des Links' }
}

async function copyPublicLink() {
  try {
    await navigator.clipboard.writeText(getPublicLinkUrl())
    linkCopied.value = true
    setTimeout(() => { linkCopied.value = false }, 2000)
  } catch { /* clipboard not available */ }
}

function formatShareExpiryDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (date < new Date()) return 'Abgelaufen'
  return `Gültig bis ${date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}`
}

const isLinkExpired = computed(() => {
  if (!publicLink.value?.expires_at) return false
  return new Date(publicLink.value.expires_at) < new Date()
})

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

function openDeleteFromSettings() {
  showAlbumSettingsDialog.value = false
  showDeleteDialog.value = true
}

// ── Photo upload (mirrors GalleryView; uploaded photos join this album) ───────
const uploading = ref(false)
const uploadAbortController = ref<AbortController | null>(null)
const uploadCurrent = ref(0)
const uploadTotal = ref(0)
const uploadProgress = ref(0)
const uploadAddedCount = ref(0)
const uploadResultMessage = ref('')
const uploadErrors = ref<string[]>([])
const showErrorFlyout = ref(false)
const isDragging = ref(false)
let dragCounter = 0
let uploadResultTimeout: ReturnType<typeof setTimeout> | undefined

// Upload requires the global photos.upload permission AND write access to this
// album — the same rule the backend enforces in addPhotoToAlbumLogic.
const canUpload = computed(() => canUploadPhotos.value && canWrite.value)

let wakeLock: WakeLockSentinel | null = null
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return
  try {
    wakeLock = await (navigator as any).wakeLock.request('screen')
  } catch {
    // Permission denied or not available — upload continues without it.
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {})
  wakeLock = null
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!uploading.value) return
  e.preventDefault()
  return ''
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))

// Re-init the album grid centred on the just-added photo and move the cursor
// focus to it, so each upload becomes visible and the view ends on the most
// recently uploaded photo. No-op in map mode (the grid isn't mounted there).
async function refreshAlbumGridFocused(photoId: number) {
  if (!galleryRef.value) return
  await galleryRef.value.reload({ aroundPhotoId: photoId })
  const idx = galleryRef.value.findLoadedIndexById(photoId)
  if (idx !== null) selectGridIndex(idx)
}

async function handleUpload(filesIn: FileList | File[]) {
  if (!canUpload.value || !album.value) return
  const files = Array.from(filesIn)
  if (!files.length) return

  const abort = new AbortController()
  uploadAbortController.value = abort
  uploading.value = true
  error.value = ''
  uploadCurrent.value = 0
  uploadTotal.value = files.length
  uploadProgress.value = 0
  uploadAddedCount.value = 0
  uploadResultMessage.value = ''
  uploadErrors.value = []
  if (uploadResultTimeout) {
    clearTimeout(uploadResultTimeout)
    uploadResultTimeout = undefined
  }

  await acquireWakeLock()

  const targetAlbumId = albumId.value
  const duplicates: string[] = []
  const unsupported: string[] = []
  const errors: string[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      if (abort.signal.aborted) break
      const file = files[i]!
      uploadCurrent.value = i + 1
      try {
        // Local SHA-256 + server check skips re-uploading bytes that already
        // exist in the library — but the photo still needs to join this album.
        const fileHash = await computeFileHash(file)
        if (fileHash && !abort.signal.aborted) {
          try {
            const { exists, photoId } = await checkPhotoHash(fileHash)
            if (exists) {
              if (photoId) {
                await addPhotoToAlbum(targetAlbumId, photoId)
                uploadAddedCount.value++
                await refreshAlbumGridFocused(photoId)
              } else {
                duplicates.push(file.name)
              }
              uploadProgress.value = Math.round(((i + 1) / files.length) * 100)
              continue
            }
          } catch {
            // Pre-check failure is non-fatal — fall through to actual upload.
          }
        }
        const photo = await uploadPhotoWithProgress(file, abort.signal, (loaded, total) => {
          const filePct = loaded / total
          uploadProgress.value = Math.round(((i + filePct) / files.length) * 100)
        })
        await addPhotoToAlbum(targetAlbumId, photo.id)
        uploadAddedCount.value++
        await refreshAlbumGridFocused(photo.id)
      } catch (err: any) {
        if (abort.signal.aborted) break
        if (err.message?.includes('bereits hochgeladen')) duplicates.push(file.name)
        else if (err.message?.includes('nicht unterstützt')) unsupported.push(file.name)
        else errors.push(`${file.name}: ${err.message}`)
      }
    }

    // The grid was refreshed per photo; just reconcile album metadata
    // (photo count, date range) and the cached albums list.
    await loadData()
    invalidateAlbums()

    if (abort.signal.aborted) {
      error.value = 'Hochladen wurde abgebrochen.'
    } else if (duplicates.length || unsupported.length || errors.length) {
      const all: string[] = [
        ...duplicates.map((f) => `Bereits vorhanden: ${f}`),
        ...unsupported.map((f) => `Nicht unterstützt: ${f}`),
        ...errors.map((e) => `Fehler: ${e}`),
      ]
      if (all.length > 3) {
        uploadErrors.value = all
        error.value = `${all.length} Dateien konnten nicht hochgeladen werden.`
      } else {
        error.value = all.join(' ')
      }
    }
    const count = uploadAddedCount.value
    if (count > 0 && !abort.signal.aborted) {
      uploadResultMessage.value =
        count === 1 ? '1 Foto zum Album hinzugefügt' : `${count} Fotos zum Album hinzugefügt`
      uploadResultTimeout = setTimeout(() => {
        uploadResultMessage.value = ''
      }, 8000)
    }
  } finally {
    uploading.value = false
    uploadAbortController.value = null
    releaseWakeLock()
  }
}

function cancelUpload() {
  uploadAbortController.value?.abort()
}

function onFileInputChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    void handleUpload(input.files)
    // Reset so the same file can be picked again.
    input.value = ''
  }
}

function onDragEnter(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  dragCounter++
  isDragging.value = true
}
function onDragLeave(e: DragEvent) {
  if (!canUpload.value) return
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragging.value = false
  }
}
function onDragOver(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDrop(e: DragEvent) {
  if (!canUpload.value || uploading.value) return
  e.preventDefault()
  isDragging.value = false
  dragCounter = 0
  const files = e.dataTransfer?.files
  if (files && files.length > 0) void handleUpload(files)
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

// ── Grid interaction (#304) ──────────────────────────────────────────────────
function handleGridPhotoClick(entry: GalleryGridEntry) {
  if (!galleryRef.value) return
  const idx = galleryRef.value.findLoadedIndexById(entry.id)
  if (idx === null) return
  cursorIndex.value = idx
  void hydrateCursor(idx)
  if (window.innerWidth <= 768) void openGridFullscreenAt(idx)
}

async function handleGridStackClick(entry: GalleryGridEntry) {
  if (!entry.group) return
  let found = photoGroupsList.value.find((g) => g.id === entry.group!.id) ?? null
  if (!found) {
    // The badge can appear (the backend already grouped the upload) before our
    // cached group list caught up — without this the first tap was a silent
    // no-op until the album was re-entered. Refresh once (also picks up fresh
    // quality scores so the compare shows real %, not "?%"), then retry.
    await refreshGroupsAndPhotos()
    found = photoGroupsList.value.find((g) => g.id === entry.group!.id) ?? null
  }
  if (!found) return
  preReviewPhotoId.value = cursorPhoto.value?.id ?? null
  activeGroup.value = found
}

/** Opening the review from the fullscreen `+N` badge (Track-I) — mirrors
 *  GalleryView's flow, but anchors the post-review restore on the
 *  fullscreen photo so closing the review puts the user back where they
 *  came from (#374). */
async function onFullscreenOpenGroupReview() {
  const g = cursorGroup.value
  if (!g) return
  let found = photoGroupsList.value.find((row) => row.id === g.id) ?? null
  if (!found) {
    // Same staleness guard as handleGridStackClick (post-upload race).
    await refreshGroupsAndPhotos()
    found = photoGroupsList.value.find((row) => row.id === g.id) ?? null
  }
  if (!found) return
  preReviewPhotoId.value = cursorPhoto.value?.id ?? null
  closeGridFullscreen()
  activeGroup.value = found
}

async function onGalleryLoaded() {
  if (!galleryRef.value) return
  // galleryAnchorPhotoId was set before this mount (initial load or map→grid
  // switch). VirtualGallery already loaded entries around it; findLoadedIndexById
  // will find it. Consume the anchor so subsequent reloads don't re-apply it.
  const anchor = galleryAnchorPhotoId.value
  galleryAnchorPhotoId.value = null
  // A `photoId` query parameter is only ever set by a push-notification
  // deep-link. When present, open that photo straight in fullscreen
  // (e.g. a comment notification) instead of merely centering it.
  const deepLinkPhotoId = Number(route.query.photoId) || null
  const targetId = anchor
    || deepLinkPhotoId
    || photoNav.selectedPhotoId
    || null
  if (route.query.photoId) {
    router.replace({ query: { ...route.query, photoId: undefined } })
  }
  if (!targetId) {
    // No remembered photo for this album — default to the newest one in the
    // current list instead of leaving nothing selected.
    selectGridIndex(newestGridIndex())
    return
  }
  let idx = galleryRef.value.findLoadedIndexById(targetId)
  if (idx === null) {
    // The target wasn't in the initial window. The `around-photo-id` prop
    // can race the gallery's mount, so the first load sometimes centres on
    // the newest page instead of the stored photo — which left the user on
    // the wrong page with blank leading cells. Re-anchor on the target so we
    // can scroll to it and its neighbours load.
    await galleryRef.value.reload({ aroundPhotoId: targetId })
    idx = galleryRef.value.findLoadedIndexById(targetId)
  }
  if (idx === null) {
    // The shared "last focused photo" isn't part of this album (e.g. it was
    // focused in another album/the gallery). Fall back to the newest photo so
    // the grid always lands on a sensible selection rather than nothing.
    selectGridIndex(newestGridIndex())
    return
  }
  if (deepLinkPhotoId && targetId === deepLinkPhotoId) {
    void openGridFullscreenAt(idx)
  } else {
    void selectGridIndex(idx)
  }
}

async function selectGridIndex(idx: number) {
  cursorIndex.value = idx
  // Hydrate first, then scroll. On a fresh album mount the virtualizer hasn't
  // measured its scroll element yet, so scrolling right after the gallery's
  // 'loaded' emit silently no-ops — the photo gets the cursor but isn't
  // scrolled into view (the regression when jumping from the gallery into an
  // album that contains the photo). Awaiting the hydrate gives the virtualizer
  // the frames it needs before we scroll — same fix as GalleryView.
  await hydrateCursor(idx)
  galleryRef.value?.scrollToIndex(idx)
}

function selectAfterGroup(group: PhotoGroup | null) {
  if (!galleryRef.value) return
  // Focus a photo that is still in the grid after the review hid the rejected
  // ones. Anchoring on a now-hidden photo made the grid briefly land on it and
  // then snap to the first album image once the hidden ones were removed.
  const anchorId = postReviewAnchorId(group)
  preReviewPhotoId.value = null
  if (anchorId !== null) {
    const idx = galleryRef.value.findLoadedIndexById(anchorId)
    if (idx !== null) {
      selectGridIndex(idx)
      return
    }
  }
  // Nothing from the group survived — fall back to the newest photo in the
  // current list (not the oldest, which index 0 is in the default asc sort).
  selectGridIndex(newestGridIndex())
}

/** Grid index of the newest photo in the current sort. */
function newestGridIndex(): number {
  const total = galleryRef.value?.getTotal() ?? 0
  return newestIndex(total, sortDirForGallery.value)
}

// True when `id` is still present in the (filter-aware) album photo list — i.e.
// it survived the review and is safe to focus.
function isAlbumPhotoVisible(id: number | null | undefined): boolean {
  if (id == null) return false
  if (albumPhotos.value.some((p) => p.id === id)) return true
  // album.photos is loaded lazily (#561) and can be empty right after
  // loadData(); the grid is the authoritative "currently shown" source, so a
  // post-review anchor isn't dropped just because the photo array hasn't
  // hydrated yet (which previously snapped the grid to the oldest photo).
  return galleryRef.value?.findLoadedIndexById(id) != null
}

// Pick a still-visible photo to focus after a review. Preference order:
// the user's pre-review photo if it wasn't hidden, then the group's kept AI
// pick, then any surviving group member, then its cover. Returns null when
// nothing from the group survived so callers fall back to the first photo.
function postReviewAnchorId(group: PhotoGroup | null): number | null {
  if (isAlbumPhotoVisible(preReviewPhotoId.value)) return preReviewPhotoId.value
  for (const id of group?.ai_picked_photo_ids ?? []) {
    if (isAlbumPhotoVisible(id)) return id
  }
  for (const id of group?.photo_ids ?? []) {
    if (isAlbumPhotoVisible(id)) return id
  }
  if (isAlbumPhotoVisible(group?.cover_photo_id ?? null)) return group!.cover_photo_id!
  return null
}

async function handleGroupClose() {
  const group = activeGroup.value
  activeGroup.value = null
  await loadData()
  // Reload the grid centred on a still-visible photo so the just-hidden ones
  // being removed can't leave the anchor pointing at nothing (which snapped
  // the grid to the first image).
  const anchorId = postReviewAnchorId(group)
  await galleryRef.value?.reload(anchorId !== null ? { aroundPhotoId: anchorId } : undefined)
  selectAfterGroup(group)
}

/**
 * Fired by PhotoCompareView after the server accepted the review (the
 * "Fertig" / "KI-Pick übernehmen" actions), BEFORE the `close` that tears
 * the overlay down. Mirrors GalleryView.applyLocalGroupReviewed: flip the
 * badge off immediately on every loaded cell of the group and in the local
 * group cache, so it disappears at once instead of lingering until the
 * post-close reload streams back (or, when an overlapping group exists,
 * never clearing visually at all). `close` still runs its reload to pick
 * up the per-photo curation changes from the review.
 *
 * Only fires on an actual review — dismissing via X / Esc emits `close`
 * alone, leaving the group unreviewed both server- and client-side.
 */
function handleGroupReviewed() {
  const reviewedGroupId = activeGroup.value?.id
  if (reviewedGroupId === undefined) return
  photoGroupsList.value = photoGroupsList.value.map((g) =>
    g.id === reviewedGroupId
      ? { ...g, reviewed_at: g.reviewed_at ?? new Date().toISOString() }
      : g,
  )
  galleryRef.value?.markGroupReviewed(reviewedGroupId)
}

async function handleGroupNext(reviewedGroupId: number) {
  // Review-and-next emits `next` (not `reviewed`), so flip the just-
  // reviewed group's badge off here before the reload — same optimistic
  // update as handleGroupReviewed.
  galleryRef.value?.markGroupReviewed(reviewedGroupId)
  const candidateId = albumPhotoGroups.value.find(g => !g.reviewed_at && g.id !== reviewedGroupId)?.id
  await loadData()
  // Anchor on a still-visible photo of the just-reviewed group (see
  // handleGroupClose); harmless when we immediately open the next group.
  const anchorId = postReviewAnchorId(activeGroup.value)
  await galleryRef.value?.reload(anchorId !== null ? { aroundPhotoId: anchorId } : undefined)
  if (candidateId !== undefined) {
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
  if (first) {
    preReviewPhotoId.value = cursorPhoto.value?.id ?? null
    activeGroup.value = first
  }
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
  if (!effectiveCoverPhotoId.value || !galleryRef.value) return
  const idx = galleryRef.value.findLoadedIndexById(effectiveCoverPhotoId.value)
  if (idx !== null) {
    cursorIndex.value = idx
    galleryRef.value.scrollToIndex(idx)
    void hydrateCursor(idx)
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
  viewModeInitialized = false
  cursorIndex.value = null
  cursorPhoto.value = null
  cursorPrev.value = null
  cursorNext.value = null
  cursorGroup.value = null
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
  const status = ev.payload.status as CurationStatus | undefined
  if (status) {
    galleryRef.value?.updateEntry(photoId, { curation: status })
    for (const r of [cursorPhoto, cursorPrev, cursorNext]) {
      if (r.value && r.value.id === photoId) {
        r.value = { ...r.value, curation_status: status }
      }
    }
  }
  void loadData()
})

// "Has comments" thumbnail badge — kept live. Comments are album-scoped, so
// every update funnels through bumpCommentCount(photoId, delta):
//   - The local user's own add/remove arrives via PhotoReactions
//     (onCommentCountChange) — the realtime fan-out excludes the actor.
//   - Other participants' add/remove arrive via the realtime events below.
// These two sources never overlap, so the count can't be double-applied.
function onCommentCountChange(payload: { photoId: number; delta: number }) {
  galleryRef.value?.bumpCommentCount(payload.photoId, payload.delta)
}

useRealtimeEvent('photos', 'commented', (ev) => {
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  if (Number(ev.payload?.albumId) !== albumId.value) return
  galleryRef.value?.bumpCommentCount(photoId, 1)
})

useRealtimeEvent('photos', 'comment_deleted', (ev) => {
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  if (Number(ev.payload?.albumId) !== albumId.value) return
  galleryRef.value?.bumpCommentCount(photoId, -1)
})

// New similar-photo groups and quality scores are produced asynchronously
// after upload. The backend emits `photos/scan.updated` once those scans
// settle; refresh the cached group list + album photos (so review badges
// become tappable and "?%" quality fills in) and re-anchor the grid so new
// badges appear — all without the user having to leave and re-enter the
// album. Debounced because a bulk upload settles in bursts.
let scanRefreshTimer: ReturnType<typeof setTimeout> | null = null
useRealtimeEvent('photos', 'scan.updated', () => {
  if (scanRefreshTimer) return
  scanRefreshTimer = setTimeout(() => {
    scanRefreshTimer = null
    void (async () => {
      await refreshGroupsAndPhotos()
      // Surface freshly-grouped photos' badges in the grid, anchored on the
      // current position so the view doesn't jump. Skip while a review or
      // fullscreen overlay is open to avoid disturbing it.
      if (viewMode.value === 'grid' && !activeGroup.value && !isFullscreen.value && !isMapFullscreen.value) {
        const anchor = cursorPhoto.value?.id ?? galleryAnchorPhotoId.value ?? undefined
        await galleryRef.value?.reload(anchor != null ? { aroundPhotoId: anchor } : undefined)
      }
    })()
  }, 1000)
})
onUnmounted(() => { if (scanRefreshTimer) clearTimeout(scanRefreshTimer) })
</script>

<template>
  <div
    class="album-detail-view"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Drag overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-message">
        <i class="pi pi-upload" />
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>

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
            :aria-label="cameFromFeed ? 'Zurück zum Feed' : 'Zurück zur Albumübersicht'"
            v-tooltip="cameFromFeed ? 'Zurück zum Feed' : 'Zurück zur Albumübersicht'"
            @click="navigateBackToAlbums"
          />
          <h1 class="header__title">{{ album.name }}</h1>
          <span :class="['header__badge', `header__badge--${album.role}`]">{{ album.role }}</span>
        </div>

        <!-- 2. Metadata -->
        <div class="header__meta">
          {{ album.photo_count }}<span class="header__meta-unit">&nbsp;{{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}</span>
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            &bull; {{ headerDateRange }}
          </template>
        </div>

        <!-- 5. Filter -->
        <div class="header__filter">
          <Button
            v-if="viewMode !== 'map'"
            :icon="selectMode ? 'pi pi-times' : 'pi pi-check-square'"
            :label="selectMode ? 'Auswahl beenden' : 'Auswählen'"
            size="small"
            :severity="selectMode ? 'danger' : 'secondary'"
            :outlined="!selectMode"
            class="header__filter-btn"
            @click="selectMode ? exitSelectMode() : enterSelectMode()"
          />
          <Button
            :icon="activeCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
            :label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
            size="small"
            :severity="activeCount > 0 ? 'primary' : 'secondary'"
            :outlined="activeCount === 0"
            class="header__filter-btn"
            @click="openFilterMenu"
          />
          <Button
            icon="pi pi-sort-alt"
            :label="isSortDefault ? 'Sortierung' : `Sortierung: ${sortFieldLabel}`"
            size="small"
            :severity="isSortDefault ? 'secondary' : 'primary'"
            :outlined="isSortDefault"
            class="header__filter-btn"
            @click="openSortMenu"
          />
          <Button
            v-if="jumpButton && viewMode !== 'map'"
            :icon="jumpButton.icon"
            :label="jumpButton.label"
            size="small"
            severity="secondary"
            outlined
            class="header__filter-btn"
            @click="onJumpEnd"
          />
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

        <!-- 6. Action buttons -->
        <div class="header__actions">
          <Button
            v-if="canManageData && unreviewedGroupCount > 0 && viewMode !== 'map'"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images" severity="success" size="small"
            class="header__group-review-btn"
            v-tooltip.bottom="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            @click="handleStartGroupReview"
          />
          <Button
            v-if="mapEnabled"
            :icon="viewMode === 'map' ? 'pi pi-th-large' : 'pi pi-map'"
            size="small"
            text
            class="view-mode-switch"
            :aria-label="viewMode === 'map' ? 'Rasteransicht anzeigen' : 'Kartenansicht anzeigen'"
            v-tooltip.bottom="viewMode === 'map' ? 'Rasteransicht anzeigen' : 'Kartenansicht anzeigen'"
            @click="toggleViewMode"
          />
          <Button v-if="effectiveCoverPhotoId && viewMode !== 'map'" icon="pi pi-image" size="small" text v-tooltip="'Cover fokussieren'" @click="scrollToCover" />
          <Button v-if="canShareAlbum" icon="pi pi-share-alt" size="small" text v-tooltip="'Freigeben'" @click="openShareDialogLocal" />
          <Button v-if="canWrite" icon="pi pi-cog" size="small" text v-tooltip="'Album-Einstellungen'" @click="openAlbumSettingsDialog" />
          <template v-if="canUpload">
            <Button
              v-if="uploading"
              label="Abbrechen"
              icon="pi pi-times"
              size="small"
              severity="danger"
              class="header__upload-btn"
              v-tooltip="'Hochladen abbrechen'"
              @click="cancelUpload"
            />
            <label v-else class="header__upload-btn upload-button-label" v-tooltip="'Fotos hochladen'">
              <input
                type="file"
                accept="image/*"
                multiple
                class="upload-input-hidden"
                @change="onFileInputChange"
              />
              <Button label="Hochladen" icon="pi pi-upload" size="small" as="span" />
            </label>
          </template>
          <Button v-if="!isOwner" icon="pi pi-sign-out" size="small" text severity="danger" v-tooltip="'Freigabe verlassen'" @click="showLeaveDialog = true" />
        </div>
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

    <Message v-if="error" severity="error" @close="error = ''; uploadErrors = []">
      {{ error }}
      <button
        v-if="uploadErrors.length > 3"
        class="error-flyout-btn"
        @click="showErrorFlyout = !showErrorFlyout"
      >
        <i class="pi pi-list" /> Details anzeigen
      </button>
    </Message>

    <!-- Error flyout -->
    <div
      v-if="showErrorFlyout && uploadErrors.length > 0"
      class="error-flyout-overlay"
      @click.self="showErrorFlyout = false"
    >
      <div class="error-flyout">
        <div class="error-flyout-header">
          <span>{{ uploadErrors.length }} Fehler beim Hochladen</span>
          <button class="error-flyout-close" @click="showErrorFlyout = false">
            <i class="pi pi-times" />
          </button>
        </div>
        <ul class="error-flyout-list">
          <li v-for="(err, i) in uploadErrors" :key="i">{{ err }}</li>
        </ul>
      </div>
    </div>

    <!-- Upload progress bar — sticky so it stays visible while scrolling on iOS -->
    <div v-if="uploading" class="upload-progress-bar">
      <div class="upload-progress-bar__info">
        <i class="pi pi-upload" />
        <span>{{ uploadCurrent }} von {{ uploadTotal }} Fotos werden hochgeladen…</span>
        <span class="upload-progress-bar__pct">{{ uploadProgress }}%</span>
      </div>
      <div class="upload-progress-bar__track">
        <div class="upload-progress-bar__fill" :style="{ width: uploadProgress + '%' }" />
      </div>
    </div>

    <!-- Upload success message -->
    <div v-if="uploadResultMessage && !uploading" class="upload-result-bar">
      <i class="pi pi-check-circle" />
      <span>{{ uploadResultMessage }}</span>
    </div>

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
      @stop-selected="handleMapStopSelected"
    />

    <!-- Two-column layout: VirtualGallery | Sidebar -->
    <div v-else-if="album" class="gallery-layout">
      <!-- CENTER: virtualized photo grid -->
      <div class="grid-area">
        <VirtualGallery
          ref="galleryRef"
          :around-photo-id="galleryAnchorPhotoId"
          :filter="albumGridFilter"
          :sort-by="sortByForGallery"
          :sort-dir="sortDirForGallery"
          :search-photo-ids="searchPhotoIds"
          :select-mode="selectMode"
          :selected-ids="selectedIds"
          :cursor-index="cursorIndex"
          @photo-click="handleGridPhotoClick"
          @stack-click="handleGridStackClick"
          @toggle-select="onToggleSelect"
          @loaded="onGalleryLoaded"
          @ends-changed="onGridEndsChanged"
        />
      </div>

      <!-- RIGHT: Details sidebar – auf Mobile als Bottom-Sheet -->
      <div class="sidebar-sheet" :class="{ 'is-open': mobileSidebarOpen }">
        <div class="sidebar-sheet-header">
          <button class="sidebar-sheet-close" @click="mobileSidebarOpen = false" aria-label="Schließen">
            <i class="pi pi-times" />
          </button>
        </div>
        <PhotoDetailSidebar
          v-if="cursorPhoto"
          :photo="cursorPhoto"
          :curation-stats="cursorCurationStats"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :poi-matches="detectedPoiMatches"
          :loading-poi-matches="loadingPoiMatches"
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
          @fullscreen="cursorIndex !== null && openGridFullscreenAt(cursorIndex)"
          @toggle-favorite="handleToggleFavorite"
          @comment-count-change="onCommentCountChange"
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

    <!-- Selection action bar (grid mode only). Mirrors GalleryView but adds
         "Aus Album entfernen" as the album-context primary action. -->
    <div v-if="selectMode && viewMode === 'grid'" class="select-bar">
      <span class="select-count">
        <i class="pi pi-check-square" />
        {{
          selectedCount > 0
            ? `${selectedCount} ausgewählt`
            : 'Fotos antippen zum Auswählen'
        }}
      </span>
      <div class="select-actions">
        <Button
          v-if="selectedCount > 0 && canUploadPhotos && canReuseAlbumPhotos"
          label="Alben"
          icon="pi pi-book"
          size="small"
          severity="secondary"
          @click="openAlbumDialog"
        />
        <Button
          v-if="selectedCount > 0 && (canDeletePhotos || canWrite)"
          label="Favorit"
          icon="pi pi-heart"
          size="small"
          :disabled="curationBusy"
          @click="applyCurationToSelection('favorite')"
        />
        <Button
          v-if="selectedCount > 0 && (canDeletePhotos || canWrite)"
          label="Ausblenden"
          icon="pi pi-eye-slash"
          size="small"
          severity="warn"
          :disabled="curationBusy"
          @click="applyCurationToSelection('hidden')"
        />
        <Button
          v-if="selectedCount > 0 && canWrite"
          label="Aus Album"
          icon="pi pi-minus-circle"
          size="small"
          severity="warn"
          :disabled="removeBusy"
          @click="removeFromAlbumSelection"
        />
        <Button
          v-if="selectedCount > 0 && canManageData"
          label="Löschen"
          icon="pi pi-trash"
          size="small"
          severity="danger"
          :disabled="deleteBusy || curationBusy"
          @click="deleteFromSelection"
        />
        <Button
          v-if="selectedCount > 0"
          label="Auswahl aufheben"
          icon="pi pi-replay"
          size="small"
          severity="secondary"
          outlined
          @click="clearSelection"
        />
        <Button
          label="Beenden"
          icon="pi pi-times"
          size="small"
          severity="secondary"
          outlined
          @click="exitSelectMode"
        />
      </div>
    </div>

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileSidebarOpen = false"
    />


    <!-- Fullscreen overlay (Grid mode). Auto-advances every 10 s when
         the user is idle so it doubles as a slideshow. -->
    <FullscreenOverlay
      v-if="isFullscreen && cursorPhoto"
      :photo="cursorPhoto"
      :prevPhoto="cursorPrev"
      :nextPhoto="cursorNext"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="fullscreenDetailsOpen"
      :autoAdvanceMs="5000"
      :currentIndex="(cursorIndex ?? 0) + 1"
      :totalCount="albumPhotos.length"
      :group="cursorGroup"
      @close="closeGridFullscreen"
      @prev="gridGoPrev"
      @next="gridGoNext"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
      @open-group-review="onFullscreenOpenGroupReview"
    >
      <template #actions-before>
        <Button
          icon="pi pi-image"
          rounded text
          :severity="effectiveCoverPhotoId === cursorPhoto.id ? 'warn' : 'secondary'"
          :class="{ 'fs-toolbar-btn--active': effectiveCoverPhotoId === cursorPhoto.id }"
          v-tooltip.bottom="(effectiveCoverPhotoId === cursorPhoto.id ? 'Vom Cover entfernen' : 'Als Cover setzen') + ' (C)'"
          @click="handleSetMapCover(cursorPhoto.id)"
        />
      </template>
      <template #details-flyout="{ readOnly }">
        <PhotoDetailSidebar
          :in-flyout="true"
          :read-only="readOnly"
          :photo="cursorPhoto"
          :curation-stats="cursorCurationStats"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :poi-matches="detectedPoiMatches"
          :loading-poi-matches="loadingPoiMatches"
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
          @comment-count-change="onCommentCountChange"
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

    <!-- Fullscreen overlay (Map mode – scoped to selected day's photos).
         Auto-advances every 10 s when the user is idle so the day's
         photos run as a slideshow. -->
    <FullscreenOverlay
      v-if="isMapFullscreen && mapSelectedPhoto"
      :photo="mapSelectedPhoto"
      :prevPhoto="mapPrevPhoto"
      :nextPhoto="mapNextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="fullscreenDetailsOpen"
      :autoAdvanceMs="5000"
      :markDayChanges="true"
      :currentIndex="mapFullscreenIndex + 1"
      :totalCount="mapFullscreenPhotos.length"
      @close="closeMapFullscreen(); fullscreenDetailsOpen = false"
      @prev="mapFullscreenIndex--"
      @next="mapFullscreenIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
    >
      <template #actions-before>
        <Button
          icon="pi pi-image"
          rounded text
          :severity="effectiveCoverPhotoId === mapSelectedPhoto.id ? 'warn' : 'secondary'"
          :class="{ 'fs-toolbar-btn--active': effectiveCoverPhotoId === mapSelectedPhoto.id }"
          v-tooltip.bottom="(effectiveCoverPhotoId === mapSelectedPhoto.id ? 'Vom Cover entfernen' : 'Als Cover setzen') + ' (C)'"
          @click="handleSetMapCover(mapSelectedPhoto.id)"
        />
      </template>
      <template #details-flyout="{ readOnly }">
        <PhotoDetailSidebar
          :in-flyout="true"
          :read-only="readOnly"
          :photo="mapSelectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :poi-matches="detectedPoiMatches"
          :loading-poi-matches="loadingPoiMatches"
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
          @comment-count-change="onCommentCountChange"
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
      @reviewed="handleGroupReviewed"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />

    <!-- Album settings dialog -->
    <Dialog v-model:visible="showAlbumSettingsDialog" header="Album-Einstellungen" :modal="true" style="width: min(100%, 36rem)">
      <div class="dialog-body">
        <div class="dialog-field">
          <label for="albumSettingsName">Name</label>
          <InputText id="albumSettingsName" v-model="albumSettingsName" autofocus class="dialog-input" @keydown.enter="handleSaveAlbumSettings" />
        </div>
        <div class="dialog-field">
          <label for="albumSettingsDesc">Beschreibung</label>
          <textarea id="albumSettingsDesc" v-model="albumSettingsDesc" rows="2" class="p-inputtextarea p-inputtext dialog-input"></textarea>
        </div>
        <div class="dialog-field dialog-field--row">
          <Checkbox v-model="albumSettingsMapEnabled" inputId="albumSettingsMap" :binary="true" />
          <label for="albumSettingsMap">Karte aktivieren</label>
        </div>
      </div>
      <template #footer>
        <div class="settings-footer">
          <Button
            v-if="isOwner"
            label="Album löschen"
            icon="pi pi-trash"
            severity="danger"
            text
            @click="openDeleteFromSettings"
          />
          <span class="settings-footer__spacer" />
          <Button label="Abbrechen" text @click="showAlbumSettingsDialog = false" />
          <Button label="Speichern" :disabled="!albumSettingsName.trim()" :loading="albumSettingsUpdating" @click="handleSaveAlbumSettings" />
        </div>
      </template>
    </Dialog>

    <!-- Share dialog -->
    <Dialog v-model:visible="showShareDialog" header="Album freigeben" modal style="width: min(100%, 480px)">
      <div v-if="loadingShares" class="share-loading"><i class="pi pi-spin pi-spinner" /> Lädt…</div>
      <template v-else>
        <div class="share-section">
          <h4 class="share-section-title"><i class="pi pi-link" /> Öffentlicher Link</h4>
          <div v-if="publicLink" class="public-link-block">
            <div class="public-link-row">
              <input :value="getPublicLinkUrl()" readonly class="p-inputtext public-link-input" @focus="($event.target as HTMLInputElement).select()" />
              <Button :icon="linkCopied ? 'pi pi-check' : 'pi pi-copy'" :severity="linkCopied ? 'success' : 'secondary'" size="small" v-tooltip="'Kopieren'" @click="copyPublicLink" />
              <Button icon="pi pi-trash" size="small" text severity="danger" v-tooltip="'Link löschen'" @click="handleDeletePublicLink" />
            </div>
            <div class="public-link-meta">
              <span v-if="publicLink.expires_at" :class="['public-link-expiry', { 'public-link-expiry--expired': isLinkExpired }]">
                <i :class="isLinkExpired ? 'pi pi-exclamation-circle' : 'pi pi-clock'" />
                {{ formatShareExpiryDate(publicLink.expires_at) }}
              </span>
              <span v-else class="public-link-expiry">
                <i class="pi pi-clock" /> Unbegrenzt gültig
              </span>
            </div>
          </div>
          <div v-else class="public-link-create">
            <div class="public-link-create-row">
              <Select v-model="linkExpiry" :options="expiryOptions" optionLabel="label" optionValue="value" placeholder="Gültigkeit" class="link-expiry-select" />
              <Button label="Link erstellen" icon="pi pi-link" size="small" outlined @click="handleCreatePublicLink" />
            </div>
            <span class="share-hint">Jeder mit dem Link kann das Album ansehen.</span>
          </div>
        </div>
        <div class="share-section">
          <h4 class="share-section-title">Aktuelle Freigaben</h4>
          <div v-if="albumSharesList.length === 0" class="share-empty">Noch keine Freigaben.</div>
          <div v-for="share in albumSharesList" :key="share.user_id" class="share-row">
            <div class="share-user-info">
              <span class="share-user-name">{{ share.user_name }}</span>
              <span class="share-user-email">{{ share.user_email }}</span>
            </div>
            <span :class="['share-badge', share.access_level === 'read' ? 'share-badge--read' : 'share-badge--write']">
              {{ share.access_level === 'read' ? 'Nur lesen' : share.access_level === 'write_share' ? 'Bearbeiten + Teilen' : 'Bearbeiten' }}
            </span>
            <Button v-if="canRemoveShare(share)" icon="pi pi-times" size="small" text severity="danger" v-tooltip="'Freigabe entfernen'" @click="handleRemoveShare(share.user_id)" />
          </div>
          <div v-if="!isOwner" class="share-hint">Als Teilnehmer mit Teilen-Recht kannst du nur Freigaben entfernen, die du selbst erstellt hast.</div>
        </div>
        <div class="share-section">
          <h4 class="share-section-title">Benutzer hinzufügen</h4>
          <div class="share-add-form">
            <template v-if="usersNotShared.length > 0">
              <Select v-model="shareUserId" :options="usersNotShared" optionLabel="name" optionValue="id" placeholder="Benutzer auswählen…" class="share-user-select" />
              <SelectButton v-model="shareAccessLevel" :options="shareAccessLevelOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
              <Button label="Freigeben" icon="pi pi-check" :loading="sharing" :disabled="!shareUserId" @click="handleShareAlbum" />
            </template>
            <div v-else class="share-empty-hint">Keine weiteren Benutzer zum Freigeben verfügbar.</div>
          </div>
          <div class="share-access-explanation">
            <div class="share-access-explanation-row"><span class="share-badge share-badge--read">Nur lesen</span><span>Ansehen – keine Änderungen möglich.</span></div>
            <div class="share-access-explanation-row"><span class="share-badge share-badge--write">Bearbeiten</span><span>Details ändern, Fotos hinzufügen oder entfernen.</span></div>
            <div v-if="isOwner" class="share-access-explanation-row"><span class="share-badge share-badge--write">Bearbeiten + Teilen</span><span>Zusätzlich Link erzeugen und weitere Benutzer einladen.</span></div>
          </div>
        </div>
      </template>
    </Dialog>

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

    <!-- Add selected photos to other albums (reuses the same dialog as the
         main gallery's select-bar). -->
    <PhotoAlbumDialog
      v-model:visible="albumDialogVisible"
      :photo-ids="albumDialogPhotoIds"
    />

    <!-- Warning dialog when a batch delete skipped some photos -->
    <Dialog
      v-model:visible="showDeleteSkippedDialog"
      :modal="true"
      header="Einige Fotos wurden übersprungen"
      :style="{ width: '26rem' }"
      :closable="true"
    >
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        <p
          v-if="deleteSkipped.filter(s => s.reason === 'not_owner').length > 0"
          style="margin: 0"
        >
          <i class="pi pi-info-circle" style="margin-right: 0.4rem;" />
          {{ deleteSkipped.filter(s => s.reason === 'not_owner').length }}
          Foto(s) übersprungen – du bist nicht der Eigentümer.
        </p>
        <p
          v-if="deleteSkipped.filter(s => s.reason === 'readonly').length > 0"
          style="margin: 0"
        >
          <i class="pi pi-info-circle" style="margin-right: 0.4rem;" />
          {{ deleteSkipped.filter(s => s.reason === 'readonly').length }}
          Foto(s) übersprungen – Dateiquelle ist schreibgeschützt (Bibliotheks-Import).
        </p>
      </div>
      <template #footer>
        <Button label="OK" @click="showDeleteSkippedDialog = false" />
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

/* Single icon button that flips between grid and map view. The icon shows
   the *target* mode (map icon while in grid, grid icon while in map). */
.view-mode-switch { min-width: 2.25rem; }

/* ── Upload (mirrors GalleryView) ─────────────────────────────────────────── */
.upload-button-label { display: inline-flex; cursor: pointer; }
.upload-input-hidden { display: none; }

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

.upload-progress-bar {
  padding: 0.5rem 1rem;
  background: var(--p-blue-50);
  border-bottom: 1px solid var(--p-blue-200);
  /* Sticky so the bar remains visible when the album is scrolled on iOS */
  position: sticky;
  top: 0;
  z-index: 20;
}
.upload-progress-bar__info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--p-blue-700);
  margin-bottom: 0.35rem;
}
.upload-progress-bar__pct { margin-left: auto; font-variant-numeric: tabular-nums; }
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
}
.upload-result-bar .pi-check-circle { color: var(--p-green-500); }

@media (prefers-color-scheme: dark) {
  .upload-progress-bar {
    background: var(--p-blue-900);
    border-color: var(--p-blue-700);
  }
  .upload-progress-bar__info { color: var(--p-blue-200); }
  .upload-progress-bar__track { background: var(--p-blue-800); }
  .upload-progress-bar__fill  { background: var(--p-blue-400); }
  .upload-result-bar {
    background: var(--p-green-900);
    border-color: var(--p-green-700);
    color: var(--p-green-200);
  }
  .upload-result-bar .pi-check-circle { color: var(--p-green-400); }
}

/* ── Error flyout ─────────────────────────────────────────────────────────── */
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
.error-flyout-close:hover {
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}
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

/* Settings dialog footer: delete on the left, save/cancel on the right. */
.settings-footer { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
.settings-footer__spacer { flex: 1; }

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
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* ── Two-column layout ──────────────────────────────────────────────────── */
.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.grid-area {
  flex: 1;
  min-width: 0;
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
/* Phone + portrait: compact the header metadata so it stops wrapping onto a
   second line. The "Fotos" unit word is dropped here (the count alone is
   clear) and the role badge shrinks; the date range is shortened in
   `headerDateRange` (kept in sync with this same media query). */
@media (max-width: 768px) and (orientation: portrait) {
  .header__badge { font-size: 0.6em; }
  .header__meta-unit { display: none; }
}

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

  /* Icon-only filter & sort buttons on mobile — labels would push the
     header onto a second row on phones. The aria-label / tooltip
     remain so the icons are still discoverable. */
  .header__filter-btn :deep(.p-button-label) { display: none; }
  .header__filter-btn :deep(.p-button-icon) { margin-right: 0; }

  /* "Gruppen bearbeiten" collapses to a green icon-only button on phones;
     the unreviewed-count stays in the tooltip. */
  .header__group-review-btn :deep(.p-button-label) { display: none; }
  .header__group-review-btn :deep(.p-button-icon) { margin-right: 0; }
  .header__group-review-btn { padding: 0.5rem; min-width: 2.25rem; }

  /* Upload button is icon-only on phones; the label stays in the tooltip. */
  .header__upload-btn :deep(.p-button-label) { display: none; }
  .header__upload-btn :deep(.p-button-icon) { margin-right: 0; }

  /* Selection action bar — clear of the iOS home indicator and with
     44px-tall touch targets so the buttons are easy to tap (#373). */
  .select-bar {
    position: sticky;
    bottom: 0;
    z-index: 10;
    padding: 0.7rem 0.85rem calc(0.7rem + env(safe-area-inset-bottom, 0px));
    gap: 0.5rem;
  }
  .select-actions { width: 100%; }
  .select-actions :deep(.p-button) {
    flex: 1 1 7rem;
    min-height: 2.75rem;
  }
}

/* ── Selection action bar (desktop + mobile base) ────────────────────────── */
.select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  background: var(--p-primary-50, #eff6ff);
  border-top: 1px solid var(--p-primary-200, #bfdbfe);
  gap: 0.75rem;
  flex-wrap: wrap;
}
.select-count {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--p-primary-700, #1d4ed8);
}
.select-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.p-dark .select-bar {
  background: var(--p-primary-900, #1e3a8a);
  border-top-color: var(--p-primary-700);
}
.p-dark .select-count {
  color: var(--p-primary-200, #bfdbfe);
}

/* ── Delete / settings dialog ───────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 0.75em; padding: 0.5em 0; }
.dialog-body .muted { color: var(--p-text-muted-color); font-size: 0.9em; }
.dialog-field { display: flex; flex-direction: column; gap: 0.35em; }
.dialog-field label { font-size: 0.9em; font-weight: 500; }
.dialog-field--row { flex-direction: row; align-items: center; gap: 0.5em; }
.dialog-input { width: 100%; }

/* ── Share dialog ────────────────────────────────────────────────────────── */
.share-loading { padding: 1rem; text-align: center; }
.share-section { margin-bottom: 1.5rem; }
.share-section-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; }
.share-empty { font-size: 0.85rem; color: var(--p-text-muted-color); }
.share-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0; border-bottom: 1px solid var(--p-content-border-color); }
.share-user-info { flex: 1; min-width: 0; }
.share-user-name { display: block; font-size: 0.875rem; font-weight: 500; }
.share-user-email { display: block; font-size: 0.75rem; color: var(--p-text-muted-color); }
.share-badge { font-size: 0.7rem; padding: 0.15rem 0.4rem; border-radius: 3px; white-space: nowrap; }
.share-badge--read { background: var(--p-content-border-color); color: var(--p-text-muted-color); }
.share-badge--write { background: var(--p-green-100); color: var(--p-green-700); }
.share-add-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.share-user-select { flex: 1; min-width: 180px; }
.share-empty-hint { font-size: 0.875rem; color: var(--p-text-muted-color); font-style: italic; }
.share-hint { font-size: 0.8rem; color: var(--p-text-muted-color); margin-top: 0.4rem; display: block; }
.share-access-explanation { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.8rem; color: var(--p-text-muted-color); }
.share-access-explanation-row { display: flex; align-items: flex-start; gap: 0.5rem; line-height: 1.3; }
.share-access-explanation-row .share-badge { flex-shrink: 0; margin-top: 0.1rem; }
.public-link-block { display: flex; flex-direction: column; gap: 0.4rem; }
.public-link-row { display: flex; gap: 0.5rem; align-items: center; }
.public-link-input { flex: 1; font-size: 0.8rem; }
.public-link-meta { display: flex; align-items: center; gap: 0.5rem; }
.public-link-expiry { font-size: 0.8rem; color: var(--p-text-muted-color); display: flex; align-items: center; gap: 0.3rem; }
.public-link-expiry--expired { color: var(--p-red-500, #ef4444); font-weight: 500; }
.public-link-create { display: flex; flex-direction: column; gap: 0.4rem; }
.public-link-create-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.link-expiry-select { min-width: 140px; }

@media (prefers-color-scheme: dark) {
  .share-badge--write { background: var(--p-green-900); color: var(--p-green-200); }
}

</style>
