<script setup lang="ts">
import {onMounted, ref, computed, watch} from 'vue'
import {useRouter, useRoute} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import Chip from 'primevue/chip'
import DateRangePresets from '../components/DateRangePresets.vue'
import SortMenu from '../components/SortMenu.vue'
import VirtualAlbumGrid from '../components/VirtualAlbumGrid.vue'
import type { SortField, SortState } from '../composables/useSort'
import {
  type Album,
  type AlbumAccessLevel,
  type AlbumShareWithUser,
  type AlbumPublicLink,
  type PublicLinkExpiry,
  createAlbum, listAlbums, updateAlbum, deleteAlbum,
  getAlbumShares, shareAlbum, removeAlbumShare,
  createAlbumPublicLink, deleteAlbumPublicLink,
} from '../api/photos'
import { listUsers, type UserWithRoles } from '../api/users'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useReferenceData } from '../composables/useReferenceData'
import {
  albumsStateToQuery,
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

// Wir behalten die View-eigene Albumliste (eigene Sortier-/Filter-Logik),
// invalidieren aber nach jeder Mutation den app-weiten Cache, damit die
// Foto-Galerie beim nächsten Öffnen nicht auf eine veraltete Liste schaut.
const { invalidateAlbums } = useReferenceData()

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')
const auth = useAuthStore()

// Shared with AlbumDetailView: when the user opens an album we remember it
// here, so navigating back from the detail view restores focus and scroll
// position to the album the user came from. The remembered ID is read once
// at mount; VirtualAlbumGrid handles the scroll-and-highlight as soon as
// data + layout settle.
const rememberedAlbumId = ref<number | null>(readRememberedAlbumId())

function openAlbum(album: Album) {
  rememberFocusedAlbumId(album.id)
  router.push(`/fotos/alben/${album.id}`)
}

const filterQuery = ref('')

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
  { label: 'Raster', value: 'grid' },
  { label: 'Karte', value: 'map' },
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
  draftDateFrom.value = appliedAlbumFilter.value.dateFrom ? new Date(appliedAlbumFilter.value.dateFrom) : null
  draftDateTo.value = appliedAlbumFilter.value.dateTo ? new Date(appliedAlbumFilter.value.dateTo) : null
  showAlbumFilterMenu.value = true
}

function applyAlbumFilter() {
  appliedAlbumFilter.value = {
    ...draftAlbumFilter.value,
    dateFrom: draftDateFrom.value ? draftDateFrom.value.toISOString().slice(0, 10) : undefined,
    dateTo: draftDateTo.value ? draftDateTo.value.toISOString().slice(0, 10) : undefined,
  }
  showAlbumFilterMenu.value = false
}

function resetAlbumFilter() {
  draftAlbumFilter.value = { ...EMPTY_ALBUM_FILTER }
  draftDateFrom.value = null
  draftDateTo.value = null
  appliedAlbumFilter.value = { ...EMPTY_ALBUM_FILTER }
}

function albumFilterChips(): Array<{ label: string; clear: () => void }> {
  const f = appliedAlbumFilter.value
  const chips: Array<{ label: string; clear: () => void }> = []
  if (f.owner !== 'all') {
    chips.push({
      label: f.owner === 'mine' ? 'Eigene' : 'Geteilt mit mir',
      clear: () => { appliedAlbumFilter.value = { ...f, owner: 'all' } },
    })
  }
  if (f.display !== 'all') {
    chips.push({
      label: f.display === 'grid' ? 'Darstellung: Raster' : 'Darstellung: Karte',
      clear: () => { appliedAlbumFilter.value = { ...f, display: 'all' } },
    })
  }
  if (f.dateFrom || f.dateTo) {
    chips.push({
      label: `Neuestes ${f.dateFrom ?? '…'} – ${f.dateTo ?? '…'}`,
      clear: () => { appliedAlbumFilter.value = { ...f, dateFrom: undefined, dateTo: undefined } },
    })
  }
  if (f.emptyMode !== 'any') {
    chips.push({
      label: f.emptyMode === 'only' ? 'Nur leere Alben' : 'Ohne leere Alben',
      clear: () => { appliedAlbumFilter.value = { ...f, emptyMode: 'any' } },
    })
  }
  if (f.sharedByMe || f.sharedWithMe) {
    const parts: string[] = []
    if (f.sharedByMe) parts.push('von mir')
    if (f.sharedWithMe) parts.push('mit mir')
    chips.push({
      label: `Geteilt: ${parts.join(' & ')}`,
      clear: () => { appliedAlbumFilter.value = { ...f, sharedByMe: false, sharedWithMe: false } },
    })
  }
  return chips
}

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
const showAlbumSortMenu = ref(false)

const isAlbumSortDefault = computed(() =>
  appliedAlbumSort.value.field === DEFAULT_ALBUM_SORT.field &&
  appliedAlbumSort.value.direction === DEFAULT_ALBUM_SORT.direction
)
const albumSortFieldLabel = computed(() =>
  ALBUM_SORT_FIELDS.find(f => f.value === appliedAlbumSort.value.field)?.label ?? appliedAlbumSort.value.field
)
const albumSortChipLabel = computed(() =>
  `Sortierung: ${albumSortFieldLabel.value} ${appliedAlbumSort.value.direction === 'asc' ? '↑' : '↓'}`
)

function openAlbumSortMenu() {
  draftAlbumSort.value = { ...appliedAlbumSort.value }
  showAlbumSortMenu.value = true
}
function applyAlbumSort() {
  appliedAlbumSort.value = { ...draftAlbumSort.value }
  showAlbumSortMenu.value = false
}
function resetAlbumSort() {
  draftAlbumSort.value = { ...DEFAULT_ALBUM_SORT }
  appliedAlbumSort.value = { ...DEFAULT_ALBUM_SORT }
  showAlbumSortMenu.value = false
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
  const q = filterQuery.value.trim().toLocaleLowerCase()
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
const newAlbumDisplayMode = ref<'grid' | 'map'>('grid')
const creating = ref(false)
const showRenameDialog = ref(false)
const showDeleteDialog = ref(false)
const renameValue = ref('')
const renameDesc = ref('')
const renameDisplayMode = ref<'grid' | 'map'>('grid')
const updatingAlbum = ref(false)
const selectedAlbum = ref<Album | null>(null)

const displayModeOptions = [
  { label: 'Raster', value: 'grid' },
  { label: 'Karte', value: 'map' },
]

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
    searchQuery: filterQuery.value,
  }
}

let syncingUrl = false
async function persistState() {
  const state = currentState()
  saveAlbumsStateToStorage(state)
  if (syncingUrl) return
  syncingUrl = true
  try {
    const next = albumsStateToQuery(state)
    if (JSON.stringify(next) !== JSON.stringify(route.query)) {
      await router.replace({ query: next })
    }
  } finally {
    syncingUrl = false
  }
}

async function loadData() {
  loading.value = true
  try {
    const res = await listAlbums()
    albums.value = res.albums
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
    const album = await createAlbum(newAlbumName.value.trim(), newAlbumDesc.value.trim() || undefined, newAlbumDisplayMode.value)
    invalidateAlbums()
    showCreateDialog.value = false
    newAlbumName.value = ''
    newAlbumDesc.value = ''
    newAlbumDisplayMode.value = 'grid'
    await loadData()
    router.push(`/fotos/alben/${album.id}`)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des Albums'
  } finally {
    creating.value = false
  }
}

function canManageAlbum(album: Album) {
  return auth.user?.id === album.user_id
}

function canShareAlbum(album: Album) {
  if (auth.user?.id === album.user_id) return true
  return album.my_access_level === 'write_share'
}

function openRenameDialog(album: Album) {
  selectedAlbum.value = album
  renameValue.value = album.name
  renameDesc.value = album.description || ''
  renameDisplayMode.value = album.display_mode ?? 'grid'
  showRenameDialog.value = true
}

function openDeleteDialog(album: Album) {
  selectedAlbum.value = album
  showDeleteDialog.value = true
}

async function handleRenameAlbum() {
  if (!selectedAlbum.value) return
  const newName = renameValue.value.trim()
  if (!newName) return

  updatingAlbum.value = true
  try {
    await updateAlbum(selectedAlbum.value.id, { name: newName, description: renameDesc.value.trim(), displayMode: renameDisplayMode.value })
    invalidateAlbums()
    showRenameDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Umbenennen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

async function handleDeleteAlbum() {
  if (!selectedAlbum.value) return

  updatingAlbum.value = true
  try {
    await deleteAlbum(selectedAlbum.value.id)
    invalidateAlbums()
    showDeleteDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

// ── Album sharing ─────────────────────────────────────────────────────────────
const showShareDialog = ref(false)
const shareAlbumId = ref<number>(0)
const shareAlbumOwnerId = ref<number>(0)
const albumSharesList = ref<AlbumShareWithUser[]>([])
const allUsers = ref<UserWithRoles[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<AlbumAccessLevel>('read')
const shareAlbumIsOwner = ref(false)
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
const OWNER_ACCESS_LEVEL_OPTIONS: Array<{ label: string; value: AlbumAccessLevel }> = [
  { label: 'Nur lesen', value: 'read' },
  { label: 'Bearbeiten', value: 'write' },
  { label: 'Bearbeiten + Teilen', value: 'write_share' },
]
// Delegated sharers must not grant write_share themselves — that would
// let every invitee extend the chain and the owner would lose control.
const DELEGATE_ACCESS_LEVEL_OPTIONS: Array<{ label: string; value: AlbumAccessLevel }> =
  OWNER_ACCESS_LEVEL_OPTIONS.filter(o => o.value !== 'write_share')

const accessLevelOptions = computed(() =>
  shareAlbumIsOwner.value ? OWNER_ACCESS_LEVEL_OPTIONS : DELEGATE_ACCESS_LEVEL_OPTIONS
)

function canRemoveShare(share: AlbumShareWithUser) {
  if (shareAlbumIsOwner.value) return true
  // Delegates may only revoke invitations they created themselves.
  return share.invited_by_user_id === auth.user?.id
}

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumSharesList.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  const ownerId = shareAlbumOwnerId.value
  // The album owner is not in album_shares (they own it), so they would
  // otherwise slip through sharedIds and appear as an invitable user. The
  // current user is excluded too — you can't share with yourself.
  return allUsers.value.filter(u =>
    u.id !== currentUserId && u.id !== ownerId && !sharedIds.has(u.id)
  )
})

async function openShareDialog(album: Album) {
  shareAlbumId.value = album.id
  shareAlbumOwnerId.value = album.user_id
  shareAlbumIsOwner.value = auth.user?.id === album.user_id
  showShareDialog.value = true
  loadingShares.value = true
  try {
    const [sharesRes, usersRes] = await Promise.all([
      getAlbumShares(album.id),
      auth.hasPermission('users.list') ? listUsers() : Promise.resolve({ users: [] }),
    ])
    albumSharesList.value = sharesRes.shares
    publicLink.value = sharesRes.publicLink ?? null
    allUsers.value = usersRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Freigaben'
  } finally {
    loadingShares.value = false
  }
}

function syncAlbumIsShared() {
  const album = albums.value.find(a => a.id === shareAlbumId.value)
  if (album) {
    album.is_shared = albumSharesList.value.length > 0
  }
}

async function handleShare() {
  if (!shareUserId.value) return
  sharing.value = true
  try {
    await shareAlbum(shareAlbumId.value, shareUserId.value, shareAccessLevel.value)
    albumSharesList.value = (await getAlbumShares(shareAlbumId.value)).shares
    syncAlbumIsShared()
    shareUserId.value = null
    shareAccessLevel.value = 'read'
  } catch (err: any) { error.value = err.message || 'Fehler beim Freigeben' }
  finally { sharing.value = false }
}

async function handleRemoveShare(userId: number) {
  try {
    await removeAlbumShare(shareAlbumId.value, userId)
    albumSharesList.value = albumSharesList.value.filter(s => s.user_id !== userId)
    syncAlbumIsShared()
  } catch (err: any) { error.value = err.message || 'Fehler' }
}

function getPublicLinkUrl() {
  if (!publicLink.value) return ''
  return `${window.location.origin}${import.meta.env.BASE_URL}albums/shared/${publicLink.value.token}`
}

async function handleCreatePublicLink() {
  try {
    publicLink.value = await createAlbumPublicLink(shareAlbumId.value, (linkExpiry.value as PublicLinkExpiry) ?? undefined)
    await copyPublicLink()
  } catch (err: any) { error.value = err.message || 'Fehler beim Erstellen des Links' }
}

async function handleDeletePublicLink() {
  try {
    await deleteAlbumPublicLink(shareAlbumId.value)
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

function formatExpiryDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (date < new Date()) return 'Abgelaufen'
  return `Gültig bis ${date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}`
}

const isLinkExpired = computed(() => {
  if (!publicLink.value?.expires_at) return false
  return new Date(publicLink.value.expires_at) < new Date()
})

// Refresh the album list when someone shares a new album with us — the
// backend fires `albums.shared` only to the sharee, so receiving this
// event is a reliable cue that our list is stale.
useRealtimeEvent('albums', 'shared', () => {
  loadData()
})

// A participant left an album share — refresh so the album disappears for
// the leaver and the owner's share indicators stay current.
useRealtimeEvent('albums', 'unshared', () => {
  loadData()
})

// New photos added to any visible album — the list view only shows
// cover + count, so refresh so the count/cover stays current.
useRealtimeEvent('albums', 'photo_added', (ev) => {
  const albumId = Number(ev.resourceId)
  if (!Number.isFinite(albumId)) return
  if (!albums.value.some((a) => a.id === albumId)) return
  loadData()
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
  filterQuery.value = initial.searchQuery
  // Mirror the restored state to the URL so a copy-paste or share of the
  // address bar shows the same filters the view is rendering.
  void persistState()
}

// Keep URL + localStorage in sync whenever the applied state changes.
watch(appliedAlbumFilter, () => persistState(), { deep: true })
watch(appliedAlbumSort, () => persistState(), { deep: true })
watch(filterQuery, () => persistState())

onMounted(loadData)
</script>

<template>
  <div class="albums-view">

    <!-- Service status warning bar -->
    <ServiceStatusBar />

    <div class="subheader">
      <div class="header">
        <h1 class="title">Meine Alben</h1>
        <Button label="Neues Album" icon="pi pi-plus" @click="showCreateDialog = true"/>
      </div>
      <div v-if="!loading && albums.length > 0" class="filter-row">
        <span class="p-input-icon-left filter-input-wrapper">
          <i class="pi pi-search filter-icon" />
          <InputText
              v-model="filterQuery"
              placeholder="Alben filtern…"
              class="filter-input"
              aria-label="Alben filtern"
          />
          <Button
              v-if="filterQuery"
              icon="pi pi-times"
              text
              rounded
              size="small"
              class="filter-clear"
              v-tooltip="'Filter zurücksetzen'"
              aria-label="Filter zurücksetzen"
              @click="filterQuery = ''"
          />
        </span>
        <Button
          :icon="activeAlbumFilterCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
          :label="activeAlbumFilterCount > 0 ? `Filter (${activeAlbumFilterCount})` : 'Filter'"
          size="small"
          :severity="activeAlbumFilterCount > 0 ? 'primary' : 'secondary'"
          :outlined="activeAlbumFilterCount === 0"
          @click="openAlbumFilterMenu"
        />
        <Button
          icon="pi pi-sort-alt"
          label="Sortierung"
          size="small"
          :severity="isAlbumSortDefault ? 'secondary' : 'primary'"
          :outlined="isAlbumSortDefault"
          @click="openAlbumSortMenu"
        />
      </div>
      <div v-if="activeAlbumFilterCount > 0 || !isAlbumSortDefault" class="album-filter-chips">
        <Chip
          v-for="(chip, i) in albumFilterChips()"
          :key="`f-${i}`"
          :label="chip.label"
          removable
          @remove="chip.clear()"
        />
        <Chip
          v-if="!isAlbumSortDefault"
          :label="albumSortChipLabel"
          removable
          @remove="resetAlbumSort()"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner"/> Alben werden geladen…
    </div>
    <div v-else-if="albums.length === 0" class="info-text">
      Keine Alben vorhanden. Erstelle dein erstes Album!
    </div>
    <div v-else-if="filteredAlbums.length === 0" class="info-text">
      Keine Alben passen zum Filter „{{ filterQuery }}“.
    </div>

    <VirtualAlbumGrid
      v-else
      :albums="filteredAlbums"
      :rememberedAlbumId="rememberedAlbumId"
      :canManage="canManageAlbum"
      :canShare="canShareAlbum"
      @open="openAlbum"
      @share="openShareDialog"
      @edit="openRenameDialog"
      @remove="openDeleteDialog"
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
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label>Darstellung</label>
        <SelectButton v-model="newAlbumDisplayMode" :options="displayModeOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showCreateDialog = false"/>
        <Button label="Erstellen" :loading="creating" @click="handleCreateAlbum"/>
      </template>
    </Dialog>

    <Dialog v-model:visible="showRenameDialog" header="Album bearbeiten" :modal="true">
      <div class="dialog-content">
        <label for="renameAlbumName">Name des Albums</label>
        <InputText id="renameAlbumName" v-model="renameValue" autofocus @keydown.enter="handleRenameAlbum" />
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label for="renameAlbumDesc">Beschreibung</label>
        <textarea id="renameAlbumDesc" v-model="renameDesc" rows="2" class="p-inputtextarea p-inputtext" style="width: 100%"></textarea>
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label>Darstellung</label>
        <SelectButton v-model="renameDisplayMode" :options="displayModeOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showRenameDialog = false" />
        <Button label="Speichern" :disabled="!renameValue.trim()" :loading="updatingAlbum" @click="handleRenameAlbum" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showDeleteDialog" header="Album löschen" :modal="true" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du dieses Album wirklich löschen?</p>
        <p class="muted">Es werden keine Fotos gelöscht. Sie bleiben unter <b>Alle Fotos</b> erhalten.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showDeleteDialog = false" />
        <Button label="Löschen" severity="danger" :loading="updatingAlbum" @click="handleDeleteAlbum" />
      </template>
    </Dialog>

    <!-- Share Dialog -->
    <Dialog v-model:visible="showShareDialog" header="Album freigeben" modal style="width: 480px">
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
                {{ formatExpiryDate(publicLink.expires_at) }}
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
            <Button
              v-if="canRemoveShare(share)"
              icon="pi pi-times"
              size="small"
              text
              severity="danger"
              v-tooltip="'Freigabe entfernen'"
              @click="handleRemoveShare(share.user_id)"
            />
          </div>
          <div v-if="!shareAlbumIsOwner" class="share-hint">
            Als Teilnehmer mit Teilen-Recht kannst du nur Freigaben entfernen, die du selbst erstellt hast.
          </div>
        </div>
        <div class="share-section">
          <h4 class="share-section-title">Benutzer hinzufügen</h4>
          <div class="share-add-form">
            <Select v-if="allUsers.length > 0" v-model="shareUserId" :options="usersNotShared" optionLabel="name" optionValue="id" placeholder="Benutzer auswählen…" class="share-user-select" />
            <input v-else v-model.number="shareUserId" type="number" placeholder="Benutzer-ID" class="p-inputtext share-userid-input" />
            <SelectButton v-model="shareAccessLevel" :options="accessLevelOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
            <Button label="Freigeben" icon="pi pi-check" :loading="sharing" :disabled="!shareUserId" @click="handleShare" />
          </div>
          <div class="share-access-explanation">
            <div class="share-access-explanation-row">
              <span class="share-badge share-badge--read">Nur lesen</span>
              <span>Das Album und seine Fotos können angesehen werden – keine Änderungen möglich.</span>
            </div>
            <div class="share-access-explanation-row">
              <span class="share-badge share-badge--write">Bearbeiten</span>
              <span>Zusätzlich können Albumdetails geändert sowie Fotos hinzugefügt oder entfernt werden.</span>
            </div>
            <div v-if="shareAlbumIsOwner" class="share-access-explanation-row">
              <span class="share-badge share-badge--write">Bearbeiten + Teilen</span>
              <span>Zusätzlich kann ein öffentlicher Link erzeugt sowie weitere Benutzer eingeladen werden.</span>
            </div>
          </div>
        </div>
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

    <SortMenu
      v-model:visible="showAlbumSortMenu"
      v-model:draft="draftAlbumSort"
      :fields="ALBUM_SORT_FIELDS"
      @apply="applyAlbumSort"
      @reset="resetAlbumSort"
    />
  </div>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5em;
}

.albums-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  /* The VirtualAlbumGrid is the scroll container — keep this one static so
     the subheader stays pinned to the top without sticky-positioning hacks. */
  overflow: hidden;
  margin-inline: -0.25em;
  padding-inline: 0.5em;
  width: 100%;
}

@media (min-width: 800px) {
  .albums-view {
    margin-inline: -0.5em;
    padding-inline: 1em;
  }
}

.albums-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem;
}

.filter-row {
  margin-block: 0.5rem 1rem;
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.subheader {
  /* The albums view no longer scrolls — the subheader is just normal flow
     above the (scrollable) VirtualAlbumGrid. */
  flex: none;
  background: var(--p-content-background);
  padding-bottom: 0.25rem;
}

.album-filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-block: 0 0.75rem;
}

.album-filter-menu { display: flex; flex-direction: column; gap: 1rem; }
.afm-row { display: flex; flex-direction: column; gap: 0.5rem; }
.afm-label { font-weight: 500; font-size: 0.9rem; color: var(--p-text-muted-color); }
.afm-checks { display: flex; gap: 1rem; flex-wrap: wrap; }
.afm-check { display: flex; align-items: center; gap: 0.5rem; }

.filter-input-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: min(100%, 24rem);
}

.filter-icon {
  position: absolute;
  left: 0.65rem;
  color: var(--p-text-muted-color);
  pointer-events: none;
}

.filter-input {
  width: 100%;
  padding-left: 2rem;
  padding-right: 2.25rem;
}

.filter-clear {
  position: absolute;
  right: 0.25rem;
}

/* Album card / cover / info / actions styles live in VirtualAlbumGrid. */

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

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
.share-userid-input { width: 120px; }
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
</style>
