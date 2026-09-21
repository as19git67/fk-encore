<script lang="ts" setup>
import { computed, defineAsyncComponent, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import { useConfirm } from 'primevue/useconfirm'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import VirtualGallery from '../components/VirtualGallery.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import PhotoAlbumDialog from '../components/PhotoAlbumDialog.vue'
import PhotoBatchDescriptionDialog from '../components/PhotoBatchDescriptionDialog.vue'
import CollageDialog from '../components/CollageDialog.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import FilterMenu from '../components/FilterMenu.vue'
import ResponsiveToolbar, { type ToolbarItem } from '../components/ResponsiveToolbar.vue'
import PageLayout from '../components/layout/PageLayout.vue'
import SelectionBar from '../components/layout/SelectionBar.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useFilter, usePhotoFilterChips } from '../composables/useFilter'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import { matchesPhotoFilter, type PhotoFilterContext } from '../utils/photoFilter'
import {
  type GalleryGridEntry,
  type GalleryGridGroup,
  type GallerySortDir,
  type GallerySortField,
  getGalleryIds,
} from '../api/gallery'
import { orderedUnreviewedGroupIds, nextGroupInSequence } from '../utils/reviewOrder'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))
import {
  type AlbumAccessLevel,
  type AlbumPublicLink,
  type PhotoLinkVisibility,
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
  ignoreFace,
  leaveAlbum,
  listPhotoGroups,
  reclaimAdoptedGroup,
  reindexPhoto,
  removeAlbumShare,
  shareAlbum,
  type CurationStatus,
  type Face,
  type PoiMatchItem,
  type Photo,
  type PhotoFilter,
  type PhotoGroup,
  type ShareableUser,
  updateAlbum,
  updateAlbumUserSettings,
  updatePhotoCuration,
  updatePhotoLinkVisibility,
  setKnownFaceLinkVisibility,
  isVisibleViaLink,
  updatePhotoDate,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoNavStore } from '../stores/photoNav'
import { useListSelection } from '../composables/useListSelection'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useNaturalSearch } from '../composables/useNaturalSearch'
import { useReferenceData } from '../composables/useReferenceData'
import { onMounted, onUnmounted } from 'vue'
import { useRealtimeEvent } from '../composables/useRealtime'
import {
  refreshPhotoFaces,
  refreshPhotoPoiMatches,
  peekPhotoFacesCached,
  peekPhotoPoiMatchesCached,
  prefetchPhotoMeta,
  invalidatePhotoFaces,
  invalidatePhotoMeta,
} from '../composables/usePhotoMetaCache'
import {
  albumsViewQueryFromStorage,
  rememberFocusedAlbumId,
} from '../utils/albumsViewState'
import { toLocalIsoDateTime } from '../utils/dateFormat'
import { newestIndex, jumpTargetIndex } from '../utils/galleryJump'
import { canCollage } from '../utils/collageLayouts'
import { sharePhotos } from '../utils/sharePhotos'

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

/** Photo count and date range under the title (PageLayout's hint line). */
const headerHint = computed(() => {
  if (!album.value) return undefined
  const count = galleryTotal.value || album.value.photo_count
  let hint = `${count} ${count === 1 ? 'Foto' : 'Fotos'}`
  if (album.value.oldest_photo_at && album.value.newest_photo_at) {
    hint += ` \u2022 ${headerDateRange.value}`
  }
  return hint
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
const albumFilter = useFilter({ preserveKeys: ['photoId'] })
const { applied: filter, draft: filterDraft, activeCount, openEdit, apply: applyFilter, reset: resetFilter } =
  albumFilter
// Removable summaries of the applied filter; the shared toolbar renders them
// and every chip carries its own `remove()`.
const filterChips = usePhotoFilterChips(albumFilter)
const filterMenuOpen = ref(false)
// Lazy-Mount: siehe GalleryView. Spart /persons + /albums beim Album-Öffnen.
const filterMenuMounted = ref(false)
const FILTER_AVAILABLE = computed<Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'nearLocation'>>(() => {
  const arr: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'nearLocation'> = [
    'hiddenMode', 'favorite', 'inGroup',
    'othersFavorited', 'othersHidden',
    'ownerIds',
    'qualityRange', 'mediaTypes', 'hasGps',
    'dateRange', 'nearLocation',
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
// The shared toolbar renders the sort menu from `sortControl.fields` and
// applies a pick straight away, so the view keeps no draft or dialog state.
const sortControl = useSort({ fields: SORT_FIELDS, defaultState: DEFAULT_SORT })
const sort = sortControl.applied

// ── Jump to newest / oldest (mirrors GalleryView) ────────────────────────────
// "Newest / oldest" only has a meaningful semantic for date sorts.
const isDateSort = computed(
  () => sort.value.field === 'taken_at' || sort.value.field === 'created_at',
)
// Which half of the grid the user is in, not whether the scroll touches an
// end: an at-an-end flag flips whenever the container changes height, and a
// phone changes it on every scroll as the URL bar collapses — which made the
// label, and with it the whole toolbar, flicker.
const pastHalf = ref(false)
function onGridPositionChanged(position: { pastHalf: boolean }) {
  pastHalf.value = position.pastHalf
}
const jumpButton = computed(() => {
  if (!isDateSort.value) return null
  const ascending = sort.value.direction === 'asc'
  // Newest sits at the end for asc, at the start for desc; the icon points at
  // the list edge the jump lands on (fast-backward = start, fast-forward = end).
  const inNewestHalf = ascending ? pastHalf.value : !pastHalf.value
  if (inNewestHalf) {
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

/**
 * How many photos the album holds, as the album itself reports it.
 *
 * `loadData` deliberately fetches the album *without* its photo array — the
 * grid paints from `/gallery/grid`, not from this array — and hydrates
 * `album.photos` in the background afterwards. So `rawAlbumPhotos` is empty
 * for a moment after every load, and stays empty for good if that background
 * request fails. Nothing that asks "does this album have any photos" may
 * read its length; that question is answered here, and the maximum keeps the
 * answer right both while `photo_count` is stale (just uploaded) and while
 * the array is still on its way.
 */
const albumPhotoTotal = computed(() =>
  Math.max(album.value?.photo_count ?? 0, rawAlbumPhotos.value.length),
)

/** Whether the background photo hydration has finished (successfully or not). */
const photosHydrated = ref(false)

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
// Dieselbe Auswahl wie in der Galerie (#1272, Etappe 5): die geladenen Ids
// des virtuellen Rasters zum Umkehren, die Gesamtzahl für "alles gewählt"
// und der Weg zum Backend, damit "alles auswählen" das ganze Album meint.
const selection = useListSelection({
  loadedIds: () => galleryRef.value?.getLoadedIds() ?? [],
  total: () => galleryTotal.value,
  loadEntryAt: async (index: number) => galleryRef.value?.loadEntryAt(index) ?? null,
  fetchAllIds: async () => (await getGalleryIds({
    filter: albumGridFilter.value,
    sortBy: sortByForGallery.value,
    sortDir: sortDirForGallery.value,
    photoIds: searchPhotoIds.value ?? undefined,
  })).ids,
})
const { selectMode, selectedIds, selectedCount } = selection
const exitSelectMode = selection.exit
// Das Raster kennt die Signatur aus #830 unverändert.
const onToggleSelect = selection.toggle
const curationBusy = ref(false)
const linkVisibilityBusy = ref(false)
const knownFaceLinkBusy = ref(false)
const knownFaceLinkResult = ref<string | null>(null)
const removeBusy = ref(false)
const deleteBusy = ref(false)
const deleteSkipped = ref<BatchDeleteSkippedPhoto[]>([])
const showDeleteSkippedDialog = ref(false)
const albumDialogVisible = ref(false)
const albumDialogPhotoIds = computed(() => Array.from(selectedIds.value))

function toggleSelectMode() {
  if (selectMode.value) {
    exitSelectMode()
    return
  }
  // Selection lives over the grid — the map has no cells to tick — so
  // starting it from the map view switches to the grid first.
  if (viewMode.value === 'map') viewMode.value = 'grid'
  selection.enter()
}

const galleryTotal = ref(0)

function openAlbumDialog() {
  if (selectedIds.value.size === 0) return
  albumDialogVisible.value = true
}

const descriptionDialogVisible = ref(false)
const descriptionDialogPhotoIds = computed(() => Array.from(selectedIds.value))
function openDescriptionDialog() {
  if (selectedIds.value.size === 0) return
  descriptionDialogVisible.value = true
}

async function onDescriptionsSaved() {
  await loadData()
  await galleryRef.value?.reload()
  exitSelectMode()
}

// ── Collage (2..9 selected photos) ──────────────────────────────────────────
const collageDialogVisible = ref(false)
// Computed so the prop is always in sync with the current selection when
// the dialog opens — avoids a timing window where the ref snapshot could
// be read before Vue propagates the update to the child component.
const collagePhotoIds = computed(() => Array.from(selectedIds.value))
const canShowCollage = computed(() => canCollage(selectedCount.value))
function openCollageDialog() {
  if (!canShowCollage.value) return
  collageDialogVisible.value = true
}

// Collage was saved into this album → refresh metadata + grid so it shows up
// instantly, just like after a delete.
async function onCollageSaved() {
  await loadData()
  await galleryRef.value?.reload()
}

// ── Share selected photos (1..n) ─────────────────────────────────────────────
const sharingPhotos = ref(false)
/**
 * Share exactly one photo — from the fullscreen toolbar or the detail
 * sidebar, without going through select mode first (#1048).
 */
async function shareSinglePhoto(id: number) {
  if (sharingPhotos.value) return
  sharingPhotos.value = true
  try {
    await sharePhotos([id])
  } catch (err: any) {
    error.value = err?.message ?? 'Das Foto konnte nicht geteilt werden.'
  } finally {
    sharingPhotos.value = false
  }
}

async function shareSelectedPhotos() {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0 || sharingPhotos.value) return
  sharingPhotos.value = true
  try {
    await sharePhotos(ids)
  } catch (err: any) {
    error.value = err?.message ?? 'Die Fotos konnten nicht geteilt werden.'
  } finally {
    sharingPhotos.value = false
  }
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

/**
 * Batch-set the public-link visibility of the current selection. Unlike
 * curation this is not per-user — it changes what every link visitor sees —
 * so the backend only accepts it from the photo owner or an album writer.
 */
async function applyLinkVisibilityToSelection(visibility: PhotoLinkVisibility) {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  linkVisibilityBusy.value = true
  try {
    await updatePhotoLinkVisibility(ids, visibility)
    await loadData()
    await galleryRef.value?.reload()
  } catch (err: any) {
    error.value = err?.message ?? 'Die Link-Sichtbarkeit konnte nicht geändert werden.'
  } finally {
    linkVisibilityBusy.value = false
    exitSelectMode()
  }
}

/**
 * Quick pass over every album photo showing a face of a named person:
 * release them all to link visitors, or take them back out.
 */
async function applyKnownFaceLinkVisibility(visibility: PhotoLinkVisibility) {
  knownFaceLinkBusy.value = true
  knownFaceLinkResult.value = null
  try {
    const res = await setKnownFaceLinkVisibility(visibility, { albumId: albumId.value })
    const released = visibility === 'visible'
    if (res.updated === 0) {
      knownFaceLinkResult.value = res.unchanged > 0
        ? (released
          ? `Alle ${res.unchanged} Fotos mit bekannten Gesichtern sind bereits freigegeben.`
          : `Alle ${res.unchanged} Fotos mit bekannten Gesichtern sind bereits ausgenommen.`)
        : 'Keine Fotos mit bekannten Gesichtern in diesem Album.'
    } else {
      const noun = res.updated === 1 ? 'Foto ist' : 'Fotos sind'
      knownFaceLinkResult.value = released
        ? `${res.updated} ${noun} jetzt über den Link sichtbar.`
        : `${res.updated} ${noun} jetzt vom Link ausgenommen.`
    }
    await loadData()
    await galleryRef.value?.reload()
  } catch (err: any) {
    error.value = err?.message ?? 'Die Link-Sichtbarkeit konnte nicht geändert werden.'
  } finally {
    knownFaceLinkBusy.value = false
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

// Was die Auswahlleiste mit den gewählten Fotos anbietet. "Alle auswählen"
// und "Auswahl aufheben" fehlen hier, weil das die eigenen Bedienelemente der
// Leiste sind; alles andere bleibt wie gehabt, samt Rechteprüfung.
const selectionActions = computed<ToolbarItem[]>(() => {
  if (selectedCount.value === 0) return []
  const items: ToolbarItem[] = []
  const push = (item: ToolbarItem) => items.push({ ...item, label: item.title })

  push({
    key: 'share',
    title: selectedCount.value === 1 ? 'Foto teilen' : 'Fotos teilen',
    icon: 'pi pi-share-alt',
    disabled: sharingPhotos.value,
    command: () => void shareSelectedPhotos(),
  })
  if (canShowCollage.value) push({ key: 'collage', title: 'Collage erstellen', icon: 'pi pi-images', command: openCollageDialog })
  if (canUploadPhotos.value && canReuseAlbumPhotos.value) {
    push({ key: 'albums', title: 'Zu Alben hinzufügen', icon: 'pi pi-book', command: openAlbumDialog })
  }
  if (canUploadPhotos.value) {
    push({ key: 'description', title: 'Beschreibung bearbeiten', icon: 'pi pi-align-left', command: openDescriptionDialog })
  }
  if (canDeletePhotos.value || canWrite.value) {
    push({ key: 'favorite', title: 'Als Favorit markieren', icon: 'pi pi-heart', disabled: curationBusy.value, command: () => void applyCurationToSelection('favorite') })
    push({ key: 'hide', title: 'Ausblenden', icon: 'pi pi-thumbs-down-fill', disabled: curationBusy.value, command: () => void applyCurationToSelection('hidden') })
  }
  if (canWrite.value) {
    push({ key: 'link-visible', title: 'Über Freigabe-Link freigeben', icon: 'pi pi-link', disabled: linkVisibilityBusy.value, command: () => void applyLinkVisibilityToSelection('visible') })
    push({ key: 'link-hidden', title: 'Vom Freigabe-Link ausnehmen', icon: 'pi pi-link-slash', disabled: linkVisibilityBusy.value, command: () => void applyLinkVisibilityToSelection('hidden') })
    push({ key: 'link-auto', title: 'Link-Sichtbarkeit automatisch', icon: 'pi pi-sparkles', disabled: linkVisibilityBusy.value, command: () => void applyLinkVisibilityToSelection('auto') })
    push({ key: 'remove-from-album', title: 'Aus diesem Album entfernen', icon: 'pi pi-minus-circle', disabled: removeBusy.value, command: removeFromAlbumSelection })
  }
  if (canDeletePhotos.value) {
    push({ key: 'delete', title: 'Ausgewählte Fotos löschen', icon: 'pi pi-trash', severity: 'danger', disabled: deleteBusy.value || curationBusy.value, command: deleteFromSelection })
  }
  return items
})

// Der Hinweis erscheint genau dann, wenn er nützt: ein Foto ist gewählt, es
// gibt also einen Anker, von dem aus ein Bereich spannt.
const selectionHint = computed(() =>
  selectedCount.value === 1 ? 'Umschalt+Klick wählt den Bereich' : undefined,
)

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

// Grid mode is server-filtered, so its count must come from the same response
// that rendered the cells. Map mode intentionally uses the client-filtered
// full album array because no VirtualGallery is mounted there.
const filteredAlbumPhotoCount = computed(() =>
  viewMode.value === 'grid' ? galleryTotal.value : albumPhotos.value.length,
)


// ── Search ────────────────────────────────────────────────────────────────────
// A natural-language search costs a backend round trip, so the term is only
// committed on submit (`manual: true`). The committed term lives in `?q=`,
// which makes a searched album deep-linkable and lets back/forward
// reproduce it.
const search = useListSearch({
  placeholder: 'Fotos in diesem Album suchen…',
  manual: true,
})
/** Raw input of the search bar; `search.term` is what actually gets searched. */
const searchInput = search.value

const {
  searchResultIds,
  loading: searchLoading,
  error: searchError,
  executeSearch,
  clearSearch,
  locationChip,
  dateChip,
  semanticChip,
  hasParsedChips,
} = useNaturalSearch(search.value)

// The committed term is the single driver of the search — including the one
// already in the URL on first paint. Clearing goes through `search.clear()`
// so the URL never keeps a term the album no longer applies.
watch(
  search.term,
  (term) => {
    if (term) void executeSearch(term)
    else clearSearch()
  },
  { immediate: true },
)

/** Re-run the committed search after a failure. */
function retrySearch() {
  const term = search.term.value
  if (term) void executeSearch(term)
}

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

// The shared list toolbar's model. Declared here because `useListToolbar`
// reads the refs eagerly — everything it references exists by now.
const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount,
    open: openFilterMenu,
    clearAll: () => resetFilter(),
  },
  sort: sortControl,
  result: {
    loaded: () => filteredAlbumPhotoCount.value,
    total: () => albumPhotoTotal.value,
    loading: () => loading.value,
  },
  selection: { active: selectMode, toggle: toggleSelectMode },
})

// ── Manual group review order ──
// Photo ids in the exact order the grid shows them: search ranking when a
// search is active, otherwise the filtered album in sort order. Drives the
// grid-ordered, grid-scoped review sequence below.
const gridOrderedPhotoIds = computed<number[]>(() => {
  const ids = searchResultIds.value
  if (ids !== null) return ids.filter(id => albumPhotoIds.value.has(id))
  return albumPhotos.value.map(p => p.id)
})

// Unreviewed groups to offer for manual review — only those present in the
// current grid, ordered by where they appear in it.
const reviewSequence = computed<number[]>(() =>
  orderedUnreviewedGroupIds(gridOrderedPhotoIds.value, albumPhotoGroups.value),
)

const unreviewedGroupCount = computed(() => reviewSequence.value.length)

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

  // Only fetch per-photo metadata when the details panel can show it (always
  // on desktop; only with the flyout open in fullscreen).
  if (detailsVisible.value) void loadSidebarData(curEntry.id)

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
    const idx = cursorIndex.value
    const entry = await galleryRef.value.loadEntryAt(idx)
    if (entry) await onToggleSelect(entry, { index: idx, range: false })
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
const canReviewGroups = computed(() => auth.hasPermission('photos.delete'))
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

// Live slideshow → map/timeline sync: while paging the map fullscreen, report
// the current photo back to TripMap so it re-derives the stop, re-highlights
// the active pin and re-centres the timeline on every step.
watch(mapSelectedPhoto, (photo) => {
  if (!isMapFullscreen.value || !photo) return
  tripMapRef.value?.selectStopByPhotoId(photo.id)
})
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
const detectedPoiMatches = ref<PoiMatchItem[]>([])
const loadingPoiMatches = ref(false)
const reindexingPhoto = ref(false)
const { persons, fetchPersons, invalidateAlbums } = useReferenceData()

// The sidebar (including the fullscreen details flyout) follows either
// the grid selection or, when the map fullscreen is open, the photo
// currently shown in the map overlay. Watch the effective photo so
// faces/POI reflect what the user actually sees.
const activeDetailPhoto = computed(() =>
  isMapFullscreen.value ? mapSelectedPhoto.value : cursorPhoto.value
)

// Whether the details panel is actually on screen. On desktop the right
// sidebar is always present, so outside fullscreen this is simply true; in
// either fullscreen overlay it tracks the flyout toggle. Mirrors GalleryView's
// `detailsVisible` so per-photo metadata is only fetched when it can be seen.
const detailsVisible = computed(() =>
  (isFullscreen.value || isMapFullscreen.value) ? fullscreenDetailsOpen.value : true
)

watch(activeDetailPhoto, (photo) => {
  if (photo) {
    if (detailsVisible.value) loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
  }
})

// Lazily load the active photo's metadata the moment the panel becomes visible
// (flyout opened in fullscreen, or fullscreen closed back to the desktop
// sidebar). Nothing is fetched while the flyout is closed.
watch(detailsVisible, (visible) => {
  if (visible && activeDetailPhoto.value) loadSidebarData(activeDetailPhoto.value.id)
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
  photosHydrated.value = false
  try {
    const { photos } = await getAlbumPhotos(targetId)
    if (album.value && album.value.id === targetId) {
      album.value = { ...album.value, photos }
    }
  } catch { /* grid stays usable; stacks/map just won't populate */ }
  finally {
    if (albumId.value === targetId) photosHydrated.value = true
  }
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

let sidebarToken = 0
async function loadSidebarData(photoId: number) {
  const token = ++sidebarToken
  // Serve cache hits synchronously and only flip the loading flags for data we
  // actually have to fetch — a prefetched neighbour shows instantly without the
  // faces / "Sehenswürdigkeit wird erkannt…" spinner flashing. The cache also
  // dedups against the neighbour prefetch warmed while the image decoded.
  const cachedFaces = peekPhotoFacesCached(photoId)
  const cachedPois = peekPhotoPoiMatchesCached(photoId)
  detectedFaces.value = cachedFaces ?? []
  detectedPoiMatches.value = cachedPois ?? []
  loadingFaces.value = cachedFaces === undefined
  loadingPoiMatches.value = cachedPois === undefined
  // A non-empty cache is authoritative; an empty/missing entry is revalidated —
  // it may be a stale empty cached by a prefetch issued before this photo's
  // face/POI detection finished, which previously kept the POIs hidden.
  const facesReady = !!cachedFaces && cachedFaces.length > 0
  const poisReady = !!cachedPois && cachedPois.length > 0
  if (facesReady && poisReady) return
  try {
    // Re-fetch only the not-yet-populated side. Each call falls back to what we
    // had on error (e.g. osm-admin down) so the rest of the sidebar still
    // renders.
    const [facesRes, poisRes] = await Promise.all([
      facesReady
        ? Promise.resolve(cachedFaces as Face[])
        : refreshPhotoFaces(photoId).catch(() => cachedFaces ?? []),
      poisReady
        ? Promise.resolve(cachedPois as PoiMatchItem[])
        : refreshPhotoPoiMatches(photoId).catch(() => cachedPois ?? []),
    ])
    if (token !== sidebarToken) return
    detectedFaces.value = facesRes
    detectedPoiMatches.value = poisRes
  } finally {
    if (token === sidebarToken) {
      loadingFaces.value = false
      loadingPoiMatches.value = false
    }
  }
}

// Once a fullscreen image is decoded, warm the neighbours' faces/POI/album
// metadata so the next prev/next is an instant cache hit. Gated on the details
// panel being open so the prefetch never competes with the visible image.
function onGridImageLoaded() {
  if (!fullscreenDetailsOpen.value) return
  if (cursorNext.value) prefetchPhotoMeta(cursorNext.value.id)
  if (cursorPrev.value) prefetchPhotoMeta(cursorPrev.value.id)
}
function onMapImageLoaded() {
  if (!fullscreenDetailsOpen.value) return
  if (mapNextPhoto.value) prefetchPhotoMeta(mapNextPhoto.value.id)
  if (mapPrevPhoto.value) prefetchPhotoMeta(mapPrevPhoto.value.id)
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

// ── Public-link visibility (fullscreen toolbar + detail sidebar) ───────────
// The setting lives on the photo, so every slot holding this id follows, and
// so does the grid marker — but only while the album has a live link, since
// that is the only case in which the server sets `link_hidden` at all.
function syncLinkVisibility(id: number, visibility: PhotoLinkVisibility) {
  const known = [cursorPhoto, cursorPrev, cursorNext]
    .find(r => r.value?.id === id)?.value?.has_known_face
  for (const r of [cursorPhoto, cursorPrev, cursorNext]) {
    if (r.value && r.value.id === id) {
      r.value = { ...r.value, link_visibility: visibility }
    }
  }
  const mfIdx = mapFullscreenPhotos.value.findIndex(p => p.id === id)
  if (mfIdx >= 0) {
    const next = mapFullscreenPhotos.value.slice()
    next[mfIdx] = { ...next[mfIdx]!, link_visibility: visibility }
    mapFullscreenPhotos.value = next
  }
  if (publicLink.value) {
    const shown = isVisibleViaLink({ link_visibility: visibility, has_known_face: known })
    galleryRef.value?.updateEntry(id, { link_hidden: !shown })
  }
}

/** The sidebar already wrote the change; only mirror it into our own state. */
function onLinkVisibilityChanged(id: number, visibility: PhotoLinkVisibility) {
  syncLinkVisibility(id, visibility)
}

/** The overlay only reports intent, so the write is ours. */
async function onFullscreenToggleLinkVisibility(id: number, visibility: PhotoLinkVisibility) {
  const previous = [cursorPhoto, cursorPrev, cursorNext]
    .find(r => r.value?.id === id)?.value?.link_visibility
  syncLinkVisibility(id, visibility)
  try {
    await updatePhotoLinkVisibility([id], visibility)
  } catch (err: any) {
    if (previous !== undefined) syncLinkVisibility(id, previous)
    await galleryRef.value?.reload()
    if (cursorIndex.value !== null) await hydrateCursor(cursorIndex.value)
    error.value = err.message || 'Die Link-Sichtbarkeit konnte nicht geändert werden.'
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
  try {
    await ignoreFace(faceId)
    detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId)
    // Drop the cached faces so a later return to this photo doesn't resurrect
    // the ignored one from the prefetch cache.
    const activeId = activeDetailPhoto.value?.id
    if (activeId) invalidatePhotoFaces(activeId)
  }
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
  try {
    await reindexPhoto(cursorPhoto.value.id)
    invalidatePhotoMeta(cursorPhoto.value.id)
    await loadSidebarData(cursorPhoto.value.id)
  }
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

// Per-album override for adopting other people's similar-photo group
// reviews (docs/group-review-adoption.md). Personal, not an album property,
// so it saves on change instead of on "Speichern".
const albumAdoption = ref<'inherit' | 'on' | 'off'>('inherit')
const albumAdoptionBusy = ref(false)
const ADOPTION_OPTIONS = [
  { label: 'Wie global eingestellt', value: 'inherit' },
  { label: 'Reviews der anderen übernehmen', value: 'on' },
  { label: 'Selbst entscheiden', value: 'off' },
]

async function handleAdoptionChange(value: 'inherit' | 'on' | 'off') {
  if (albumAdoptionBusy.value) return
  albumAdoptionBusy.value = true
  try {
    const updated = await updateAlbumUserSettings(albumId.value, {
      group_review_adoption: value === 'inherit' ? null : value,
    })
    if (album.value?.settings) album.value.settings.group_review_adoption = updated.group_review_adoption
    // Switching this reopens or closes stacks server-side, so the grid and
    // the cached group list are both stale now.
    await refreshGroupsAndPhotos()
  } catch (err) {
    console.error('Failed to update group review adoption:', err)
  } finally {
    albumAdoptionBusy.value = false
  }
}

function openAlbumSettingsDialog() {
  if (!album.value) return
  albumSettingsName.value = album.value.name
  albumSettingsDesc.value = album.value.description || ''
  albumSettingsMapEnabled.value = album.value.display_mode === 'map'
  albumAdoption.value = (album.value.settings?.group_review_adoption as 'on' | 'off' | null | undefined) ?? 'inherit'
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
  if (!album.value || deletingAlbum.value) return
  const albumId = album.value.id
  deletingAlbum.value = true
  try {
    await deleteAlbum(albumId)
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
  // A click both focuses the grid item and opens it, consistently with the
  // main gallery. openGridFullscreenAt owns cursor hydration so this also
  // avoids the former duplicate request on narrow screens.
  void openGridFullscreenAt(idx)
}

async function handleGridStackClick(entry: GalleryGridEntry) {
  if (!entry.group) return
  if (entry.group.adopted) {
    // "Selbst prüfen" on an adopted stack: give the photos that were
    // hidden on the user's behalf back before opening the compare view,
    // otherwise they would review a group whose members they cannot see
    // (docs/group-review-adoption.md).
    await reclaimAdoptedGroup(entry.group.id)
    await refreshGroupsAndPhotos()
  }
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

async function onGalleryLoaded(info: { total: number; offset: number }) {
  if (!galleryRef.value) return
  galleryTotal.value = info.total
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
  // Resolve the next group along the grid-ordered sequence BEFORE the
  // reload drops the just-reviewed group from it, so we keep our place in
  // grid order (wrapping to the first pending group when started mid-grid).
  // Capture the whole group OBJECT, not just its id: loadData() refetches
  // the album WITHOUT photos and rehydrates the photo array in the
  // background, so for a moment album.photos — and therefore
  // albumPhotoGroups — is empty. Looking the next group up from
  // albumPhotoGroups only after the reload would then find nothing and
  // strand the user back in the thumbnail grid mid-streak.
  const candidateId = nextGroupInSequence(
    reviewSequence.value,
    reviewedGroupId,
    id => albumPhotoGroups.value.some(g => g.id === id && !g.reviewed_at),
  )
  const candidateGroup = candidateId !== null
    ? albumPhotoGroups.value.find(g => g.id === candidateId) ?? null
    : null
  await loadData()
  // Anchor on a still-visible photo of the just-reviewed group (see
  // handleGroupClose); harmless when we immediately open the next group.
  const anchorId = postReviewAnchorId(activeGroup.value)
  await galleryRef.value?.reload(anchorId !== null ? { aroundPhotoId: anchorId } : undefined)
  if (candidateGroup !== null) {
    // Prefer the freshly-trimmed group once the photo array has rehydrated;
    // fall back to the pre-captured object while that hydration is still in
    // flight so the next group always opens. PhotoCompareView fetches its
    // own members, so the captured (possibly slightly stale) group is fine.
    const refreshed = albumPhotoGroups.value.find(g => g.id === candidateGroup.id && !g.reviewed_at)
    activeGroup.value = refreshed ?? candidateGroup
  } else {
    const group = activeGroup.value
    activeGroup.value = null
    selectAfterGroup(group)
  }
}

function handleStartGroupReview() {
  const firstId = reviewSequence.value[0]
  const first = firstId !== undefined
    ? albumPhotoGroups.value.find(g => g.id === firstId)
    : undefined
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

// ── Responsive toolbar ────────────────────────────────────────────────────────
// Hidden file input behind the "Hochladen" toolbar item. Keeping the input out
// of the toolbar (rather than wrapping a Button in a <label>) lets the upload
// action collapse into the overflow dropdown like every other item.
const fileInputRef = ref<HTMLInputElement | null>(null)
function triggerFileSelect() {
  fileInputRef.value?.click()
}

// The album's own actions (jump, group review, map, cover, share, settings,
// upload, leave) as a flat list. Filter, sort and select mode are no longer
// here — they are part of the shared toolbar. ResponsiveToolbar pushes
// whatever does not fit into an overflow dropdown. Order = reading order.
const toolbarItems = computed<ToolbarItem[]>(() => {
  const items: ToolbarItem[] = []

  if (jumpButton.value && viewMode.value !== 'map') {
    items.push({
      key: 'jump',
      label: jumpButton.value.label,
      title: jumpButton.value.label,
      icon: jumpButton.value.icon,
      severity: 'secondary',
      outlined: true,
      command: onJumpEnd,
    })
  }

  if (canReviewGroups.value && unreviewedGroupCount.value > 0 && viewMode.value !== 'map') {
    items.push({
      key: 'group-review',
      label: `Gruppen bearbeiten (${unreviewedGroupCount.value} offen)`,
      title: `Gruppen bearbeiten (${unreviewedGroupCount.value} offen)`,
      icon: 'pi pi-images',
      severity: 'success',
      command: handleStartGroupReview,
    })
  }

  if (mapEnabled.value) {
    items.push({
      key: 'view-mode',
      title: viewMode.value === 'map' ? 'Rasteransicht anzeigen' : 'Kartenansicht anzeigen',
      icon: viewMode.value === 'map' ? 'pi pi-th-large' : 'pi pi-map',
      text: true,
      command: toggleViewMode,
    })
  }

  if (effectiveCoverPhotoId.value && viewMode.value !== 'map') {
    items.push({
      key: 'cover',
      title: 'Cover fokussieren',
      icon: 'pi pi-image',
      text: true,
      command: scrollToCover,
    })
  }

  if (canShareAlbum.value) {
    items.push({
      key: 'share',
      title: 'Freigeben',
      icon: 'pi pi-share-alt',
      text: true,
      command: openShareDialogLocal,
    })
  }

  if (canWrite.value) {
    items.push({
      key: 'settings',
      title: 'Album-Einstellungen',
      icon: 'pi pi-cog',
      text: true,
      command: openAlbumSettingsDialog,
    })
  }

  if (canUpload.value) {
    items.push(
      uploading.value
        ? {
            key: 'upload',
            label: 'Abbrechen',
            title: 'Hochladen abbrechen',
            icon: 'pi pi-times',
            severity: 'danger',
            command: cancelUpload,
          }
        : {
            key: 'upload',
            label: 'Hochladen',
            title: 'Fotos hochladen',
            icon: 'pi pi-upload',
            command: triggerFileSelect,
          },
    )
  }

  if (!isOwner.value) {
    items.push({
      key: 'leave',
      title: 'Freigabe verlassen',
      icon: 'pi pi-sign-out',
      severity: 'danger',
      text: true,
      command: () => {
        showLeaveDialog.value = true
      },
    })
  }

  return items
})


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
useRealtimeEvent('photos', 'scan.updated', (ev) => {
  const affectedAlbums = ev.payload?.albumIds as number[] | undefined
  if (affectedAlbums?.length && !affectedAlbums.includes(albumId.value)) return
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
  <PageLayout
    :title="album ? album.name : 'Album'"
    :hint="headerHint"
    scroll="self"
    width="full"
    :ready="!loading"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <template #actions>
      <template v-if="album">
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
        <span :class="['header__badge', `header__badge--${album.role}`]">{{ album.role }}</span>
      </template>
    </template>

    <!-- Sticky part (lifted into the app stack by PageLayout): the shared
         list toolbar. The album-scoped natural search replaces its plain
         input, the album's own actions sit in its actions slot; filter,
         sort, the chips, the count and select mode are the toolbar's own. -->
    <template #toolbar>
      <ListToolbar v-if="album" :model="toolbar">
        <template #search>
          <!-- Natural-language search: global search, results filtered to this album -->
          <NaturalSearchBar
            v-model="searchInput"
            class="album-search"
            :loading="searchLoading"
            :result-count="searchResultCountInAlbum"
            :has-parsed-chips="hasParsedChips"
            :location-chip="locationChip"
            :date-chip="dateChip"
            :semantic-chip="semanticChip"
            :placeholder="search.placeholder"
            @search="search.submit()"
            @clear="search.clear()"
            @keydown.escape.stop
          />
        </template>

        <template #actions>
          <!-- Album actions only; they share the row and overflow into a
               dropdown when tight. -->
          <ResponsiveToolbar class="header__toolbar" :items="toolbarItems" />

          <!-- Hidden file input driven by the "Hochladen" toolbar item. -->
          <input
            v-if="canUpload"
            ref="fileInputRef"
            type="file"
            accept="image/*"
            multiple
            class="upload-input-hidden"
            @change="onFileInputChange"
          />
        </template>
      </ListToolbar>
    </template>

    <!-- Auswahlleiste: eine für alle Listen, im Sticky-Stack der Seite
         (auf dem Telefon am unteren Rand). -->
    <template #selection>
      <SelectionBar
        v-if="selectMode"
        :selection="selection"
        :actions="selectionActions"
        noun="Fotos"
        :hint="selectionHint"
      />
    </template>

    <template #notice>
      <ServiceStatusBar />
      <ErrorBanner
        v-if="searchError"
        :message="searchError"
        closable
        @retry="retrySearch"
        @close="searchError = ''"
      />
      <!-- Upload / share / delete failures: nothing to retry generically,
           so the banner only explains and offers the error list. -->
      <ErrorBanner
        v-if="error"
        :message="error"
        :retryable="false"
        closable
        @close="error = ''; uploadErrors = []"
      >
        <button
          v-if="uploadErrors.length > 3"
          class="error-flyout-btn"
          @click="showErrorFlyout = !showErrorFlyout"
        >
          <i class="pi pi-list" /> Details anzeigen
        </button>
      </ErrorBanner>
    </template>

    <!-- Drag overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <div class="drag-message">
        <i class="pi pi-upload" />
        <span>Fotos zum Hochladen hier ablegen</span>
      </div>
    </div>

    <FilterMenu
      v-if="filterMenuMounted"
      v-model:visible="filterMenuOpen"
      v-model:draft="filterDraft"
      :available="FILTER_AVAILABLE"
      :reference-location="cursorPhoto?.latitude != null && cursorPhoto?.longitude != null
        ? { latitude: cursorPhoto.latitude, longitude: cursorPhoto.longitude, label: cursorPhoto.original_name }
        : undefined"
      @apply="onApplyFilter"
      @reset="onResetFilter"
    />

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

    <!-- In-flow body: progress bars, map or grid row and the floating
         selection tray. The wrapper is the positioned box the tray is
         anchored to. -->
    <div class="album-body">
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

      <PageSkeleton v-if="loading && !album" variant="grid" :count="12" />

      <!-- An album with no photos at all — the filter cannot be the cause,
           so there is nothing to clear. Decided on the album's own count, not
           on the photo array: that one arrives later (or not at all). -->
      <EmptyState
        v-else-if="album && albumPhotoTotal === 0"
        icon="pi pi-images"
        title="Noch keine Fotos in diesem Album"
        message="Lade Fotos hoch oder füge welche aus der Galerie hinzu."
      />

      <!-- Map mode -->
      <TripMap
        v-else-if="album && viewMode === 'map' && albumPhotos.length > 0"
        ref="tripMapRef"
        :photos="albumPhotosFiltered"
        :albumName="album.name"
        :albumDescription="album.description"
        @open-fullscreen="handleMapFullscreen"
        @stop-selected="handleMapStopSelected"
      />

      <!-- Map mode, photo array still on its way: the map draws from it, so
           it has nothing to show yet — and that is not an empty album. -->
      <PageSkeleton
        v-else-if="album && viewMode === 'map' && !photosHydrated"
        variant="grid"
        :count="6"
      />

      <!-- Map mode with every photo filtered away. The grid mode below
           renders its own empty state inside VirtualGallery. -->
      <EmptyState
        v-else-if="album && viewMode === 'map'"
        icon="pi pi-map"
        title="Keine Fotos in dieser Ansicht"
        :message="activeCount > 0
          ? 'Der aktive Filter blendet alle Fotos dieses Albums aus.'
          : 'Die Fotos dieses Albums konnten nicht geladen werden. Lade die Seite neu.'"
        :filtered="activeCount > 0"
        @clear-filters="onResetFilter"
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
            @position-changed="onGridPositionChanged"
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
            :loading-faces="loadingFaces"
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
            @link-visibility-changed="onLinkVisibilityChanged"
            @share="shareSinglePhoto"
            :sharing="sharingPhotos"
          />
        </div>
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
      :can-share="true"
      :text-layer="true"
      :sharing="sharingPhotos"
      @close="closeGridFullscreen"
      @prev="gridGoPrev"
      @next="gridGoNext"
      @current-loaded="onGridImageLoaded"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
      @toggle-link-visibility="onFullscreenToggleLinkVisibility"
      @share="shareSinglePhoto"
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
      <template #details-flyout="{ readOnly, detailsOpen, imageReady }">
        <PhotoDetailSidebar
          :in-flyout="true"
          :read-only="readOnly"
          :flyout-open="detailsOpen"
          :image-ready="imageReady"
          :photo="cursorPhoto"
          :curation-stats="cursorCurationStats"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :loading-faces="loadingFaces"
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
          @link-visibility-changed="onLinkVisibilityChanged"
          @share="shareSinglePhoto"
          :sharing="sharingPhotos"
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
      :can-share="true"
      :text-layer="true"
      :sharing="sharingPhotos"
      @close="closeMapFullscreen(); fullscreenDetailsOpen = false"
      @prev="mapFullscreenIndex--"
      @next="mapFullscreenIndex++"
      @current-loaded="onMapImageLoaded"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="fullscreenDetailsOpen = !fullscreenDetailsOpen"
      @toggle-cover="handleSetMapCover"
      @toggle-link-visibility="onFullscreenToggleLinkVisibility"
      @share="shareSinglePhoto"
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
      <template #details-flyout="{ readOnly, detailsOpen, imageReady }">
        <PhotoDetailSidebar
          :in-flyout="true"
          :read-only="readOnly"
          :flyout-open="detailsOpen"
          :image-ready="imageReady"
          :photo="mapSelectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="isEditingDate"
          v-model:editDate="editDate"
          :loading-faces="loadingFaces"
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
          @link-visibility-changed="onLinkVisibilityChanged"
          @share="shareSinglePhoto"
          :sharing="sharingPhotos"
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
        <div v-if="album?.is_shared" class="dialog-field">
          <label for="albumAdoption">Ähnliche Fotos: Reviews der anderen</label>
          <Select
            id="albumAdoption"
            v-model="albumAdoption"
            :options="ADOPTION_OPTIONS"
            optionLabel="label"
            optionValue="value"
            :disabled="albumAdoptionBusy"
            class="dialog-input"
            @change="handleAdoptionChange(albumAdoption)"
          />
          <small class="dialog-hint">
            Hat jemand anderes einen Stapel schon bereinigt, gilt dessen Ergebnis
            hier als Voreinstellung. Sobald du einen Stapel selbst prüfst, gehört
            er dir. Gilt nur für diese Einstellung des Albums.
          </small>
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
          <div class="link-privacy-block">
            <span class="share-hint">
              <i class="pi pi-link-slash" />
              Fotos mit bekannten Gesichtern werden über den Link grundsätzlich nicht gezeigt.
              Im Album sind sie mit
              <i class="pi pi-link-slash link-privacy-inline-icon" />
              gekennzeichnet; einzelne Fotos lassen sich im Foto-Detail oder im Vollbild freigeben.
            </span>
            <div class="link-privacy-actions">
              <Button
                label="Alle mit bekannten Gesichtern freigeben"
                icon="pi pi-link"
                size="small"
                text
                :loading="knownFaceLinkBusy"
                @click="applyKnownFaceLinkVisibility('visible')"
              />
              <Button
                label="Freigaben zurücknehmen"
                icon="pi pi-replay"
                size="small"
                text
                severity="secondary"
                :loading="knownFaceLinkBusy"
                @click="applyKnownFaceLinkVisibility('auto')"
              />
            </div>
            <span v-if="knownFaceLinkResult" class="share-hint">{{ knownFaceLinkResult }}</span>
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
        <Button label="Löschen" severity="danger" :loading="deletingAlbum" :disabled="deletingAlbum" @click="handleDeleteAlbum" />
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

    <PhotoBatchDescriptionDialog
      v-model:visible="descriptionDialogVisible"
      :photo-ids="descriptionDialogPhotoIds"
      @saved="onDescriptionsSaved"
    />

    <!-- Collage creator (album select-bar entry point) -->
    <CollageDialog
      v-model:visible="collageDialogVisible"
      :photo-ids="collagePhotoIds"
      :album-id="albumId"
      @saved="onCollageSaved"
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
  </PageLayout>
</template>

<style scoped>
.link-privacy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.link-privacy-inline-icon {
  font-size: 0.75rem;
}
.link-privacy-block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-items: flex-start;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}

/* Page frame and title: PageLayout (issue #1272). */

/* The in-flow body below the sticky stack: the positioned box the floating
   selection tray is anchored to; map or grid row inside takes the rest. */
.album-body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
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

.header__filter { display: flex; align-items: center; gap: 0.5em; }

/* The action toolbar inside ListToolbar's actions slot: it takes the space
   the shared controls leave and spills items into its overflow dropdown
   instead of wrapping. */
.header__toolbar { flex: 1 1 16rem; min-width: 0; }

/* ── Album-scoped natural search bar (in the toolbar's search area) ──────── */
.album-search {
  flex: 1 1 auto;
  min-width: 0;
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
/* Phone + portrait: the role badge shrinks; the date range is shortened in
   `headerDateRange` (kept in sync with this same media query). */
@media (max-width: 768px) and (orientation: portrait) {
  .header__badge { font-size: 0.6em; }
}

@media (max-width: 768px) {
  .mobile-backdrop { display: block; }

  .sidebar-sheet {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: calc(100dvh - var(--app-stack-height, 0px));
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

}

/* ── Delete / settings dialog ───────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 0.75em; padding: 0.5em 0; }
.dialog-body .muted { color: var(--p-text-muted-color); font-size: 0.9em; }
.dialog-field { display: flex; flex-direction: column; gap: 0.35em; }
.dialog-field label { font-size: 0.9em; font-weight: 500; }
.dialog-field--row { flex-direction: row; align-items: center; gap: 0.5em; }
.dialog-input { width: 100%; }
.dialog-hint { font-size: 0.8em; line-height: 1.35; color: var(--p-text-muted-color); }

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
