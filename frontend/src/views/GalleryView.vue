<script setup lang="ts">
/**
 * Greenfield virtualized photo gallery — Phase 2.
 *
 * Adds filter / sort / search / selection / curation / upload / stack-compare
 * around the same `<VirtualGallery>` core that ships in Phase 1. None of these
 * features touch the grid until the user actually triggers them — applying
 * a filter, picking a sort, executing a search and uploading all run a single
 * `init` on the source; selection / curation / drag-drop are local state
 * until the user commits.
 *
 * Deliberately still missing (Phase 3):
 *   - fullscreen / detail sidebar (no per-photo metadata view yet)
 *   - keyboard navigation
 *   - per-photo actions other than batch curation in select mode
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Message from 'primevue/message'
import VirtualGallery from '../components/VirtualGallery.vue'
import FilterMenu from '../components/FilterMenu.vue'
import FilterChips from '../components/FilterChips.vue'
import SortMenu from '../components/SortMenu.vue'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import { useFilter } from '../composables/useFilter'
import { useSort, type SortField, type SortState } from '../composables/useSort'
import { useNaturalSearch } from '../composables/useNaturalSearch'
import { useAuthStore } from '../stores/auth'
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
  type PhotoGroup,
  type CurationStatus,
} from '../api/photos'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const canUpload = computed(() => auth.hasPermission('photos.upload'))
const canDelete = computed(() => auth.hasPermission('photos.delete'))

// Reuse the legacy view's localStorage key so users keep their
// last-selected position across both gallery implementations.
const LAST_PHOTO_KEY = 'photos_last_selected_id'

// ── Initial anchor (resolved once) ──────────────────────────────────────────
const initialPhotoId = computed<number | null>(() => {
  const q = Number(route.query.photoId)
  if (Number.isFinite(q) && q > 0) return q
  const s = Number(localStorage.getItem(LAST_PHOTO_KEY))
  if (Number.isFinite(s) && s > 0) return s
  return null
})
const initialAnchor = ref<number | null>(initialPhotoId.value)
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

// ── Stacks (compare view) ───────────────────────────────────────────────────
// Stack-cover taps in the grid open the compare view. We don't preload
// the user's full group list (that's an N-photo iteration in the legacy
// gallery); instead we fetch it on demand when the user actually opens a
// stack — typically once per session.
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

async function onCompareClose() {
  activeGroup.value = null
  // Group state may have changed (cover swap, review). Refresh group cache
  // and reload the gallery so badges / stack outlines reflect the new state.
  groupCache.value = null
  await galleryRef.value?.reload()
}

async function onCompareNext(reviewedGroupId: number) {
  // The user reviewed `reviewedGroupId`; pick the next unreviewed group
  // that isn't the same one. Group cache is invalidated to pick up any
  // server-side regrouping that happened after the review write.
  groupCache.value = null
  const groups = await ensureGroupCache()
  const next = groups.find((g) => !g.reviewed_at && g.id !== reviewedGroupId)
  if (next) {
    activeGroup.value = next
  } else {
    activeGroup.value = null
    await galleryRef.value?.reload()
  }
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

// ── Photo click (Phase 2: just remember selection for next visit) ───────────
function onPhotoClick(entry: GalleryGridEntry) {
  try {
    localStorage.setItem(LAST_PHOTO_KEY, String(entry.id))
  } catch { /* storage might be disabled */ }
}

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
        <h1 class="title">Meine Fotos</h1>
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
      @close="
        error = ''
        uploadErrors = []
      "
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

    <!-- The grid itself ------------------------------------------------------ -->
    <VirtualGallery
      ref="galleryRef"
      :around-photo-id="initialAnchor"
      :filter="filter"
      :sort-by="sortByForGallery"
      :sort-dir="sortDirForGallery"
      :search-photo-ids="searchPhotoIds"
      :select-mode="selectMode"
      :selected-ids="selectedIds"
      @photo-click="onPhotoClick"
      @stack-click="onStackClick"
      @toggle-select="onToggleSelect"
    />

    <!-- Stack compare overlay -->
    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :all-photos="[]"
      :total-unreviewed="totalUnreviewed"
      @close="onCompareClose"
      @next="onCompareNext"
    />

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
  </div>
</template>

<style scoped>
.gallery-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
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
