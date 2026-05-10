<script setup lang="ts">
/**
 * Greenfield virtualized photo gallery — Phase 3b.
 *
 * Builds on Phase 3a (fullscreen + photoId deeplink) by adding the
 * `<PhotoDetailSidebar>` flyout: detected faces with person names,
 * landmarks, EXIF date editing, album membership, keywords, file
 * metadata. The sidebar self-manages its album section (lazy-fetches
 * the album list, owns pending changes, calls the batch-update API on
 * save), so the parent only needs to feed it the per-photo state
 * (faces, landmarks, edit-date refs) and the auth-derived booleans.
 *
 * Detail flyout flow:
 *   - The `I` keyboard shortcut and the ⓘ toolbar button toggle
 *     `detailsActive`. FullscreenOverlay slots the sidebar into its
 *     `details-flyout` slot; the flyout's open/closed CSS class is
 *     driven by the same boolean.
 *   - When `cursorPhoto.id` changes (open / prev / next), we load
 *     faces + landmarks for that photo in parallel with the existing
 *     `getPhotoDetailsBatch` hydration. Loaders are guarded by the
 *     same `hydrateToken` so out-of-order navigation can't strand a
 *     stale list of faces on the wrong photo.
 *   - Edit-date is parent-owned: the sidebar emits `start-edit-date`,
 *     `update-date`, `cancel-edit-date`; the parent flips the refs
 *     and calls `updatePhotoDate`, then mutates `cursorPhoto` in
 *     place so the topbar's date label updates immediately.
 *
 * Phase 3c adds keyboard navigation over the grid: a `cursorIndex` ref
 * highlights the active cell; ←/→ step by one, ↑/↓ jump a row (=
 * `cols` cells); Space / Enter open the cursor cell in fullscreen (or
 * toggle its selection while in select mode).
 *
 * Phase 3d removes the legacy gallery: the menu's "Galerie alt" entry
 * is gone, the `name: 'fotos-gallery'` route name now points at this
 * view, and FeedView / PersonsView / PhotoLocationMenu's photoId
 * deeplinks resolve here instead of `PhotosView.vue` (which has been
 * deleted). `/fotos/galerie-alt` URLs still resolve via a router-level
 * legacy redirect to `/fotos/galerie`.
 *
 * Phase 3e unifies the per-photo state under a single `cursorPhoto`
 * (with `cursorPrev / cursorNext` for fullscreen navigation). Both
 * the fullscreen viewer and the new persistent desktop sidebar read
 * from the same triple, hydrated by `hydrateCursor` on every cursor
 * mutation (click, keyboard ←/→/↑/↓, fullscreen prev/next). The
 * sidebar mounts on ≥768px viewports as a fixed-width column right of
 * the grid; on mobile it's hidden and details remain reachable through
 * the fullscreen ⓘ flyout, which still receives a sidebar instance via
 * the `details-flyout` slot.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import VirtualGallery from '../components/VirtualGallery.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import SortMenu from '../components/SortMenu.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoAlbumDialog from '../components/PhotoAlbumDialog.vue'
import { useFilter } from '../composables/useFilter'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import { useNaturalSearch } from '../composables/useNaturalSearch'
import { useReferenceData } from '../composables/useReferenceData'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoNavStore } from '../stores/photoNav'
import {
  type GalleryGridEntry,
  type GallerySortDir,
  type GallerySortField,
} from '../api/gallery'
import {
  listPhotoGroups,
  updatePhotoCuration,
  computeFileHash,
  checkPhotoHash,
  uploadPhotoWithProgress,
  getPhotoDetailsBatch,
  getPhotoFaces,
  getPhotoLandmarks,
  ignoreFace,
  reindexPhoto,
  updatePhotoDate,
  batchDeletePhotos,
  type BatchDeleteSkippedPhoto,
  type Photo,
  type PhotoGroup,
  type CurationStatus,
  type Face,
  type LandmarkItem,
} from '../api/photos'

const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()
const photoNav = usePhotoNavStore()
const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const { persons, fetchPersons } = useReferenceData()
void fetchPersons() // module-cached; no-op on subsequent visits

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))
const canManageData = computed(() => auth.hasPermission('data.manage'))
const showPersons = computed(() => auth.hasPermission('people.view'))

// Kept for backwards-compatible session restore on first app load (before
// the store has been populated by any user interaction in this session).
const LAST_PHOTO_KEY = 'photos_last_selected_id'

// ── Initial anchor (resolved once) ──────────────────────────────────────────
// Priority order:
//   1. Explicit ?photoId= deeplink → also auto-opens fullscreen.
//   2. photoNavStore.selectedPhotoId set by a previous view this session.
//   3. localStorage fallback for cross-session restore.
const initialAnchor = ref<number | null>(null)
const pendingFullscreenId = ref<number | null>(null)
{
  const q = Number(route.query.photoId)
  if (Number.isFinite(q) && q > 0) {
    initialAnchor.value = q
    pendingFullscreenId.value = q
  } else if (photoNav.selectedPhotoId !== null) {
    initialAnchor.value = photoNav.selectedPhotoId
  } else {
    const stored = Number(localStorage.getItem(LAST_PHOTO_KEY))
    if (Number.isFinite(stored) && stored > 0) initialAnchor.value = stored
  }
}
if (route.query.photoId !== undefined) {
  void router.replace({ query: { ...route.query, photoId: undefined } })
}

// ── Filter ──────────────────────────────────────────────────────────────────
const {
  applied: filter,
  draft: filterDraft,
  activeCount,
  openEdit: openFilterEdit,
  apply: applyFilter,
  reset: resetFilter,
  removeKey,
} = useFilter({ preserveKeys: ['photoId', 'sortBy', 'sortDir'] })
const filterMenuOpen = ref(false)
// Lazy-mount the filter menu so its onMounted-prefetch (/persons, /albums)
// only runs when the user actually opens it — not on gallery boot.
const filterMenuMounted = ref(false)

function openFilterMenu() {
  openFilterEdit()
  filterMenuMounted.value = true
  filterMenuOpen.value = true
}

function onApplyFilter() {
  applyFilter()
  // VirtualGallery watches `filter` and re-inits automatically.
}
function onResetFilter() {
  resetFilter()
}
function onRemoveFilterKey(keys: Array<keyof typeof filter.value>) {
  removeKey(keys)
}

// ── Sort ────────────────────────────────────────────────────────────────────
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
const sortChipLabel = computed(
  () => `Sortierung: ${sortFieldLabel.value} ${sort.value.direction === 'asc' ? '↑' : '↓'}`,
)

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

// ── Search ──────────────────────────────────────────────────────────────────
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

const searchResultCount = computed(() => searchResultIds.value?.length ?? 0)

// Adapt searchResultIds → number[] | null shape that VirtualGallery wants.
// useNaturalSearch already gives us that exact shape, just rename.
const searchPhotoIds = computed<number[] | null>(() => searchResultIds.value)

// ── Jump-to-end button ──────────────────────────────────────────────────────
// Toolbar button that takes the user to the newest or oldest photo.
// Label and direction depend on which end of the grid the scroll is
// currently parked at — VirtualGallery emits `ends-changed` whenever
// that flips. Hidden when the active sort isn't date-based, since
// "newest / oldest" only has a meaningful semantic for `taken_at` and
// `created_at`.
const scrollEnds = ref({ atStart: true, atEnd: false })
function onEndsChanged(ends: { atStart: boolean; atEnd: boolean }) {
  scrollEnds.value = ends
}

const isDateSort = computed(
  () => sort.value.field === 'taken_at' || sort.value.field === 'created_at',
)

const jumpButton = computed(() => {
  if (!isDateSort.value) return null
  const ascending = sort.value.direction === 'asc'
  // With ASC sort: oldest at top (index 0), newest at bottom (last index).
  // With DESC: oldest at bottom, newest at top. The label is semantic,
  // not directional — the icon points the way the scroll has to go.
  const atNewest = ascending ? scrollEnds.value.atEnd : scrollEnds.value.atStart
  if (atNewest) {
    return {
      label: 'Zum ältesten',
      icon: ascending ? 'pi pi-angle-double-up' : 'pi pi-angle-double-down',
      target: 'oldest' as const,
    }
  }
  return {
    label: 'Zum neuesten',
    icon: ascending ? 'pi pi-angle-double-down' : 'pi pi-angle-double-up',
    target: 'newest' as const,
  }
})

function onJumpEnd() {
  if (!galleryRef.value || !jumpButton.value) return
  const total = galleryRef.value.getTotal()
  if (total === 0) return
  const ascending = sort.value.direction === 'asc'
  const goNewest = jumpButton.value.target === 'newest'
  // Newest:  ASC → last,  DESC → first.
  // Oldest:  ASC → first, DESC → last.
  const targetIdx = (goNewest === ascending) ? total - 1 : 0
  galleryRef.value.scrollToIndex(targetIdx, 'start')
  cursorIndex.value = targetIdx
  void hydrateCursor(targetIdx)
}

// ── Selection ───────────────────────────────────────────────────────────────
const selectMode = ref(false)
const selectedIds = ref<Set<number>>(new Set())
const selectedCount = computed(() => selectedIds.value.size)

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

// ── Album batch dialog (entry point for the mobile select-bar where the
//    desktop sidebar is hidden) ────────────────────────────────────────────
const albumDialogVisible = ref(false)
const albumDialogPhotoIds = computed(() => Array.from(selectedIds.value))
function openAlbumDialog() {
  if (selectedIds.value.size === 0) return
  albumDialogVisible.value = true
}

// ── Curation (batch on selected) ────────────────────────────────────────────
// Keeps the source's loaded slots in sync with the server's truth via
// optimistic `updateEntry` before the network round-trip — instant UI,
// reverts in-place on failure.
const curationBusy = ref(false)
const galleryRef = ref<InstanceType<typeof VirtualGallery> | null>(null)

async function applyCurationToSelection(target: 'favorite' | 'hidden' | 'visible') {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  curationBusy.value = true
  try {
    // Sequential — most users select a small handful, and a burst of
    // parallel writes against a slow backend just produces 503s.
    for (const id of ids) {
      galleryRef.value?.updateEntry(id, { curation: target as CurationStatus })
      try {
        await updatePhotoCuration(id, target as CurationStatus)
      } catch {
        // Rollback on failure: we don't actually know the previous state
        // from inside the cell, so trigger a full reload to re-sync.
        await galleryRef.value?.reload()
        break
      }
    }
  } finally {
    curationBusy.value = false
    exitSelectMode()
  }
}

// ── Batch delete ────────────────────────────────────────────────────────────
const deleteBusy = ref(false)
const deleteCount = ref(0)
const deleteSkipped = ref<BatchDeleteSkippedPhoto[]>([])
const showDeleteSkippedDialog = ref(false)

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
  deleteCount.value = ids.length
  try {
    const result = await batchDeletePhotos(ids)
    if (result.skipped.length > 0) {
      deleteSkipped.value = result.skipped
      showDeleteSkippedDialog.value = true
    }
    if (result.deleted.length > 0) {
      await galleryRef.value?.reload()
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Fehler beim Löschen der Fotos.'
  } finally {
    deleteBusy.value = false
    exitSelectMode()
  }
}

// ── Stacks (compare view) ───────────────────────────────────────────────────
// The cache is loaded eagerly on mount because the "Gruppen bearbeiten
// (N offen)" button in the subheader needs `unreviewedCount` to decide
// its label and visibility. Tap → compare view looks up the matching
// PhotoGroup by id; the cache is invalidated after every review so the
// next reader sees fresh state.
const groupCache = ref<PhotoGroup[] | null>(null)
const activeGroup = ref<PhotoGroup | null>(null)
const stackBusy = ref(false)
const totalUnreviewed = computed(
  () => groupCache.value?.filter((g) => !g.reviewed_at).length ?? 0,
)

async function ensureGroupCache(): Promise<PhotoGroup[]> {
  if (groupCache.value) return groupCache.value
  const res = await listPhotoGroups()
  groupCache.value = res.groups
  return res.groups
}
// Fire-and-forget: a stale cache only delays the "Gruppen bearbeiten"
// button by one HTTP round-trip on first paint and the gallery still
// works without it.
void ensureGroupCache()

async function onStackClick(entry: GalleryGridEntry) {
  if (!entry.group) return
  if (stackBusy.value) return
  stackBusy.value = true
  try {
    const groups = await ensureGroupCache()
    const found = groups.find((g) => g.id === entry.group!.id) ?? null
    activeGroup.value = found
  } finally {
    stackBusy.value = false
  }
}

async function startGroupReview() {
  const groups = await ensureGroupCache()
  const first = groups.find((g) => !g.reviewed_at)
  if (first) activeGroup.value = first
}

function applyLocalGroupReviewed(groupId: number) {
  // Optimistic local update — the server already marked the group reviewed
  // (handleDone in PhotoCompareView calls reviewPhotoGroup before emitting
  // close/next). Mirroring it locally keeps the user's scroll position
  // and the loaded entries intact:
  //   - groupCache: flip the reviewed_at on the matching entry so
  //     `totalUnreviewed` decrements and the green "Gruppen bearbeiten"
  //     button label updates without a refetch.
  //   - galleryRef.markGroupReviewed: flip `group.reviewed` on every
  //     loaded cell of that group so badges / outlines / click-routing
  //     gate off naturally.
  // A full gallery reload would otherwise null the entries array and
  // skeleton-flash every loaded cell while the new pages stream back in.
  if (groupCache.value) {
    groupCache.value = groupCache.value.map((g) =>
      g.id === groupId
        ? { ...g, reviewed_at: g.reviewed_at ?? new Date().toISOString() }
        : g,
    )
  }
  galleryRef.value?.markGroupReviewed(groupId)
}

function onCompareReviewed() {
  // Fired by PhotoCompareView's "Fertig" button after the server
  // accepted the review. We need to capture the id BEFORE `close`
  // clears `activeGroup`. Doesn't run when the user dismisses via
  // the X / Esc — that path emits `close` only, leaving the group
  // unreviewed both server- and client-side, so re-opening still
  // surfaces it for review.
  const reviewedGroupId = activeGroup.value?.id
  if (reviewedGroupId !== undefined) applyLocalGroupReviewed(reviewedGroupId)
}

function onCompareClose() {
  activeGroup.value = null
}

async function onCompareNext(reviewedGroupId: number) {
  applyLocalGroupReviewed(reviewedGroupId)
  // Pick the next still-unreviewed group from the (now optimistically
  // updated) cache. No refetch needed for the common case; the cache
  // self-heals on the next stack click via ensureGroupCache.
  const groups = groupCache.value ?? await ensureGroupCache()
  const next = groups.find((g) => !g.reviewed_at && g.id !== reviewedGroupId)
  activeGroup.value = next ?? null
}

// ── Upload ──────────────────────────────────────────────────────────────────
const uploading = ref(false)
const uploadAbortController = ref<AbortController | null>(null)
const uploadCurrent = ref(0)
const uploadTotal = ref(0)
const uploadProgress = ref(0)
const uploadSuccessCount = ref(0)
const uploadResultMessage = ref('')
const uploadErrors = ref<string[]>([])
const showErrorFlyout = ref(false)
const error = ref('')
const isDragging = ref(false)
let dragCounter = 0
let uploadResultTimeout: ReturnType<typeof setTimeout> | undefined

async function handleUpload(filesIn: FileList | File[]) {
  if (!canUpload.value) return
  const files = Array.from(filesIn)
  if (!files.length) return

  const abort = new AbortController()
  uploadAbortController.value = abort
  uploading.value = true
  error.value = ''
  uploadCurrent.value = 0
  uploadTotal.value = files.length
  uploadProgress.value = 0
  uploadSuccessCount.value = 0
  uploadResultMessage.value = ''
  uploadErrors.value = []
  if (uploadResultTimeout) {
    clearTimeout(uploadResultTimeout)
    uploadResultTimeout = undefined
  }

  const duplicates: string[] = []
  const unsupported: string[] = []
  const errors: string[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      if (abort.signal.aborted) break
      const file = files[i]!
      uploadCurrent.value = i + 1
      try {
        // Local SHA-256 + server check skips duplicates without uploading.
        const fileHash = await computeFileHash(file)
        if (fileHash && !abort.signal.aborted) {
          try {
            const { exists } = await checkPhotoHash(fileHash)
            if (exists) {
              duplicates.push(file.name)
              uploadProgress.value = Math.round(((i + 1) / files.length) * 100)
              continue
            }
          } catch {
            // Pre-check failure is non-fatal — fall through to actual upload.
          }
        }
        await uploadPhotoWithProgress(file, abort.signal, (loaded, total) => {
          const filePct = loaded / total
          uploadProgress.value = Math.round(((i + filePct) / files.length) * 100)
        })
        uploadSuccessCount.value++
      } catch (err: any) {
        if (abort.signal.aborted) break
        if (err.message?.includes('bereits hochgeladen')) duplicates.push(file.name)
        else if (err.message?.includes('nicht unterstützt')) unsupported.push(file.name)
        else errors.push(`${file.name}: ${err.message}`)
      }
    }

    // Refresh the gallery so newly uploaded photos appear.
    await galleryRef.value?.reload()

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
    const count = uploadSuccessCount.value
    if (count > 0 && !abort.signal.aborted) {
      uploadResultMessage.value =
        count === 1 ? '1 neues Foto hochgeladen' : `${count} neue Fotos hochgeladen`
      uploadResultTimeout = setTimeout(() => {
        uploadResultMessage.value = ''
      }, 8000)
    }
  } finally {
    uploading.value = false
    uploadAbortController.value = null
  }
}

function cancelUpload() {
  uploadAbortController.value?.abort()
}

function onFileInputChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    void handleUpload(input.files)
    // Reset so the same file can be picked again (browsers cache the
    // value of <input type=file>).
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

// ── Cursor + fullscreen state ───────────────────────────────────────────────
// `cursorIndex` is the single source of truth for which photo is "current"
// — it drives both the keyboard cursor highlight in the grid (slice 3c)
// and the photo shown in the fullscreen viewer (slice 3a) and the desktop
// detail sidebar (slice 3e). `cursorPhoto / cursorPrev / cursorNext` is
// the hydrated triple kept in sync via `hydrateCursor`. The triple is
// rebuilt on every cursor move (click, keyboard nav, fullscreen prev/next)
// so the desktop sidebar always reflects whatever the user last looked at.
// The `hydrateToken` cancels stale results when the user mashes nav faster
// than `getPhotoDetailsBatch` resolves — only the most-recent hydration
// wins.
const isFullscreen = ref(false)
const cursorIndex = ref<number | null>(null)
const cursorPhoto = ref<Photo | null>(null)
const cursorPrev = ref<Photo | null>(null)
const cursorNext = ref<Photo | null>(null)
let hydrateToken = 0
let curationVersion = 0

// ── Detail flyout state ─────────────────────────────────────────────────────
// Per-photo metadata loaded on top of the batch-hydrated `Photo`. Faces and
// landmarks are not part of the bulk details endpoint — they're fetched per
// photo when the sidebar opens (or the user advances to a neighbour). The
// `hydrateToken` from above gates these loaders too so a stale fetch from
// the previous photo can't overwrite the current one's lists.
const detailsActive = ref(false)
const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const isEditingDate = ref(false)
const editDate = ref<Date | null>(null)
const updatingDate = ref(false)

async function loadFacesAndLandmarks(photoId: number, token: number): Promise<void> {
  loadingFaces.value = true
  loadingLandmarks.value = true
  detectedFaces.value = []
  detectedLandmarks.value = []
  try {
    const [facesRes, landmarksRes] = await Promise.all([
      getPhotoFaces(photoId).catch(() => ({ faces: [] })),
      getPhotoLandmarks(photoId).catch(() => ({ landmarks: [] })),
    ])
    if (token !== hydrateToken) return
    detectedFaces.value = facesRes.faces ?? []
    detectedLandmarks.value = landmarksRes.landmarks ?? []
  } finally {
    if (token === hydrateToken) {
      loadingFaces.value = false
      loadingLandmarks.value = false
    }
  }
}

// Synthesize a minimal Photo from the grid entry. Used as a fallback when
// `getPhotoDetailsBatch` fails or returns nothing for an id — at least the
// overlay can still show the image and the curation icon. Date / location
// formatting will fall back to empty strings, which is harmless.
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

async function hydrateCursor(index: number, options?: { skipNeighbors?: boolean }): Promise<void> {
  if (!galleryRef.value) return
  const myToken = ++hydrateToken
  const total = galleryRef.value.getTotal()
  const skipNeighbors = options?.skipNeighbors ?? false

  const [curEntry, prevEntry, nextEntry] = await Promise.all([
    galleryRef.value.loadEntryAt(index),
    index > 0 && !skipNeighbors ? galleryRef.value.loadEntryAt(index - 1) : Promise.resolve(null),
    index + 1 < total && !skipNeighbors ? galleryRef.value.loadEntryAt(index + 1) : Promise.resolve(null),
  ])
  if (myToken !== hydrateToken) return
  if (!curEntry) {
    closeFullscreen()
    return
  }
  // Update shared navigation store and persist for cross-session restore.
  photoNav.selectPhoto(curEntry.id)
  try { localStorage.setItem(LAST_PHOTO_KEY, String(curEntry.id)) } catch { /* storage off */ }

  // Provisional render from the grid entry while the details call resolves.
  // Without this the overlay flashes empty for the network round-trip.
  cursorPhoto.value = entryToMinimalPhoto(curEntry)
  cursorPrev.value = prevEntry ? entryToMinimalPhoto(prevEntry) : null
  cursorNext.value = nextEntry ? entryToMinimalPhoto(nextEntry) : null

  // Cancel any in-progress date edit when the photo changes.
  isEditingDate.value = false

  // Faces / landmarks fire in parallel with the details batch — they hit
  // separate endpoints and the sidebar can render each independently.
  void loadFacesAndLandmarks(curEntry.id, myToken)

  const ids = [curEntry.id]
  if (prevEntry) ids.push(prevEntry.id)
  if (nextEntry) ids.push(nextEntry.id)
  const myCurationVersion = curationVersion
  try {
    const { photos } = await getPhotoDetailsBatch(ids)
    if (myToken !== hydrateToken) return
    const byId = new Map(photos.map((p) => [p.id, p]))
    // If curation was optimistically changed while the batch was in flight
    // (user pressed F/X faster than the round-trip), preserve the optimistic
    // curation_status so it isn't overwritten by stale server data (#309).
    const preserveCuration = curationVersion !== myCurationVersion
    const merge = (batch: Photo | undefined, cur: Photo | null): Photo | null => {
      if (!batch) return cur
      if (preserveCuration && cur) return { ...batch, curation_status: cur.curation_status }
      return batch
    }
    cursorPhoto.value = merge(byId.get(curEntry.id), cursorPhoto.value)
    cursorPrev.value = prevEntry
      ? merge(byId.get(prevEntry.id), cursorPrev.value)
      : null
    cursorNext.value = nextEntry
      ? merge(byId.get(nextEntry.id), cursorNext.value)
      : null
  } catch {
    // Fall back to the minimal photo objects we already set above.
  }
}

async function openFullscreenAt(index: number): Promise<void> {
  if (!galleryRef.value) return
  cursorIndex.value = index
  isFullscreen.value = true
  await hydrateCursor(index)
  galleryRef.value.scrollToIndex(index)
}

function closeFullscreen() {
  // Deliberately keep `cursorIndex / cursorPhoto / faces / landmarks`
  // around so the desktop sidebar continues showing the last-viewed
  // photo's details. Only the fullscreen-specific UI bits get reset.
  isFullscreen.value = false
  detailsActive.value = false
  isEditingDate.value = false
}

async function goPrev(): Promise<void> {
  if (cursorIndex.value === null || cursorIndex.value === 0) return
  const next = cursorIndex.value - 1
  cursorIndex.value = next
  await hydrateCursor(next)
  galleryRef.value?.scrollToIndex(next)
}

async function goNext(): Promise<void> {
  if (cursorIndex.value === null || !galleryRef.value) return
  const total = galleryRef.value.getTotal()
  if (cursorIndex.value + 1 >= total) return
  const next = cursorIndex.value + 1
  cursorIndex.value = next
  await hydrateCursor(next)
  galleryRef.value.scrollToIndex(next)
}

async function applyCurationToPhoto(id: number, target: CurationStatus): Promise<void> {
  // Optimistic write to grid + the three fullscreen slots that might hold
  // this id. If the network write fails we reload the source AND re-hydrate
  // the current fullscreen to undo the optimistic change.
  ++curationVersion
  galleryRef.value?.updateEntry(id, { curation: target })
  for (const r of [cursorPhoto, cursorPrev, cursorNext]) {
    if (r.value && r.value.id === id) {
      r.value = { ...r.value, curation_status: target }
    }
  }
  try {
    await updatePhotoCuration(id, target)
  } catch {
    await galleryRef.value?.reload()
    if (cursorIndex.value !== null) await hydrateCursor(cursorIndex.value)
  }
}

function onFullscreenToggleFavorite(id: number, currentStatus: CurationStatus) {
  void applyCurationToPhoto(id, currentStatus === 'favorite' ? 'visible' : 'favorite')
}
function onFullscreenHide(id: number) {
  void applyCurationToPhoto(id, 'hidden')
}
function onFullscreenRestore(id: number) {
  void applyCurationToPhoto(id, 'visible')
}

function onShowDetails() {
  detailsActive.value = !detailsActive.value
}

// ── Sidebar handlers (date edit, faces, reindex) ────────────────────────────
function onSidebarStartEditDate() {
  const photo = cursorPhoto.value
  if (!photo) return
  editDate.value = new Date(photo.taken_at || photo.created_at)
  isEditingDate.value = true
}

async function onSidebarUpdateDate() {
  const photo = cursorPhoto.value
  if (!photo || !editDate.value) return
  updatingDate.value = true
  try {
    const takenAt = editDate.value.toISOString()
    await updatePhotoDate(photo.id, takenAt)
    // Mutate the displayed photo so the topbar's date label reflects the new
    // value immediately. The sort order in the grid may now be stale; that's
    // acceptable until the next reload (filter / sort / search change).
    cursorPhoto.value = { ...photo, taken_at: takenAt }
    isEditingDate.value = false
  } catch (err: any) {
    error.value = err?.message ?? 'Fehler beim Aktualisieren des Datums.'
  } finally {
    updatingDate.value = false
  }
}

function onSidebarCancelEditDate() {
  isEditingDate.value = false
}

async function onSidebarIgnoreFace(faceId: number) {
  const photo = cursorPhoto.value
  if (!photo) return
  try {
    await ignoreFace(faceId)
    // Reload faces so the ignored one disappears from the list.
    await loadFacesAndLandmarks(photo.id, hydrateToken)
  } catch { /* keep silent — user can retry */ }
}

async function onSidebarReindex() {
  const photo = cursorPhoto.value
  if (!photo) return
  reindexingPhoto.value = true
  try {
    await reindexPhoto(photo.id)
    await loadFacesAndLandmarks(photo.id, hydrateToken)
  } catch { /* user can retry */ }
  finally { reindexingPhoto.value = false }
}

// ── Keyboard navigation across the grid ─────────────────────────────────────
// `cursorIndex` is declared in the cursor-state block above and is null
// until the user either restores a last-viewed photo (set by
// `onGalleryLoaded`) or presses an arrow key for the first time.
// VirtualGallery shows a soft ring around the matching cell.

function moveCursor(delta: number, byRow: boolean) {
  if (!galleryRef.value) return
  const total = galleryRef.value.getTotal()
  if (total === 0) return
  if (cursorIndex.value === null) {
    // First arrow press from a fresh session — drop the cursor on the first
    // cell rather than leaping `cols` rows on the very first ↓.
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
  // Hydrate so the desktop sidebar reflects the new cursor cell. The
  // hydrateToken cancels stale results when the user mashes the arrow
  // keys faster than the network responds.
  void hydrateCursor(next)
}

async function activateCursor() {
  if (cursorIndex.value === null || !galleryRef.value) return
  const idx = cursorIndex.value
  if (selectMode.value) {
    // In select mode Space/Enter toggles the selection of the cursor cell
    // rather than opening fullscreen — power users selecting a batch via
    // keyboard expect this.
    const entry = await galleryRef.value.loadEntryAt(idx)
    if (entry) onToggleSelect(entry)
    return
  }
  await openFullscreenAt(idx)
}

useGalleryKeyboard({
  // FullscreenOverlay owns its own ←/→/Esc/F/X/I/C window listeners (in
  // capture phase, with stopImmediatePropagation), so they don't reach
  // useGalleryKeyboard while fullscreen is open. We still block here for
  // the dialogs / compare view that DON'T own their keyboard handling.
  isBlocked: () => isFullscreen.value
    || activeGroup.value !== null
    || filterMenuOpen.value
    || sortMenuOpen.value
    || isEditingDate.value,
  onLeft: () => moveCursor(-1, false),
  onRight: () => moveCursor(+1, false),
  onUp: () => moveCursor(-1, true),
  onDown: () => moveCursor(+1, true),
  onSpace: () => { void activateCursor() },
  onExtra: (e) => {
    if (e.key === 'Enter') {
      // Enter on a regular button would already activate it — useGalleryKeyboard
      // skips this path when a button has focus, so we only get here when
      // focus is somewhere passive (body / the grid container).
      e.preventDefault()
      void activateCursor()
    }
  },
})

// ── Photo click → open fullscreen ───────────────────────────────────────────
async function onPhotoClick(entry: GalleryGridEntry) {
  if (!galleryRef.value) return
  const idx = galleryRef.value.findLoadedIndexById(entry.id)
  // The user just tapped a rendered cell, so the entry is in the loaded
  // window — the null guard is defensive only.
  if (idx === null) return
  cursorIndex.value = idx
  await openFullscreenAt(idx)
}

// ── Initial-load hook ───────────────────────────────────────────────────────
// Two jobs after the grid finishes its first load:
//   1. Honor an explicit `?photoId=` deeplink by opening fullscreen on it.
//   2. Otherwise, drop the cursor on the restored last-viewed photo and
//      hydrate it so the desktop sidebar shows that photo's details on
//      first paint (instead of the user having to click anything).
async function onGalleryLoaded() {
  if (!galleryRef.value) return
  if (pendingFullscreenId.value !== null) {
    const id = pendingFullscreenId.value
    pendingFullscreenId.value = null
    const idx = galleryRef.value.findLoadedIndexById(id)
    if (idx !== null) await openFullscreenAt(idx)
    return
  }
  if (initialAnchor.value !== null) {
    const idx = galleryRef.value.findLoadedIndexById(initialAnchor.value)
    if (idx !== null) {
      cursorIndex.value = idx
      // Mirror the goNext / goPrev pattern: hydrate first, then scroll.
      // Calling scrollToIndex synchronously straight after the gallery's
      // 'loaded' emit is too early — the TanStack virtualizer hasn't
      // measured its scroll element yet on a fresh mount (typical after
      // a hard refresh), so the scroll silently no-ops and the cursor
      // stays highlighted off-screen until the next user interaction.
      // Awaiting hydrate gives the virtualizer the frames it needs.
      await hydrateCursor(idx, { skipNeighbors: true })
      galleryRef.value?.scrollToIndex(idx)
    }
  }
}

// ── WebSocket: live curation updates from other clients (#344) ─────────────
useRealtimeEvent('photos', 'curation.changed', (ev) => {
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  const status = ev.payload.status as CurationStatus | undefined
  if (!status) return
  galleryRef.value?.updateEntry(photoId, { curation: status })
  for (const r of [cursorPhoto, cursorPrev, cursorNext]) {
    if (r.value && r.value.id === photoId) {
      r.value = { ...r.value, curation_status: status }
    }
  }
})

useRealtimeEvent('photos', 'metadata.changed', (ev) => {
  const photoId = Number(ev.resourceId)
  if (!Number.isFinite(photoId)) return
  const updates = ev.payload as Record<string, unknown>
  if (cursorPhoto.value?.id === photoId) {
    cursorPhoto.value = { ...cursorPhoto.value, ...updates }
  }
})

// ── Computed sort fields for VirtualGallery ─────────────────────────────────
const sortByForGallery = computed<GallerySortField>(() => sort.value.field as GallerySortField)
const sortDirForGallery = computed<GallerySortDir>(() => sort.value.direction as GallerySortDir)
</script>

<template>
  <div
    class="gallery-view"
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

    <!-- Subheader: title + actions -->
    <div class="subheader">
      <div class="header">
        <h1 class="title">Fotos</h1>
        <div class="actions">
          <Button
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
            v-if="jumpButton"
            :icon="jumpButton.icon"
            :label="jumpButton.label"
            size="small"
            severity="secondary"
            outlined
            @click="onJumpEnd"
          />
          <Button
            v-if="canManageData && totalUnreviewed > 0"
            :label="`Gruppen bearbeiten (${totalUnreviewed} offen)`"
            icon="pi pi-images"
            size="small"
            severity="success"
            @click="startGroupReview"
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
                @change="onFileInputChange"
              />
              <Button label="Hochladen" icon="pi pi-upload" as="span" size="small" />
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
        <Chip v-if="!isSortDefault" :label="sortChipLabel" removable @remove="onResetSort" />
      </div>
    </div>

    <FilterMenu
      v-if="filterMenuMounted"
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
    <Message
      v-if="error"
      severity="error"
      @close="error = ''; uploadErrors = []"
    >
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

    <!-- Upload success message -->
    <div v-if="uploadResultMessage && !uploading" class="upload-result-bar">
      <i class="pi pi-check-circle" />
      <span>{{ uploadResultMessage }}</span>
    </div>

    <!-- Delete progress bar (#299) -->
    <div v-if="deleteBusy" class="delete-progress-bar">
      <div class="delete-progress-bar__info">
        <i class="pi pi-spin pi-spinner" />
        <span>{{ deleteCount }} {{ deleteCount === 1 ? 'Foto' : 'Fotos' }} werden gelöscht…</span>
      </div>
      <div class="delete-progress-bar__track">
        <div class="delete-progress-bar__fill" />
      </div>
    </div>

    <!-- Grid + persistent desktop detail panel. On <768px the panel is
         hidden via CSS so the grid takes the full width and details
         remain reachable via the fullscreen flyout. -->
    <div class="content-row">
      <div class="grid-area">
        <VirtualGallery
          ref="galleryRef"
          :around-photo-id="initialAnchor"
          :filter="filter"
          :sort-by="sortByForGallery"
          :sort-dir="sortDirForGallery"
          :search-photo-ids="searchPhotoIds"
          :select-mode="selectMode"
          :selected-ids="selectedIds"
          :cursor-index="cursorIndex"
          @photo-click="onPhotoClick"
          @stack-click="onStackClick"
          @toggle-select="onToggleSelect"
          @loaded="onGalleryLoaded"
          @ends-changed="onEndsChanged"
        />
      </div>

      <!-- Desktop detail panel — same component as the fullscreen flyout
           but always visible on desktop, driven by the cursor cell. The
           reactive cursor → hydrate flow keeps it in sync with grid
           clicks, keyboard navigation, and fullscreen prev/next. -->
      <aside v-if="cursorPhoto" class="desktop-sidebar">
        <PhotoDetailSidebar
          :photo="cursorPhoto"
          :selected-photo-ids="selectMode && selectedCount > 1 ? Array.from(selectedIds) : undefined"
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
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          :location-menu-exclude-all-photos="true"
          @toggle-favorite="onFullscreenToggleFavorite"
          @hide="onFullscreenHide"
          @restore="onFullscreenRestore"
          @start-edit-date="onSidebarStartEditDate"
          @update-date="onSidebarUpdateDate"
          @cancel-edit-date="onSidebarCancelEditDate"
          @ignore-face="onSidebarIgnoreFace"
          @reindex="onSidebarReindex"
        />
      </aside>
    </div>

    <!-- Stack compare overlay -->
    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :all-photos="[]"
      :total-unreviewed="totalUnreviewed"
      @close="onCompareClose"
      @reviewed="onCompareReviewed"
      @next="onCompareNext"
    />

    <!-- Fullscreen viewer with detail-sidebar flyout. The ⓘ button (and the
         I keyboard shortcut) toggle `detailsActive`, which both flips the
         icon's active styling on the toolbar AND drives the slide-in
         animation of the flyout via FullscreenOverlay's CSS. The sidebar
         itself self-manages its album section (lazy-loads albums, owns
         pending changes); we only feed it the per-photo state. -->
    <FullscreenOverlay
      v-if="isFullscreen && cursorPhoto"
      :photo="cursorPhoto"
      :prev-photo="cursorPrev"
      :next-photo="cursorNext"
      :can-delete="canDelete"
      :details-active="detailsActive"
      @close="closeFullscreen"
      @prev="goPrev"
      @next="goNext"
      @toggle-favorite="onFullscreenToggleFavorite"
      @hide="onFullscreenHide"
      @restore="onFullscreenRestore"
      @show-details="onShowDetails"
    >
      <template #details-flyout>
        <PhotoDetailSidebar
          :photo="cursorPhoto"
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
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          :location-menu-exclude-all-photos="true"
          :in-flyout="true"
          @toggle-favorite="onFullscreenToggleFavorite"
          @hide="onFullscreenHide"
          @restore="onFullscreenRestore"
          @start-edit-date="onSidebarStartEditDate"
          @update-date="onSidebarUpdateDate"
          @cancel-edit-date="onSidebarCancelEditDate"
          @ignore-face="onSidebarIgnoreFace"
          @reindex="onSidebarReindex"
        />
      </template>
    </FullscreenOverlay>

    <!-- Selection action bar (mobile + desktop) -->
    <div v-if="selectMode" class="select-bar">
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
          v-if="selectedCount > 0 && canUpload"
          label="Alben"
          icon="pi pi-book"
          size="small"
          severity="secondary"
          @click="openAlbumDialog"
        />
        <Button
          v-if="selectedCount > 0 && canDelete"
          label="Favorit"
          icon="pi pi-heart"
          size="small"
          :disabled="curationBusy"
          @click="applyCurationToSelection('favorite')"
        />
        <Button
          v-if="selectedCount > 0 && canDelete"
          label="Ausblenden"
          icon="pi pi-eye-slash"
          size="small"
          severity="warn"
          :disabled="curationBusy"
          @click="applyCurationToSelection('hidden')"
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

    <!-- Mobile entry point for the album batch dialog. Reused on desktop
         too — the sidebar's "Alben bearbeiten" button still works, but
         on mobile (where the desktop sidebar is hidden) this is the only
         way to open it. -->
    <PhotoAlbumDialog
      v-model:visible="albumDialogVisible"
      :photo-ids="albumDialogPhotoIds"
    />

    <!-- Warning dialog: skipped photos after batch delete -->
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
.gallery-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

/* ── Content row: grid + persistent desktop sidebar ──────────────────── */
.content-row {
  display: flex;
  flex: 1;
  min-height: 0;          /* required so the nested VirtualGallery scroll
                             container actually scrolls instead of pushing
                             the row past the viewport */
}

.grid-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* Desktop detail panel — fixed width, scrolls independently of the grid.
   Hidden on mobile where the fullscreen flyout takes over. */
.desktop-sidebar {
  width: 380px;
  flex-shrink: 0;
  border-left: 1px solid var(--p-content-border-color, rgba(0, 0, 0, 0.08));
  background: var(--p-content-background, #fff);
  overflow-y: auto;
  overflow-x: hidden;
}

@media (max-width: 768px) {
  .desktop-sidebar { display: none; }
}

/* ── Subheader ─────────────────────────────────────────────────────────── */
.subheader {
  flex-shrink: 0;
  background: var(--p-content-background);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  padding: 0.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.title {
  font-size: 1.5em;
  font-weight: 600;
  margin: 0;
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

/* ── Drag overlay ─────────────────────────────────────────────────────── */
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

.drag-message .pi {
  font-size: 3rem;
}

/* ── Upload bars ──────────────────────────────────────────────────────── */
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
}
.upload-result-bar .pi-check-circle {
  color: var(--p-green-500);
}

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

/* ── Delete progress bar (#299) ───────────────────────────────────────── */
.delete-progress-bar {
  padding: 0.5rem 1rem;
  background: var(--p-red-50);
  border-bottom: 1px solid var(--p-red-200);
}
.delete-progress-bar__info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--p-red-700);
  margin-bottom: 0.35rem;
}
.delete-progress-bar__track {
  height: 4px;
  background: var(--p-red-100);
  border-radius: 2px;
  overflow: hidden;
}
.delete-progress-bar__fill {
  height: 100%;
  width: 100%;
  background: var(--p-red-500);
  border-radius: 2px;
  animation: delete-pulse 1.2s ease-in-out infinite;
}
@keyframes delete-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
.p-dark .delete-progress-bar {
  background: var(--p-red-900);
  border-color: var(--p-red-700);
}
.p-dark .delete-progress-bar__info { color: var(--p-red-200); }
.p-dark .delete-progress-bar__track { background: var(--p-red-800); }
.p-dark .delete-progress-bar__fill  { background: var(--p-red-400); }

.upload-button-label { display: inline-flex; cursor: pointer; }
.upload-input-hidden { display: none; }

/* ── Error flyout ─────────────────────────────────────────────────────── */
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

/* ── Selection action bar ─────────────────────────────────────────────── */
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

/* ── Mobile breakpoint ────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .subheader {
    padding: 0.375rem 0.75rem;
  }
  .title {
    font-size: 1.2rem;
  }
  /* Action buttons: icons only on small screens */
  .subheader .actions :deep(.p-button-label) { display: none; }
  .subheader .actions :deep(.p-button) {
    padding: 0.5rem;
    min-width: 2.25rem;
  }
  .select-bar {
    position: sticky;
    bottom: 0;
    z-index: 10;
  }
}
</style>
