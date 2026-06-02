<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import FilterMenu from '../components/FilterMenu.vue'
import GuestStatusBanner from '../components/GuestStatusBanner.vue'
import GuestRegisterDialog from '../components/GuestRegisterDialog.vue'
import GuestAccountDialog from '../components/GuestAccountDialog.vue'
import GuestPhotoReactions from '../components/GuestPhotoReactions.vue'
import PhotoMiniMap from '../components/PhotoMiniMap.vue'
import { getPublicAlbum, getPhotoUrl, type PhotoFilter, type PublicAlbumResponse, type PublicAlbumPhoto, type Photo } from '../api/photos'
import { matchesPhotoFilter } from '../utils/photoFilter'
import { countActiveFilters } from '../composables/useFilter'
import { formatPhotoDate, formatLocationLabel } from '../utils/dateFormat'
import { useGuestSession } from '../composables/useGuestSession'
import { useGuestPushNotifications } from '../composables/useGuestPushNotifications'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))

const route = useRoute()
const router = useRouter()
const album = ref<PublicAlbumResponse | null>(null)
const loading = ref(true)
const error = ref('')

const shareToken = computed(() => (route.params.token as string) ?? '')

/**
 * `display_mode === 'map'` is now a "map enabled" flag rather than a
 * fixed view: when set, the visitor can flip between raster and map on
 * the fly via `viewMode`. When the album has map disabled we lock to
 * grid view.
 */
const mapEnabled = computed(() => album.value?.display_mode === 'map')
const viewMode = ref<'grid' | 'map'>('grid')

// Persist the visitor's raster/map choice per share token (works for
// anonymous visitors too — no account needed), so reopening the link
// restores the last view instead of always snapping to the album default.
const VIEW_MODE_STORAGE_KEY = computed(() => `sharedAlbumViewMode:${shareToken.value}`)

function loadPersistedViewMode(): 'grid' | 'map' | null {
  if (!shareToken.value) return null
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY.value)
    return v === 'grid' || v === 'map' ? v : null
  } catch {
    return null
  }
}

function persistViewMode(mode: 'grid' | 'map') {
  if (!shareToken.value) return
  try { localStorage.setItem(VIEW_MODE_STORAGE_KEY.value, mode) } catch { /* quota / private-mode — ignore */ }
}

let viewModeInitialized = false

watch(album, (a) => {
  if (!a) return
  if (viewModeInitialized) return
  viewModeInitialized = true
  // Map disabled → lock to grid. Map enabled → restore the visitor's last
  // choice for this share, falling back to map view (the curated experience).
  viewMode.value = a.display_mode === 'map'
    ? (loadPersistedViewMode() ?? 'map')
    : 'grid'
}, { immediate: true })

// Persist the choice per share token (map-enabled albums only).
watch(viewMode, (mode) => {
  if (mapEnabled.value) persistViewMode(mode)
})

/**
 * True for any map-view rendering. The map crowds the viewport, so
 * the full-width guest banner is suppressed in favour of compact
 * buttons in TripMap's stats-addon slot — "Anmelden" for anonymous
 * visitors and a user icon opening the account dialog for
 * registered (pending or verified) guests.
 */
const isMapView = computed(() => mapEnabled.value && viewMode.value === 'map')
const isMapAnonymous = computed(
  () => isMapView.value && guestSession.guest.value === null,
)
const isMapRegistered = computed(
  () => isMapView.value && guestSession.guest.value !== null,
)

const showAccountDialog = ref(false)
function openAccountDialog() {
  showAccountDialog.value = true
}

// Guest identity + opt-in toggles. The composable instances are
// created once per token and shared with the banner so unmounting
// the banner during route changes wouldn't drop subscription state.
const guestSession = useGuestSession(shareToken.value)
const guestPush = useGuestPushNotifications(shareToken.value)

const showRegisterDialog = ref(false)
const registerInitial = ref<{ email: string; name: string } | undefined>(undefined)

function openRegisterDialog() {
  registerInitial.value = guestSession.guest.value
    ? {
        email: guestSession.guest.value.email,
        name: guestSession.guest.value.display_name,
      }
    : undefined
  showRegisterDialog.value = true
}

async function handleRegisterSubmit(payload: { email: string; displayName: string }) {
  try {
    await guestSession.register(payload.email, payload.displayName)
    // Dialog stays open showing the inbox confirmation; the user
    // closes it with the explicit "Schließen" button.
  } catch {
    // Error is already surfaced via guestSession.error / dialog
    // errorMessage prop.
  }
}

async function handleResendVerifyMail() {
  try {
    await guestSession.resendVerifyMail()
    openRegisterDialog()
  } catch {
    // already surfaced
  }
}

async function handleLogout() {
  await guestSession.logout()
  // If the guest had Web Push enabled, drop the local subscription
  // too — the cookie is gone so the backend would refuse new sends
  // anyway, but pruning keeps the browser from holding a dead
  // endpoint that fires no notifications.
  if (guestPush.status.value === 'subscribed') {
    await guestPush.unsubscribe()
  }
}

async function handleTogglePush(value: boolean) {
  if (value) await guestPush.subscribe()
  else await guestPush.unsubscribe()
}

/** Cast PublicAlbumPhoto[] to Photo[] for components that expect full Photo type */
function asPhotos(photos: PublicAlbumPhoto[]): Photo[] {
  return photos.map(p => ({
    ...p,
    user_id: 0,
    hash: undefined,
    curation_status: p.is_hidden ? 'hidden' as const : 'visible' as const,
    ai_quality_details: undefined,
    description: p.description,
  }))
}

const albumPhotosAsPhoto = computed<Photo[]>(() => album.value ? asPhotos(album.value.photos) : [])

// ── Filter (map view only) ──────────────────────────────────────────────────
// Public / shared album opens with Group Highlights on (when the album
// actually contains enough of them) and hidden photos excluded.
// The filter state is persisted locally per share token so the viewer's
// choice survives page reloads.
const FILTER_STORAGE_KEY = computed(() => `sharedAlbumFilter:${shareToken.value}`)
const BANNER_DISMISSED_KEY = computed(() => `sharedAlbumGuestBannerDismissed:${shareToken.value}`)

// Persist the dismissed-banner state per share token via localStorage
// (works for anonymous visitors too — no account needed). The header's
// compact Anmelden/Account button stays visible regardless, so the
// viewer never loses the call-to-action.
const bannerDismissed = ref<boolean>(false)
try {
  bannerDismissed.value = localStorage.getItem(BANNER_DISMISSED_KEY.value) === '1'
} catch {
  /* private mode / quota — fine to start with banner visible */
}
function dismissGuestBanner() {
  bannerDismissed.value = true
  try { localStorage.setItem(BANNER_DISMISSED_KEY.value, '1') } catch { /* ignore */ }
}

function loadPersistedFilter(): PhotoFilter | null {
  if (!shareToken.value) return null
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY.value)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as PhotoFilter) : null
  } catch {
    return null
  }
}

function persistFilter(f: PhotoFilter) {
  if (!shareToken.value) return
  try {
    localStorage.setItem(FILTER_STORAGE_KEY.value, JSON.stringify(f))
  } catch {
    /* quota / private-mode — ignore */
  }
}

const filter = ref<PhotoFilter>({})
const filterDraft = ref<PhotoFilter>({})
const filterMenuOpen = ref(false)
// Lazy-Mount: siehe GalleryView.
const filterMenuMounted = ref(false)
const activeCount = computed(() => countActiveFilters(filter.value))

const groupCoverIds = computed<Set<number>>(() =>
  new Set((album.value?.photos ?? []).filter(p => p.is_highlight).map(p => p.id))
)

/**
 * Group-Highlight filter is only offered when the album actually has
 * enough highlight photos for the toggle to be meaningful — anything
 * below 10% of the album would either show almost nothing or the user
 * wouldn't notice a difference.
 */
const groupHighlightAvailable = computed<boolean>(() => {
  const total = albumPhotosAsPhoto.value.length
  if (total === 0) return false
  return groupCoverIds.value.size / total >= 0.1
})

/** Anonymous viewers (not signed-in guests) don't get the "Ausgeblendet"
 *  filter — they can't have hidden anything in the first place. */
const isAnonymousViewer = computed(() => guestSession.guest.value === null)

const FILTER_AVAILABLE = computed<Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'>>(() => {
  const arr: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'> = []
  if (!isAnonymousViewer.value) arr.push('hiddenMode')
  if (groupHighlightAvailable.value) arr.push('groupHighlight')
  return arr
})

/** When no filter criterion is available at all, hide the filter button
 *  entirely — there's literally nothing to toggle. */
const filterButtonVisible = computed(() => FILTER_AVAILABLE.value.length > 0)

function openFilterMenu() {
  filterDraft.value = { ...filter.value }
  filterMenuMounted.value = true
  filterMenuOpen.value = true
}
function onApplyFilter() {
  filter.value = { ...filterDraft.value }
  persistFilter(filter.value)
}
function onResetFilter() {
  const reset: PhotoFilter = groupHighlightAvailable.value ? { groupHighlight: true } : {}
  filter.value = { ...reset }
  filterDraft.value = { ...reset }
  persistFilter(filter.value)
}

const filteredMapPhotos = computed<Photo[]>(() => {
  const ctx = { groupCoverIds: groupCoverIds.value }
  return albumPhotosAsPhoto.value.filter(p => matchesPhotoFilter(p, filter.value, ctx))
})

// Fullscreen state — uses full Photo type so FullscreenOverlay works directly
const isFullscreen = ref(false)
const fullscreenIndex = ref(0)
const fullscreenPhotos = ref<Photo[]>([])
/** True when fullscreen was opened from a map stop. Controls whether we
 *  sync the map's selected stop back on close. */
const fullscreenFromMap = ref(false)
const tripMapRef = ref<{ selectStopByPhotoId: (id: number) => boolean } | null>(null)

const currentPhoto = computed<Photo | null>(() => fullscreenPhotos.value[fullscreenIndex.value] ?? null)
const prevPhoto = computed<Photo | null>(() => {
  const idx = fullscreenIndex.value - 1
  return idx >= 0 ? (fullscreenPhotos.value[idx] ?? null) : null
})
const nextPhoto = computed<Photo | null>(() => {
  const idx = fullscreenIndex.value + 1
  return idx < fullscreenPhotos.value.length ? (fullscreenPhotos.value[idx] ?? null) : null
})
const hasPrev = computed(() => fullscreenIndex.value > 0)
const hasNext = computed(() => fullscreenIndex.value < fullscreenPhotos.value.length - 1)
function openFullscreen(photo: Photo) {
  const photos = albumPhotosAsPhoto.value
  fullscreenPhotos.value = photos
  fullscreenIndex.value = photos.findIndex(p => p.id === photo.id)
  if (fullscreenIndex.value < 0) fullscreenIndex.value = 0
  fullscreenFromMap.value = false
  isFullscreen.value = true
}

/**
 * Open the photo named in the `?photoId=<id>` query parameter (set by the
 * comment push-notification deep-link) in fullscreen, with the comment
 * thread already expanded so the visitor lands directly on the comment
 * that triggered the notification. No-op when the parameter is absent or
 * the photo isn't part of this album. The parameter is consumed once
 * opened so a later notification for the same photo re-triggers.
 */
function openPhotoFromQuery() {
  const raw = route.query.photoId
  const idStr = Array.isArray(raw) ? raw[0] : raw
  if (!idStr) return
  const id = Number(idStr)
  if (!Number.isFinite(id)) return
  const photo = albumPhotosAsPhoto.value.find((p) => p.id === id)
  if (!photo) return
  openFullscreen(photo)
  showInfo.value = true
  void router.replace({ query: { ...route.query, photoId: undefined } })
}

function handleMapFullscreen(photos: Photo[], startIndex: number, _day: string) {
  // TripMap hands us the whole trip's photos in chronological order so the
  // overlay (paging and the idle slideshow) runs continuously across day and
  // stop boundaries rather than stopping at the end of a single day.
  fullscreenPhotos.value = photos
  fullscreenIndex.value = Math.max(0, Math.min(startIndex, photos.length - 1))
  fullscreenFromMap.value = true
  isFullscreen.value = true
}

function closeFullscreen() {
  // Sync the map's selected stop with the photo the user ended on when
  // fullscreen was opened from a map stop, so that navigating beyond the
  // initial stop is reflected on the map once the overlay is closed.
  if (fullscreenFromMap.value && currentPhoto.value && tripMapRef.value) {
    tripMapRef.value.selectStopByPhotoId(currentPhoto.value.id)
  }
  isFullscreen.value = false
  showInfo.value = false
  fullscreenFromMap.value = false
}

// ── Details panel. Drives FullscreenOverlay's `detailsActive`, which the
//    overlay renders as the shared split-screen layout (photo + metadata
//    side-by-side in landscape, stacked in portrait). ─────────────────────

const showInfo = ref(false)
function toggleInfo() {
  showInfo.value = !showInfo.value
}

/** Per-photo description (only — no album fallback). */
const currentDescription = computed<string>(() => {
  return currentPhoto.value?.description?.trim() ?? ''
})

/**
 * True when the info panel provides value beyond what the topbar already
 * shows (date + location text). With guest comments living inside the
 * panel the answer is "always" — even an empty thread surfaces the
 * composer or the verify gate.
 */
const showInfoButton = computed<boolean>(() => true)

/** Maps URL — Apple Maps on Apple devices, Google Maps elsewhere. */
const isApple = /iPhone|iPad|iPod|Mac/.test(navigator.userAgent)
const currentMapUrl = computed<string | null>(() => {
  const p = currentPhoto.value
  if (!p || p.latitude == null || p.longitude == null) return null
  if (isApple) {
    const q = formatSharedLocation(p)
    return `https://maps.apple.com/?ll=${p.latitude},${p.longitude}&q=${encodeURIComponent(q || `${p.latitude},${p.longitude}`)}`
  }
  return `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`
})

// Reset panel when leaving fullscreen by other means (e.g., swipe to close)
watch(isFullscreen, (open) => {
  if (!open) showInfo.value = false
})

function goPrev() {
  if (hasPrev.value) fullscreenIndex.value--
}

function goNext() {
  if (hasNext.value) fullscreenIndex.value++
}

// ── Keyboard navigation ─────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
  if (!isFullscreen.value) return
  if (e.key === 'Escape') closeFullscreen()
  if (e.key === 'ArrowLeft') goPrev()
  if (e.key === 'ArrowRight') goNext()
}

// ── Info formatting ─────────────────────────────────────────────────────────

/**
 * Build a location label, removing duplicate segments.
 * Nominatim often returns `location_name` already containing the city
 * (e.g. "Josef-Haubrich-Hof 5, Köln"), which would otherwise produce
 * "Josef-Haubrich-Hof 5, Köln, Köln" when concatenated with location_city.
 */
function formatSharedLocation(photo: Photo): string {
  const parts = formatLocationLabel(photo).split(', ')
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const p of parts) {
    const key = p.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(p.trim())
  }
  return deduped.join(', ')
}

function formatDate(photo: Photo): string {
  return formatPhotoDate(photo.taken_at || photo.created_at)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// A notification click on an already-open tab navigates the existing
// route (same component, only the query changes), so onMounted won't
// re-run — react to the query change here as well.
watch(
  () => route.query.photoId,
  () => {
    if (album.value) openPhotoFromQuery()
  },
)

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  const token = route.params.token as string
  if (!token) {
    error.value = 'Kein gültiger Link'
    loading.value = false
    return
  }
  try {
    album.value = await getPublicAlbum(token)
  } catch (err: any) {
    error.value = err.message || 'Album konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
  // Initialise the filter once the album content is known. Persisted
  // viewer choice wins, but criteria that are no longer offered get
  // dropped. When nothing is persisted we turn Group-Highlights on by
  // default if the album has enough of them — otherwise we start with
  // an empty filter.
  if (album.value) {
    const persisted = loadPersistedFilter()
    let initial: PhotoFilter
    if (persisted) {
      initial = {}
      if (persisted.hiddenMode && !isAnonymousViewer.value) {
        initial.hiddenMode = persisted.hiddenMode
      }
      if (persisted.groupHighlight && groupHighlightAvailable.value) {
        initial.groupHighlight = true
      }
    } else {
      initial = groupHighlightAvailable.value ? { groupHighlight: true } : {}
    }
    filter.value = { ...initial }
    filterDraft.value = { ...initial }
    persistFilter(filter.value)
    // Deep-link from a comment notification: open the referenced photo
    // once the album content is available.
    openPhotoFromQuery()
  }
  // Guest state loads in parallel — failures don't block the album
  // view; the banner just shows the anonymous CTA.
  void guestSession.refresh()
  void guestPush.refreshState()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="shared-album-view" :class="{ 'shared-album-view--grid': !isMapView }">
    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <Message v-if="error" severity="error">{{ error }}</Message>

    <template v-if="album">
      <!-- The full-width banner is only shown in grid view. In map
           view it would eat viewport space the map needs, so we
           replace it with compact action pills in TripMap's stats
           overlay: "Anmelden" for anonymous visitors, a user icon
           opening the account dialog for registered guests. -->
      <GuestStatusBanner
        v-if="!isMapView && !bannerDismissed"
        :guest="guestSession.guest.value"
        :loading="guestSession.loading.value"
        :togglingNotify="guestSession.togglingNotify.value"
        :pushStatus="guestPush.status.value"
        :pushBusy="guestPush.busy.value"
        :pushCanToggle="guestPush.canToggle.value"
        @register="openRegisterDialog"
        @resend-verify="handleResendVerifyMail"
        @logout="handleLogout"
        @toggle-notify="(v) => guestSession.toggleNotifyOptIn(v)"
        @toggle-push="handleTogglePush"
        @dismiss="dismissGuestBanner"
      />

      <div v-if="!isMapView" class="shared-header">
        <h1 class="title">{{ album.name }}</h1>
        <p v-if="album.description" class="description">{{ album.description }}</p>
        <span class="meta">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            · {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
        <div v-if="mapEnabled" class="shared-view-mode-switch">
          <button
            type="button"
            class="shared-view-mode-btn"
            :class="{ 'is-active': viewMode === 'grid' }"
            aria-label="Raster anzeigen"
            @click="viewMode = 'grid'"
          >
            <i class="pi pi-th-large" />
            <span>Raster</span>
          </button>
          <button
            type="button"
            class="shared-view-mode-btn"
            :class="{ 'is-active': viewMode === 'map' }"
            aria-label="Karte anzeigen"
            @click="viewMode = 'map'"
          >
            <i class="pi pi-map" />
            <span>Karte</span>
          </button>
        </div>

        <!-- Always-visible Anmelden / Account button. Mirrors the
             guest banner CTA so the call-to-action stays reachable
             even after the user dismissed the banner. Icon-only —
             matches the dense look of the view-mode switch. -->
        <button
          type="button"
          class="shared-header-account-btn"
          :class="{ 'shared-header-account-btn--warn': guestSession.guest.value && !guestSession.isVerified.value }"
          :aria-label="guestSession.guest.value
            ? (guestSession.isVerified.value
                ? `Konto von ${guestSession.guest.value.display_name}`
                : 'E-Mail bestätigen')
            : 'Anmelden'"
          :title="guestSession.guest.value
            ? (guestSession.isVerified.value
                ? `Konto von ${guestSession.guest.value.display_name}`
                : 'E-Mail bestätigen')
            : 'Anmelden'"
          @click="guestSession.guest.value ? openAccountDialog() : openRegisterDialog()"
        >
          <i
            :class="!guestSession.guest.value
              ? 'pi pi-sign-in'
              : guestSession.isVerified.value
                ? 'pi pi-user'
                : 'pi pi-exclamation-circle'"
            aria-hidden="true"
          />
        </button>
      </div>

      <!-- Map mode -->
      <TripMap
        v-if="isMapView && album.photos.length > 0"
        ref="tripMapRef"
        :photos="filteredMapPhotos"
        :albumName="album.name"
        :albumDescription="album.description"
        @open-fullscreen="handleMapFullscreen"
      >
        <template #stats-addon>
          <button
            type="button"
            class="map-filter-button"
            aria-label="Raster anzeigen"
            @click="viewMode = 'grid'"
          >
            <i class="pi pi-th-large" />
            <span>Raster</span>
          </button>
          <button
            v-if="filterButtonVisible"
            type="button"
            class="map-filter-button"
            :class="{ 'is-active': activeCount > 0 }"
            :aria-label="activeCount > 0 ? `Filter (${activeCount})` : 'Filter'"
            @click="openFilterMenu"
          >
            <i :class="activeCount > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'" />
            <span>{{ activeCount > 0 ? `Filter (${activeCount})` : 'Filter' }}</span>
          </button>
          <button
            v-if="isMapAnonymous"
            type="button"
            class="map-filter-button map-filter-button--cta"
            @click="openRegisterDialog"
          >
            <i class="pi pi-sign-in" />
            <span>Anmelden</span>
          </button>
          <button
            v-else-if="isMapRegistered && guestSession.guest.value"
            type="button"
            class="map-filter-button"
            :class="{ 'map-filter-button--warn': !guestSession.isVerified.value }"
            :aria-label="`Konto von ${guestSession.guest.value.display_name}`"
            @click="openAccountDialog"
          >
            <i :class="guestSession.isVerified.value ? 'pi pi-user' : 'pi pi-exclamation-circle'" />
            <span>{{ guestSession.guest.value.display_name }}</span>
          </button>
        </template>
      </TripMap>

      <!-- Grid mode -->
      <div v-else class="photo-grid-scroll">
        <div class="photo-grid">
          <div
            v-for="photo in albumPhotosAsPhoto"
            :key="photo.id"
            class="grid-item"
            @click="openFullscreen(photo)"
          >
            <HeicImage
              :src="getPhotoUrl(photo.filename, 400)"
              :alt="photo.original_name"
              objectFit="cover"
            />
          </div>
        </div>
      </div>
    </template>

    <FilterMenu
      v-if="filterMenuMounted"
      v-model:visible="filterMenuOpen"
      v-model:draft="filterDraft"
      :available="FILTER_AVAILABLE"
      @apply="onApplyFilter"
      @reset="onResetFilter"
    />

    <!--
      Fullscreen overlay (map mode).
      Scoped to the selected day's photos. Auto-advances every 10 s when
      the viewer is idle so the photo collection becomes a hands-off
      slideshow.
    -->

    <!-- Fullscreen overlay (reuses shared FullscreenOverlay component) -->
    <FullscreenOverlay
      v-if="isFullscreen && currentPhoto"
      :photo="currentPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="false"
      :guest="true"
      :showDetailsButton="showInfoButton"
      :detailsActive="showInfo"
      :autoAdvanceMs="10000"
      :markDayChanges="fullscreenFromMap"
      :currentIndex="fullscreenIndex + 1"
      :totalCount="fullscreenPhotos.length"
      @close="closeFullscreen"
      @prev="goPrev"
      @next="goNext"
      @show-details="toggleInfo"
    >
      <template #topbar-center>
        <div v-if="currentPhoto" class="shared-fs-info-center">
          <div class="shared-fs-date">{{ formatDate(currentPhoto) }}</div>
          <div v-if="formatSharedLocation(currentPhoto)" class="shared-fs-location">
            <i class="pi pi-map-marker" />
            {{ formatSharedLocation(currentPhoto) }}
          </div>
        </div>
      </template>
      <!-- Photo details. Rendered in the shared FullscreenOverlay
           `#details-flyout` slot so the guest view reuses the exact same
           split-screen layout (photo + metadata side-by-side in landscape,
           stacked in portrait) as the signed-in AlbumDetailView. The
           auth-bound PhotoDetailSidebar is NOT reused — guests get this
           read-only panel (date, location, map, description, comments)
           instead, but the surrounding split layout is shared. -->
      <template #details-flyout>
        <div v-if="currentPhoto" class="guest-photo-details">
          <div class="info-row info-date">
            <i class="pi pi-calendar" />
            <span>{{ formatDate(currentPhoto) }}</span>
          </div>
          <div v-if="formatSharedLocation(currentPhoto)" class="info-row info-location">
            <i class="pi pi-map-marker" />
            <a v-if="currentMapUrl" :href="currentMapUrl" target="_blank" rel="noopener" class="info-location-link">
              {{ formatSharedLocation(currentPhoto) }}
            </a>
            <span v-else>{{ formatSharedLocation(currentPhoto) }}</span>
          </div>
          <div
            v-if="currentPhoto.latitude != null && currentPhoto.longitude != null"
            class="info-row info-map"
          >
            <PhotoMiniMap
              :latitude="currentPhoto.latitude"
              :longitude="currentPhoto.longitude"
              :label="formatSharedLocation(currentPhoto) || undefined"
            />
          </div>
          <div v-if="currentDescription" class="info-row info-description">
            <i class="pi pi-align-left" />
            <p>{{ currentDescription }}</p>
          </div>
          <div class="info-row info-comments">
            <GuestPhotoReactions
              :share-token="shareToken"
              :photo-id="currentPhoto.id"
              :guest="guestSession.guest.value"
              @request-register="openRegisterDialog"
              @request-verify="handleResendVerifyMail"
            />
          </div>
        </div>
      </template>
    </FullscreenOverlay>

    <GuestRegisterDialog
      v-model:visible="showRegisterDialog"
      :submitting="guestSession.submittingRegister.value"
      :error-message="guestSession.error.value"
      :initial-email="registerInitial?.email"
      :initial-name="registerInitial?.name"
      @submit="handleRegisterSubmit"
    />

    <GuestAccountDialog
      v-model:visible="showAccountDialog"
      :guest="guestSession.guest.value"
      :togglingNotify="guestSession.togglingNotify.value"
      :pushStatus="guestPush.status.value"
      :pushBusy="guestPush.busy.value"
      :pushCanToggle="guestPush.canToggle.value"
      @resend-verify="handleResendVerifyMail"
      @logout="handleLogout"
      @toggle-notify="(v) => guestSession.toggleNotifyOptIn(v)"
      @toggle-push="handleTogglePush"
    />
  </div>
</template>

<style scoped>
.shared-album-view {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  /* --p-surface-ground/-card don't exist in Aura v4, so the old values
     fell back to hardcoded light colours and never followed the theme.
     --p-content-background is the semantic surface and adapts to dark. */
  background: var(--p-content-background);
}

.shared-header {
  /* Compact single-row header in raster view. The album name, photo
     count and (when present) the raster/map switch share a flex row;
     the description wraps onto its own line below only if it exists.
     Far less vertical space than the previous centred stack. */
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.75rem;
  padding: 0.4rem 0.75rem;
  background: var(--p-content-background);
  border-bottom: 1px solid var(--p-content-border-color);
  flex-shrink: 0;
}

.trip-stats-sep {
  margin: 0 2px;
  opacity: 0.5;
}

.map-filter-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  line-height: 1.4;
}

.map-filter-button:hover {
  background: rgba(255, 255, 255, 0.08);
}

.map-filter-button.is-active {
  background: var(--p-primary-color, #3b82f6);
  border-color: var(--p-primary-color, #3b82f6);
  color: var(--p-primary-contrast-color, #fff);
}

/* "Anmelden" pill: stays inside the dark stats overlay so it uses
   the same visual footprint as the Filter button, but paints the
   primary brand colour so it reads as the obvious CTA. */
.map-filter-button--cta {
  background: var(--p-primary-color);
  border-color: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}
.map-filter-button--cta:hover {
  background: color-mix(in srgb, var(--p-primary-color) 85%, var(--p-primary-contrast-color));
}

/* Registered-but-unverified flag: signals that the guest still
   needs to click the magic link. Uses Aura's amber palette so it
   reads as a gentle warning on the dark stats overlay. */
.map-filter-button--warn {
  border-color: var(--p-amber-500);
  color: var(--p-amber-500);
}
.map-filter-button--warn:hover {
  background: color-mix(in srgb, var(--p-amber-500) 15%, transparent);
}

.map-filter-button .pi {
  font-size: 0.9em;
}

.shared-header .title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}

.shared-header .description {
  color: var(--p-text-muted-color);
  margin: 0;
  font-size: 0.8rem;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.shared-header .meta {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Toggle between raster + map for albums where the owner enabled the map.
   Lives inline in the compact header at the right edge. */
.shared-view-mode-switch {
  display: inline-flex;
  flex-shrink: 0;
  margin-left: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
  background: var(--p-content-background, #fff);
}

.shared-view-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.75rem;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  border-radius: 999px;
}

.shared-view-mode-btn .pi {
  font-size: 0.85em;
}

.shared-view-mode-btn:hover {
  background: var(--p-content-hover-background);
}

.shared-view-mode-btn.is-active {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}

/* Compact Anmelden / Account icon button to the right of the
   view-mode switch. Stays visible even after the user dismissed the
   guest banner — primary call-to-action that mustn't disappear. */
.shared-header-account-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 50%;
  background: var(--p-content-background, #fff);
  color: var(--p-primary-color);
  cursor: pointer;
  font-size: 0.95rem;
  line-height: 1;
}

.shared-header-account-btn:hover,
.shared-header-account-btn:focus-visible {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  border-color: var(--p-primary-color);
  outline: none;
}

.shared-header-account-btn--warn {
  color: var(--p-amber-500);
  border-color: var(--p-amber-500);
}
.shared-header-account-btn--warn:hover,
.shared-header-account-btn--warn:focus-visible {
  background: var(--p-amber-500);
  color: var(--p-amber-50, #fff);
  border-color: var(--p-amber-500);
}

.photo-grid-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--grid-gap-compact);
}

.photo-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-col), 1fr));
  grid-auto-rows: min-content;
  align-content: start;
  gap: var(--grid-gap-compact);
}

@media (max-width: 768px) {
  .photo-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--spacing-sm, 4px);
  }

  .photo-grid-scroll {
    padding: var(--spacing-sm, 4px);
  }

  /* Shared header on phones: hide the view-mode button labels (icons
     stay) and tighten the description so the whole header stays on
     one or two lines. */
  .shared-header { padding: 0.35rem 0.6rem; gap: 0.35rem 0.5rem; }
  .shared-header .title { font-size: 1rem; }
  .shared-header .description {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .shared-view-mode-btn { padding: 0.25rem 0.5rem; }
  .shared-view-mode-btn span { display: none; }
  .shared-view-mode-btn .pi { font-size: 1em; }

  /* On phones the grid view scrolls the whole page instead of a
     fixed-height inner container: banner + album title scroll away
     once the grid is tall enough, freeing the viewport for photos.
     Desktop keeps the sticky-header layout (inner scroll container)
     because there's horizontal room for both at once. Map mode is
     untouched — it still needs a constrained-height flex column. */
  .shared-album-view--grid {
    height: auto;
    min-height: 100dvh;
    overflow: visible;
  }
  .shared-album-view--grid .photo-grid-scroll {
    flex: 0 0 auto;
    overflow: visible;
  }
}

.grid-item {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
  background: var(--p-content-hover-background, #eee);
}

.grid-item :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

@media (hover: hover) {
  .grid-item:hover {
    opacity: 0.85;
  }
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}
</style>

<!--
  Global (unscoped) styles for elements rendered inside FullscreenOverlay's
  <Teleport to="body">. Scoped CSS can fail to reach teleported content.
  All selectors use unique class names that only SharedAlbumView creates,
  so they cannot leak into other views.
-->
<style>
/* ── Topbar-center slot content ──────────────────────────────────────────── */

.fullscreen-overlay .shared-fs-info-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.3;
  min-width: 0;
  max-width: 100%;
}

.fullscreen-overlay .shared-fs-date {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.fullscreen-overlay .shared-fs-location {
  opacity: 0.7;
  font-size: 0.75em;
  display: flex;
  align-items: center;
  gap: 0.3em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}


/* ── Info panel (slides up from bottom, 40% height) ──────────────────────── */

/* Guest photo-details panel. Rendered inside FullscreenOverlay's
   `#details-flyout` slot, so the overlay owns all positioning (split
   panes in landscape, stacked in portrait). This block only styles the
   inner content. The split panes use the themed `--p-content-background`,
   so text uses the themed tokens — no hardcoded white as in the old
   dark slide-up panel. */
.guest-photo-details {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 0.95rem;
  line-height: 1.4;
  color: var(--p-text-color);
}

.info-row .pi {
  margin-top: 0.15rem;
  opacity: 0.6;
  flex-shrink: 0;
  font-size: 0.95rem;
}

.info-row > span,
.info-row > p {
  margin: 0;
  min-width: 0;
  word-wrap: break-word;
}

.info-date {
  font-weight: 500;
}

.info-location {
  color: var(--p-text-muted-color);
}

.info-location-link {
  color: var(--p-primary-color);
  text-decoration: none;
}

.info-location-link:active {
  opacity: 0.7;
}

.info-description {
  color: var(--p-text-muted-color);
  white-space: pre-wrap;
}

/* The mini-map spans the full panel width — no leading icon column, so
   override the flex row layout the other info-rows use. */
.info-map {
  display: block;
}

.info-comments {
  display: block;
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}

@media (max-width: 768px) {
  .guest-photo-details {
    padding: 1rem;
    gap: 0.75rem;
  }

  .info-row {
    font-size: 0.9rem;
  }
}
</style>
