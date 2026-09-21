<script setup lang="ts">
import {onMounted, ref, computed, watch, nextTick} from 'vue'
import {useRouter, useRoute} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import SelectButton from 'primevue/selectbutton'
import Checkbox from 'primevue/checkbox'
import DateRangePresets from '../components/DateRangePresets.vue'
import VirtualAlbumGrid from '../components/VirtualAlbumGrid.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import type { FilterChip } from '../components/layout/listToolbar'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import type { SortField, SortState, UseSortReturn } from '../composables/useSort'
import {
  type Album,
  createAlbum,
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { usePhotoNavStore } from '../stores/photoNav'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useReferenceData } from '../composables/useReferenceData'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import { replaceQuerySlice, updateRouteQuery } from '../utils/routeQueryUpdate'
import {
  albumsStateToQuery,
  ALBUMS_STATE_QUERY_KEYS,
  DEFAULT_ALBUM_SORT,
  EMPTY_ALBUM_FILTER,
  hasAnyAlbumsFilterQueryParam,
  loadAlbumsStateFromStorage,
  parseAlbumsStateFromQuery,
  readRememberedAlbumId,
  rememberFocusedAlbumId,
  saveAlbumsStateToStorage,
  type AlbumDisplayFilter,
  type AlbumEmptyFilter,
  type AlbumFilter,
  type AlbumOwnerFilter,
  type AlbumsPersistedState,
} from '../utils/albumsViewState'
import ServiceStatusBar from "../components/ServiceStatusBar.vue";
import PageLayout from "../components/layout/PageLayout.vue";
import { saveListAnchor } from '../utils/listAnchor'
import type { ListAnchor } from '../utils/listAnchor'

// The list shares the app-wide cache with album pickers and filters. This
// avoids a second expensive request when the album route opens, while the
// view still owns its filter/sort presentation state.
const { albums, fetchAlbums, invalidateAlbums } = useReferenceData()

const loading = ref(true)
const error = ref('')
const auth = useAuthStore()
const photoNav = usePhotoNavStore()
// Creating an album hits POST /albums which the backend gates on
// `albums.manage`. Hide the entry button when the user is missing that
// permission so they don't get a 403 after clicking.
const canManageAlbums = computed(() => auth.hasPermission('albums.manage'))

// Shared with AlbumDetailView: when the user opens an album we remember it
// here, so navigating back from the detail view restores focus and scroll
// position to the album the user came from. The remembered ID is read once
// at mount; VirtualAlbumGrid handles the scroll-and-highlight as soon as
// data + layout settle.
// Falls back to photoNav.selectedAlbumId so in-session navigation from
// the gallery also highlights the correct album without needing a localStorage entry.
const rememberedAlbumId = ref<number | null>(readRememberedAlbumId() ?? photoNav.selectedAlbumId)
const gridRef = ref<InstanceType<typeof VirtualAlbumGrid> | null>(null)

/** This list's key for the anchor and the scroll offset (issue #1272, stage 4). */
const ANCHOR_KEY = 'fotos-alben'

function openAlbum(album: Album) {
  rememberFocusedAlbumId(album.id)
  saveListAnchor(ANCHOR_KEY, { kind: 'album', id: album.id })
  router.push(`/fotos/alben/${album.id}`)
}

/**
 * Put the user back on the album tile they opened. The grid is virtual, so
 * the tile usually is not in the DOM yet — `scrollToAlbum` finds its index,
 * scrolls there and focuses it, which is more than PageLayout could do with
 * an element, hence the `true`.
 *
 * `rememberedAlbumId` stays as it is: that one outlives the session and
 * highlights the last album when the list is entered fresh, which is a
 * different question from "where did I just come back from".
 */
function resolveAlbumAnchor(anchor: ListAnchor | null): boolean {
  if (!anchor || anchor.kind !== 'album') return false
  return gridRef.value?.scrollToAlbum(anchor.id, { highlight: true, focus: true }) ?? false
}

// The search term lives in `?q=` and is remembered for the session; the
// shared toolbar owns the input, the clear button and the `/` shortcut.
const search = useListSearch({
  placeholder: 'Alben filtern…',
  storageKey: 'albums.search',
})

// ── Album filter menu ────────────────────────────────────────────────────────
const appliedAlbumFilter = ref<AlbumFilter>({ ...EMPTY_ALBUM_FILTER })
const draftAlbumFilter = ref<AlbumFilter>({ ...EMPTY_ALBUM_FILTER })
const showAlbumFilterMenu = ref(false)
const draftDateFrom = ref<Date | null>(null)
const draftDateTo = ref<Date | null>(null)

const ownerOptions: Array<{ label: string; value: AlbumOwnerFilter }> = [
  { label: 'Alle', value: 'all' },
  { label: 'Eigene', value: 'mine' },
  { label: 'Geteilt mit mir', value: 'shared' },
]
const displayFilterOptions: Array<{ label: string; value: AlbumDisplayFilter }> = [
  { label: 'Alle', value: 'all' },
  { label: 'Ohne Karte', value: 'grid' },
  { label: 'Mit Karte', value: 'map' },
]
const emptyFilterOptions: Array<{ label: string; value: AlbumEmptyFilter }> = [
  { label: 'Alle', value: 'any' },
  { label: 'Nur leere', value: 'only' },
  { label: 'Ohne leere', value: 'exclude' },
]

const activeAlbumFilterCount = computed(() => {
  const f = appliedAlbumFilter.value
  let n = 0
  if (f.owner !== 'all') n++
  if (f.display !== 'all') n++
  if (f.dateFrom || f.dateTo) n++
  if (f.emptyMode !== 'any') n++
  if (f.sharedByMe || f.sharedWithMe) n++
  return n
})

function openAlbumFilterMenu() {
  draftAlbumFilter.value = { ...appliedAlbumFilter.value }
  draftDateFrom.value = appliedAlbumFilter.value.dateFrom ? parseLocalDate(appliedAlbumFilter.value.dateFrom) : null
  draftDateTo.value = appliedAlbumFilter.value.dateTo ? parseLocalDate(appliedAlbumFilter.value.dateTo) : null
  showAlbumFilterMenu.value = true
}

function applyAlbumFilter() {
  appliedAlbumFilter.value = {
    ...draftAlbumFilter.value,
    dateFrom: draftDateFrom.value ? toLocalIsoDate(draftDateFrom.value) : undefined,
    dateTo: draftDateTo.value ? toLocalIsoDate(draftDateTo.value) : undefined,
  }
  showAlbumFilterMenu.value = false
}

function resetAlbumFilter() {
  draftAlbumFilter.value = { ...EMPTY_ALBUM_FILTER }
  draftDateFrom.value = null
  draftDateTo.value = null
  appliedAlbumFilter.value = { ...EMPTY_ALBUM_FILTER }
}

/**
 * The applied album filter as the shared toolbar's removable chips. One chip
 * per criterion, in the same order the filter dialog lists them, so the chip
 * row and the "Filter (n)" badge always agree.
 */
function albumFilterChips(): FilterChip[] {
  const f = appliedAlbumFilter.value
  const chips: FilterChip[] = []
  if (f.owner !== 'all') {
    chips.push({
      key: 'owner',
      label: `Besitzer: ${f.owner === 'mine' ? 'Eigene' : 'Geteilt mit mir'}`,
      remove: () => { appliedAlbumFilter.value = { ...f, owner: 'all' } },
    })
  }
  if (f.display !== 'all') {
    chips.push({
      key: 'display',
      label: `Darstellung: ${f.display === 'grid' ? 'Ohne Karte' : 'Mit Karte'}`,
      remove: () => { appliedAlbumFilter.value = { ...f, display: 'all' } },
    })
  }
  if (f.dateFrom || f.dateTo) {
    chips.push({
      key: 'date',
      label: `Neuestes Foto: ${f.dateFrom ?? '…'} – ${f.dateTo ?? '…'}`,
      remove: () => { appliedAlbumFilter.value = { ...f, dateFrom: undefined, dateTo: undefined } },
    })
  }
  if (f.emptyMode !== 'any') {
    chips.push({
      key: 'emptyMode',
      label: `Leere Alben: ${f.emptyMode === 'only' ? 'Nur leere' : 'Ohne leere'}`,
      remove: () => { appliedAlbumFilter.value = { ...f, emptyMode: 'any' } },
    })
  }
  if (f.sharedByMe || f.sharedWithMe) {
    const parts: string[] = []
    if (f.sharedByMe) parts.push('von mir')
    if (f.sharedWithMe) parts.push('mit mir')
    chips.push({
      key: 'shared',
      label: `Geteilt: ${parts.join(' & ')}`,
      remove: () => { appliedAlbumFilter.value = { ...f, sharedByMe: false, sharedWithMe: false } },
    })
  }
  return chips
}

const albumFilterChipList = computed<FilterChip[]>(() => albumFilterChips())

function matchesAlbumFilter(album: Album, f: AlbumFilter): boolean {
  const userId = auth.user?.id
  if (f.owner === 'mine' && userId !== undefined && album.user_id !== userId) return false
  if (f.owner === 'shared' && (userId === undefined || album.user_id === userId)) return false
  if (f.display !== 'all' && album.display_mode !== f.display) return false
  if (f.emptyMode === 'only' && album.photo_count > 0) return false
  if (f.emptyMode === 'exclude' && album.photo_count === 0) return false
  if (f.sharedByMe || f.sharedWithMe) {
    const ownedByMe = userId !== undefined && album.user_id === userId
    const isSharedByMe = ownedByMe && !!album.is_shared
    const isSharedWithMe = userId !== undefined && album.user_id !== userId
    const match = (f.sharedByMe && isSharedByMe) || (f.sharedWithMe && isSharedWithMe)
    if (!match) return false
  }
  if (f.dateFrom || f.dateTo) {
    const newest = album.newest_photo_at ? new Date(album.newest_photo_at).getTime() : 0
    if (!newest) return false
    if (f.dateFrom && newest < new Date(f.dateFrom).getTime()) return false
    if (f.dateTo) {
      // +1 day to make dateTo inclusive
      const end = new Date(f.dateTo).getTime() + 86400000
      if (newest >= end) return false
    }
  }
  return true
}

// ── Album sort menu ──────────────────────────────────────────────────────────
const ALBUM_SORT_FIELDS: SortField[] = [
  { value: 'newest_photo_at', label: 'Neuestes Foto' },
  { value: 'name', label: 'Name' },
  { value: 'created_at', label: 'Erstellungsdatum' },
  { value: 'photo_count', label: 'Foto-Anzahl' },
]
const appliedAlbumSort = ref<SortState>({ ...DEFAULT_ALBUM_SORT })
const draftAlbumSort = ref<SortState>({ ...DEFAULT_ALBUM_SORT })

const isAlbumSortDefault = computed(() =>
  appliedAlbumSort.value.field === DEFAULT_ALBUM_SORT.field &&
  appliedAlbumSort.value.direction === DEFAULT_ALBUM_SORT.direction
)
const albumSortFieldLabel = computed(() =>
  ALBUM_SORT_FIELDS.find(f => f.value === appliedAlbumSort.value.field)?.label ?? appliedAlbumSort.value.field
)

/**
 * The shared toolbar's sort contract, served from this view's own state.
 *
 * `useSort` is not used here on purpose: the album sort travels in the URL
 * *and* in localStorage together with the filter, and `utils/albumsViewState`
 * owns that serialization so AlbumDetailView can rebuild the same query when
 * navigating back. This adapter hands the toolbar the same shape without a
 * second writer for `sortBy`/`sortDir`.
 */
const albumSort: UseSortReturn = {
  fields: ALBUM_SORT_FIELDS,
  applied: appliedAlbumSort,
  draft: draftAlbumSort,
  isDefault: isAlbumSortDefault,
  fieldLabel: albumSortFieldLabel,
  openEdit: () => { draftAlbumSort.value = { ...appliedAlbumSort.value } },
  apply: () => { appliedAlbumSort.value = { ...draftAlbumSort.value } },
  reset: () => {
    draftAlbumSort.value = { ...DEFAULT_ALBUM_SORT }
    appliedAlbumSort.value = { ...DEFAULT_ALBUM_SORT }
  },
  // Picking the active field again flips the direction — same gesture as
  // every other list.
  select: (field: string) => {
    const direction = appliedAlbumSort.value.field === field
      ? (appliedAlbumSort.value.direction === 'asc' ? 'desc' : 'asc')
      : DEFAULT_ALBUM_SORT.direction
    draftAlbumSort.value = { field, direction }
    appliedAlbumSort.value = { field, direction }
  },
}

function compareAlbumsByField(a: Album, b: Album, field: string): number {
  switch (field) {
    case 'newest_photo_at': {
      const da = a.newest_photo_at ? new Date(a.newest_photo_at).getTime() : 0
      const db = b.newest_photo_at ? new Date(b.newest_photo_at).getTime() : 0
      return da - db
    }
    case 'created_at': {
      const da = a.created_at ? new Date(a.created_at).getTime() : 0
      const db = b.created_at ? new Date(b.created_at).getTime() : 0
      return da - db
    }
    case 'photo_count':
      return (a.photo_count ?? 0) - (b.photo_count ?? 0)
    case 'name':
      return a.name.localeCompare(b.name)
    default:
      return 0
  }
}

const sortedAlbums = computed(() => {
  const { field, direction } = appliedAlbumSort.value
  const mult = direction === 'asc' ? 1 : -1
  return [...albums.value].sort((a, b) => {
    const primary = mult * compareAlbumsByField(a, b, field)
    if (primary !== 0) return primary
    return a.name.localeCompare(b.name)
  })
})

const filteredAlbums = computed(() => {
  const q = search.term.value.trim().toLocaleLowerCase()
  const f = appliedAlbumFilter.value
  return sortedAlbums.value.filter(album => {
    if (q) {
      const nameMatch = album.name.toLocaleLowerCase().includes(q)
      const descMatch = album.description?.toLocaleLowerCase().includes(q) ?? false
      if (!nameMatch && !descMatch) return false
    }
    return matchesAlbumFilter(album, f)
  })
})

// VirtualAlbumGrid handles its own scroll-and-highlight when albums + layout
// settle, using the `rememberedAlbumId` prop. No additional focus/scroll
// orchestration needed at the view level.

const showCreateDialog = ref(false)
const newAlbumName = ref('')
const newAlbumDesc = ref('')
const newAlbumMapEnabled = ref(false)
const creating = ref(false)

const router = useRouter()
const route = useRoute()

// ── Sticky filter/sort/search persistence ────────────────────────────────────
// Filter state survives:
//   - hard reloads (URL query params)
//   - menu navigation /fotos/alben → /fotos/galerie → /fotos/alben (localStorage)
//   - cross-tab navigation (localStorage)
// On mount: URL takes priority for deep-linking; falls back to localStorage.
// On change: writes to BOTH URL and localStorage so either entry point recovers.
//
// The serialization helpers live in utils/albumsViewState so AlbumDetailView
// can reuse them when navigating back — without that, leaving an album would
// land on `/fotos/alben` (no query) and the user would briefly see an
// unfiltered list before AlbumsView re-applied state from localStorage.

function currentState(): AlbumsPersistedState {
  return {
    filter: { ...appliedAlbumFilter.value },
    sort: { ...appliedAlbumSort.value },
  }
}

async function persistState() {
  const state = currentState()
  saveAlbumsStateToStorage(state)
  // Only the keys this view owns are rewritten — `q` belongs to
  // `useListSearch` and must survive a filter or sort change.
  await updateRouteQuery(router, (current) =>
    replaceQuerySlice(current, ALBUMS_STATE_QUERY_KEYS, albumsStateToQuery(state)),
  )
}

async function loadData(force = false) {
  // Don't toggle `loading` to true on subsequent calls — only the initial
  // fetch needs the spinner state. Refreshes (after rename / delete /
  // realtime events) replace `albums.value` in place, so VirtualAlbumGrid
  // stays mounted and the virtualizer keeps its scroll position. Without
  // this guard, editing an album's description would unmount the grid and
  // snap the user back to the top of the list.
  try {
    await fetchAlbums(force)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Alben'
  } finally {
    loading.value = false
  }
}

async function handleCreateAlbum() {
  if (!newAlbumName.value.trim()) return
  creating.value = true
  try {
    const album = await createAlbum(
      newAlbumName.value.trim(),
      newAlbumDesc.value.trim() || undefined,
      newAlbumMapEnabled.value ? 'map' : 'grid',
    )
    invalidateAlbums()
    showCreateDialog.value = false
    newAlbumName.value = ''
    newAlbumDesc.value = ''
    newAlbumMapEnabled.value = false
    await loadData()
    router.push(`/fotos/alben/${album.id}`)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des Albums'
  } finally {
    creating.value = false
  }
}


// Refresh the album list when someone shares a new album with us — the
// backend fires `albums.shared` only to the sharee, so receiving this
// event is a reliable cue that our list is stale.
useRealtimeEvent('albums', 'shared', () => {
  void loadData(true)
})

// A participant left an album share — refresh so the album disappears for
// the leaver and the owner's share indicators stay current.
useRealtimeEvent('albums', 'unshared', () => {
  void loadData(true)
})

// New photos added to any visible album — the list view only shows
// cover + count, so refresh so the count/cover stays current.
useRealtimeEvent('albums', 'photo_added', (ev) => {
  const albumId = Number(ev.resourceId)
  if (!Number.isFinite(albumId)) return
  if (!albums.value.some((a) => a.id === albumId)) return
  void loadData(true)
})

// Initialize filter/sort/search before loadData so the restored state is
// ready when data arrives. URL params win for deep-linking; otherwise we
// fall back to whatever the user had configured last (localStorage).
{
  const initial = hasAnyAlbumsFilterQueryParam(route.query as Record<string, unknown>)
    ? parseAlbumsStateFromQuery(route.query as Record<string, unknown>)
    : loadAlbumsStateFromStorage()
  appliedAlbumFilter.value = initial.filter
  draftAlbumFilter.value = { ...initial.filter }
  appliedAlbumSort.value = initial.sort
  draftAlbumSort.value = { ...initial.sort }
  // Mirror the restored state to the URL so a copy-paste or share of the
  // address bar shows the same filters the view is rendering.
  void persistState()
}

// Keep URL + localStorage in sync whenever the applied state changes.
watch(appliedAlbumFilter, () => persistState(), { deep: true })
watch(appliedAlbumSort, () => persistState(), { deep: true })

// Whenever the filter / sort / search-query changes, the visible album
// set changes. `useVirtualizer` keeps its scroll offset in absolute
// pixels, so a shrunk-then-restored list (user types into the filter and
// then clears it) leaves the user clamped at the top with the
// previously-selected album well out of view. Hand control back to the
// grid so it re-anchors on the remembered album. Run after Vue applies
// the new `filteredAlbums` so the row math sees the new layout.
watch([appliedAlbumFilter, appliedAlbumSort, search.term], async () => {
  await nextTick()
  await gridRef.value?.rescrollToRemembered({ highlight: false })
}, { deep: true })

// Declared last: `useListToolbar` reads the refs eagerly, so everything it
// points at has to exist by now.
const toolbar = useListToolbar({
  search,
  filter: {
    chips: albumFilterChipList,
    activeCount: activeAlbumFilterCount,
    open: openAlbumFilterMenu,
    clearAll: resetAlbumFilter,
  },
  sort: albumSort,
  result: {
    loaded: () => filteredAlbums.value.length,
    total: () => albums.value.length,
    loading: () => loading.value,
  },
})

onMounted(async () => {
  // If the user had selected a photo inside an album and then navigated to the
  // gallery, the first visit back to Albums should jump directly into that album
  // (the photo selection is restored there via photoNav.selectedPhotoId).
  // On subsequent visits the flag is false and we just show the list with the
  // album highlighted.
  if (photoNav.consumeAlbumJump() && photoNav.selectedAlbumId !== null) {
    // Persist the album so VirtualAlbumGrid highlights it when the user comes
    // back from the album detail to this list.
    rememberFocusedAlbumId(photoNav.selectedAlbumId)
    router.push(`/fotos/alben/${photoNav.selectedAlbumId}`)
    return
  }
  await loadData()
})
</script>

<template>
  <PageLayout
    title="Meine Alben"
    scroll="self"
    width="full"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
    :resolve-anchor="resolveAlbumAnchor"
  >
    <template #actions>
      <Button v-if="canManageAlbums" label="Neues Album" icon="pi pi-plus" @click="showCreateDialog = true"/>
    </template>

    <!-- Sticky part (lifted into the app stack by PageLayout): the shared
         list toolbar with search, filter, sort, chips and the result count. -->
    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <!-- Service status warning bar -->
      <ServiceStatusBar />
      <ErrorBanner v-if="error" :message="error" closable @retry="loadData(true)" @close="error = ''" />
    </template>

    <PageSkeleton v-if="loading && albums.length === 0" variant="grid" :count="8" />
    <EmptyState
      v-else-if="filteredAlbums.length === 0"
      icon="pi pi-images"
      :title="albums.length === 0 ? 'Noch keine Alben vorhanden' : 'Keine Alben passen zur Suche'"
      :message="albums.length === 0
        ? 'Erstelle dein erstes Album, um Fotos zu sammeln.'
        : 'Ein anderer Suchbegriff oder weniger Filter finden vielleicht mehr.'"
      :filtered="activeAlbumFilterCount > 0"
      @clear-filters="resetAlbumFilter"
    >
      <template #action>
        <Button
          v-if="albums.length === 0 && canManageAlbums"
          label="Neues Album"
          icon="pi pi-plus"
          size="small"
          @click="showCreateDialog = true"
        />
      </template>
    </EmptyState>

    <VirtualAlbumGrid
      v-else
      ref="gridRef"
      :albums="filteredAlbums"
      :rememberedAlbumId="rememberedAlbumId"
      @open="openAlbum"
    />

    <Dialog v-model:visible="showCreateDialog" header="Neues Album erstellen" :modal="true">
      <div class="dialog-content">
        <label for="albumName">Name des Albums</label>
        <InputText id="albumName" v-model="newAlbumName" autofocus @keydown.enter="handleCreateAlbum"/>
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label for="albumDesc">Beschreibung</label>
        <textarea id="albumDesc" v-model="newAlbumDesc" rows="2" class="p-inputtextarea p-inputtext" style="width: 100%"></textarea>
      </div>
      <div class="dialog-content map-toggle-row" style="margin-top: 0.5rem">
        <Checkbox v-model="newAlbumMapEnabled" inputId="newAlbumMapEnabled" :binary="true" />
        <label for="newAlbumMapEnabled">Karte aktivieren</label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showCreateDialog = false"/>
        <Button label="Erstellen" :loading="creating" @click="handleCreateAlbum"/>
      </template>
    </Dialog>

    <!-- Album filter dialog -->
    <Dialog v-model:visible="showAlbumFilterMenu" header="Filter" modal :style="{ width: 'min(100%, 560px)' }">
      <div class="album-filter-menu">
        <div class="afm-row">
          <label class="afm-label">Besitzer</label>
          <SelectButton
            v-model="draftAlbumFilter.owner"
            :options="ownerOptions" option-label="label" option-value="value"
            :allow-empty="false"
          />
        </div>
        <div class="afm-row">
          <label class="afm-label">Darstellung</label>
          <SelectButton
            v-model="draftAlbumFilter.display"
            :options="displayFilterOptions" option-label="label" option-value="value"
            :allow-empty="false"
          />
        </div>
        <div class="afm-row">
          <label class="afm-label">Leere Alben</label>
          <SelectButton
            v-model="draftAlbumFilter.emptyMode"
            :options="emptyFilterOptions" option-label="label" option-value="value"
            :allow-empty="false"
          />
        </div>
        <div class="afm-row">
          <label class="afm-label">Geteilt</label>
          <div class="afm-checks">
            <div class="afm-check">
              <Checkbox v-model="draftAlbumFilter.sharedByMe" input-id="sharedByMe" binary />
              <label for="sharedByMe">Von mir geteilt</label>
            </div>
            <div class="afm-check">
              <Checkbox v-model="draftAlbumFilter.sharedWithMe" input-id="sharedWithMe" binary />
              <label for="sharedWithMe">Mit mir geteilt</label>
            </div>
          </div>
        </div>
        <div class="afm-row">
          <label class="afm-label">Datum (neuestes Foto)</label>
          <DateRangePresets v-model:from="draftDateFrom" v-model:to="draftDateTo" />
        </div>
      </div>
      <template #footer>
        <Button label="Zurücksetzen" text severity="secondary" @click="resetAlbumFilter" />
        <Button label="Abbrechen" text @click="showAlbumFilterMenu = false" />
        <Button label="Anwenden" icon="pi pi-check" @click="applyAlbumFilter" />
      </template>
    </Dialog>

  </PageLayout>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5em;
}

.dialog-content.map-toggle-row label {
  cursor: pointer;
}

/* Page frame and title: PageLayout (issue #1272). The VirtualAlbumGrid is
   the scroll container inside PageLayout's `.page-content`. */

.album-filter-menu { display: flex; flex-direction: column; gap: 1rem; }
.afm-row { display: flex; flex-direction: column; gap: 0.5rem; }
.afm-label { font-weight: 500; font-size: 0.9rem; color: var(--p-text-muted-color); }
.afm-checks { display: flex; gap: 1rem; flex-wrap: wrap; }
.afm-check { display: flex; align-items: center; gap: 0.5rem; }

/* Album card / cover / info / actions styles live in VirtualAlbumGrid. */
</style>
