<script setup lang="ts">
import {onMounted, onBeforeUnmount, ref, computed, watch, nextTick} from 'vue'
import {useRouter} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import Chip from 'primevue/chip'
import HeicImage from '../components/HeicImage.vue'
import DateRangePresets from '../components/DateRangePresets.vue'
import SortMenu from '../components/SortMenu.vue'
import type { SortField, SortState } from '../composables/useSort'
import {
  type Album,
  type AlbumShareWithUser,
  type AlbumPublicLink,
  type PublicLinkExpiry,
  createAlbum, listAlbums, getPhotoUrl, updateAlbum, deleteAlbum,
  getAlbumShares, shareAlbum, removeAlbumShare,
  createAlbumPublicLink, deleteAlbumPublicLink,
} from '../api/photos'
import { listUsers, type UserWithRoles } from '../api/users'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import ServiceStatusBar from "../components/ServiceStatusBar.vue";

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')
const auth = useAuthStore()

const firstAlbumRef = ref<HTMLElement | null>(null)
const gridEl = ref<HTMLElement | null>(null)

// Shared with AlbumDetailView: when the user opens an album we remember it
// here, so navigating back from the detail view restores focus and scroll
// position to the album the user came from.
const LAST_FOCUSED_ALBUM_KEY = 'albums_last_focused_album_id'

function rememberFocusedAlbum(id: number) {
  try { sessionStorage.setItem(LAST_FOCUSED_ALBUM_KEY, String(id)) } catch { /* ignore */ }
}

function readRememberedAlbumId(): number | null {
  try {
    const raw = sessionStorage.getItem(LAST_FOCUSED_ALBUM_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  } catch { return null }
}

function openAlbum(album: Album) {
  rememberFocusedAlbum(album.id)
  router.push(`/fotos/alben/${album.id}`)
}

// Number of columns currently shown in the grid. Derived from the computed
// `grid-template-columns` (each track becomes a space-separated length), so
// it stays in sync with responsive breakpoints and `auto-fill` without us
// having to mirror the CSS formula here.
function getGridColumnCount(): number {
  const root = gridEl.value
  if (!root) return 1
  const template = window.getComputedStyle(root).gridTemplateColumns
  if (!template || template === 'none') return 1
  return template.split(' ').filter(s => s.trim().length > 0).length
}

function handleGridArrowNav(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const root = gridEl.value
  if (!root) return
  const active = document.activeElement as HTMLElement | null
  const currentCard = active?.closest('.album-card') as HTMLElement | null
  if (!currentCard || !root.contains(currentCard)) return

  const cards = Array.from(root.querySelectorAll<HTMLElement>('.album-card'))
  const currentIndex = cards.indexOf(currentCard)
  if (currentIndex === -1) return

  const cols = getGridColumnCount()
  let targetIndex = -1
  switch (e.key) {
    case 'ArrowLeft':
      if (currentIndex > 0) targetIndex = currentIndex - 1
      break
    case 'ArrowRight':
      if (currentIndex < cards.length - 1) targetIndex = currentIndex + 1
      break
    case 'ArrowUp':
      if (currentIndex - cols >= 0) targetIndex = currentIndex - cols
      break
    case 'ArrowDown':
      if (currentIndex + cols < cards.length) targetIndex = currentIndex + cols
      // If there's no card directly below (partial last row), fall back to
      // the last card so the user can always reach the end of the grid.
      else if (currentIndex < cards.length - 1) targetIndex = cards.length - 1
      break
  }
  if (targetIndex === -1) return

  const target = cards[targetIndex]
  if (!target) return
  e.preventDefault()
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  target.focus({ preventScroll: true })
}

function focusRememberedAlbum(): boolean {
  const id = readRememberedAlbumId()
  if (id === null) return false
  const root = gridEl.value
  if (!root) return false
  const el = root.querySelector<HTMLElement>(`[data-album-id="${id}"]`)
  if (!el) return false
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  // `el.focus()` alone does not trigger `:focus-visible` styles for
  // programmatic focus, so the user wouldn't see the outline. Add an
  // explicit marker class that mirrors the focus-visible outline and
  // clear it as soon as the user interacts with the page again.
  el.classList.add('album-card--restored-focus')
  const clear = () => {
    el.classList.remove('album-card--restored-focus')
    el.removeEventListener('blur', clear)
    el.removeEventListener('pointerdown', clear)
    el.removeEventListener('keydown', clear)
  }
  el.addEventListener('blur', clear)
  el.addEventListener('pointerdown', clear)
  el.addEventListener('keydown', clear)
  el.focus({ preventScroll: true })
  return true
}

// ── Virtualized rendering ─────────────────────────────────────────────────────
// Album cards are expensive (HeicImage + PrimeVue Buttons with tooltips + image
// decode). Rendering the full card for hundreds/thousands of albums makes
// scrolling unusable. Instead each card reserves its layout slot via a
// placeholder with min-height, and only renders its real content while it
// intersects the viewport (plus a small buffer, so the content is ready by
// the time the user sees it). When a card scrolls back out of view its
// content is torn down again, keeping DOM / memory bounded regardless of
// how many albums exist.
const visibleAlbumIds = ref(new Set<number>())
let cardObserver: IntersectionObserver | null = null
let pendingVisible = new Set<number>()
let visibleFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushVisible() {
  visibleAlbumIds.value = new Set(pendingVisible)
  visibleFlushTimer = null
}

function observeCards() {
  cardObserver?.disconnect()
  pendingVisible = new Set()
  if (visibleFlushTimer) { clearTimeout(visibleFlushTimer); visibleFlushTimer = null }
  const root = gridEl.value
  if (!root) { visibleAlbumIds.value = new Set(); return }

  cardObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.albumId)
        if (!id) continue
        if (entry.isIntersecting) pendingVisible.add(id)
        else pendingVisible.delete(id)
      }
      if (visibleFlushTimer) clearTimeout(visibleFlushTimer)
      visibleFlushTimer = setTimeout(flushVisible, 100)
    },
    // 400px buffer: start hydrating a card shortly before it enters the
    // viewport so the user never sees an empty placeholder during normal
    // scrolling. Use the document scroller (null) because .albums-view is
    // the scroll container and is an ancestor of .albums-grid.
    { root: null, rootMargin: '400px 0px' }
  )

  const cards = root.querySelectorAll<HTMLElement>('[data-album-id]')
  cards.forEach(el => cardObserver!.observe(el))

  // Seed immediately from current viewport so the first paint isn't empty.
  const viewportBottom = window.innerHeight + 400
  const viewportTop = -400
  cards.forEach(el => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > viewportTop && rect.top < viewportBottom) {
      const id = Number(el.dataset.albumId)
      if (id) pendingVisible.add(id)
    }
  })
  flushVisible()
}

const filterQuery = ref('')

// ── Album filter menu ────────────────────────────────────────────────────────
type AlbumOwnerFilter = 'all' | 'mine' | 'shared'
type AlbumDisplayFilter = 'all' | 'grid' | 'map'
type AlbumEmptyFilter = 'any' | 'only' | 'exclude'

interface AlbumFilter {
  owner: AlbumOwnerFilter
  display: AlbumDisplayFilter
  dateFrom?: string  // ISO YYYY-MM-DD
  dateTo?: string
  emptyMode: AlbumEmptyFilter
  sharedByMe: boolean
  sharedWithMe: boolean
}

const EMPTY_ALBUM_FILTER: AlbumFilter = {
  owner: 'all',
  display: 'all',
  emptyMode: 'any',
  sharedByMe: false,
  sharedWithMe: false,
}
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
const DEFAULT_ALBUM_SORT: SortState = { field: 'newest_photo_at', direction: 'desc' }
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

function restoreInitialFocus() {
  // One animation frame after the DOM flush so the grid has its final
  // layout (card placeholders are sized, template refs are populated).
  // If the card can't be found yet, try once more next frame.
  requestAnimationFrame(() => {
    if (focusRememberedAlbum()) return
    requestAnimationFrame(() => {
      if (focusRememberedAlbum()) return
      firstAlbumRef.value?.focus()
    })
  })
}

watch(loading, (newLoading) => {
  if (!newLoading && filteredAlbums.value.length > 0) {
    nextTick(() => {
      restoreInitialFocus()
      observeCards()
    })
  }
})

// Re-observe whenever the set of rendered cards changes (create, rename, delete, filter).
watch(filteredAlbums, () => {
  nextTick(() => observeCards())
})

onBeforeUnmount(() => {
  cardObserver?.disconnect()
  cardObserver = null
  if (visibleFlushTimer) { clearTimeout(visibleFlushTimer); visibleFlushTimer = null }
})

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
const albumSharesList = ref<AlbumShareWithUser[]>([])
const allUsers = ref<UserWithRoles[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<'read' | 'write'>('read')
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
const accessLevelOptions = [{ label: 'Nur lesen', value: 'read' }, { label: 'Bearbeiten', value: 'write' }]

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumSharesList.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  return allUsers.value.filter(u => u.id !== currentUserId && !sharedIds.has(u.id))
})

async function openShareDialog(album: Album) {
  shareAlbumId.value = album.id
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

    <div v-else ref="gridEl" class="albums-grid" @keydown="handleGridArrowNav">
      <div
          v-for="(album, index) in filteredAlbums"
          :key="album.id"
          :ref="el => { if (index === 0) firstAlbumRef = (el as HTMLElement) }"
          :data-album-id="album.id"
          class="album-card"
          :class="{ 'album-card--placeholder': !visibleAlbumIds.has(album.id) }"
          tabindex="0"
          @click="openAlbum(album)"
          @keydown.enter="openAlbum(album)"
          @keydown.space.prevent="openAlbum(album)"
      >
        <template v-if="visibleAlbumIds.has(album.id)">
          <div v-if="canManageAlbum(album)" class="album-actions" @click.stop>
            <Button icon="pi pi-share-alt" text rounded size="small" v-tooltip="'Freigeben'" @click="openShareDialog(album)" />
            <Button icon="pi pi-pencil" text rounded size="small" v-tooltip="'Bearbeiten'" @click="openRenameDialog(album)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Löschen'" @click="openDeleteDialog(album)" />
          </div>
          <div class="album-cover">
            <HeicImage
              v-if="album.cover_filename"
              :src="getPhotoUrl(album.cover_filename, 400)"
              :alt="album.name"
              objectFit="cover"
            />
            <div v-else class="album-icon"><i class="pi pi-images"/></div>
          </div>
          <i v-if="album.is_shared" class="pi pi-share-alt shared-badge" v-tooltip="'Freigegeben'" />
          <div class="album-info">
            <span class="album-name">{{ album.name }}</span>
            <span v-if="album.description" class="album-desc">{{ album.description }}</span>
            <span class="album-meta">
              {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
              <template v-if="album.oldest_photo_at && album.newest_photo_at">
                • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
              </template>
            </span>
          </div>
        </template>
      </div>
    </div>

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
            <span :class="['share-badge', share.access_level === 'write' ? 'share-badge--write' : 'share-badge--read']">
              {{ share.access_level === 'write' ? 'Bearbeiten' : 'Nur lesen' }}
            </span>
            <Button icon="pi pi-times" size="small" text severity="danger" @click="handleRemoveShare(share.user_id)" />
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
  overflow-y: auto;
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

.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-col), 1fr));
  gap: var(--grid-gap);
}

.album-card {
  position: relative;
  background: var(--p-content-background);
  border: 4px solid transparent;
  border-radius: var(--radius-md);
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  outline: none;
}

.album-card:hover { transform: scale(1.02); }

.album-card:focus-visible,
.album-card.album-card--restored-focus {
  outline: 2px solid var(--p-primary-300);
  outline-offset: -2px;
}

/* Placeholder: card slot is reserved so the grid layout stays stable even
 * while the card's content is torn down. Matches the cover height used
 * once the card is hydrated. */
.album-card--placeholder {
  min-height: 200px;
}

.shared-badge {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 1;
  font-size: 0.9rem;
  color: white;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  padding: 0.35rem;
  backdrop-filter: blur(4px);
}

.album-actions {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity 0.2s;
}
.album-actions :deep(.p-button) { color: #fff; }
.album-card:hover .album-actions,
.album-card:focus-within .album-actions { opacity: 1; }

.album-cover {
  width: 100%;
  height: 200px;
  background: var(--p-content-hover-background);
  overflow: hidden;
}
.album-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}
.album-icon {
  font-size: 3rem;
  color: var(--p-primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.album-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0.4rem 0.6rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: #fff;
}
.album-name {
  font-weight: 500;
  font-size: 0.85rem;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.album-desc {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.album-meta {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

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
