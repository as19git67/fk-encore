<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import FilterMenu from '../components/FilterMenu.vue'
import GuestStatusBanner from '../components/GuestStatusBanner.vue'
import GuestRegisterDialog from '../components/GuestRegisterDialog.vue'
import GuestAccountDialog from '../components/GuestAccountDialog.vue'
import GuestPhotoReactions from '../components/GuestPhotoReactions.vue'
import { getPublicAlbum, getPhotoUrl, type PhotoFilter, type PublicAlbumResponse, type PublicAlbumPhoto, type Photo } from '../api/photos'
import { matchesPhotoFilter } from '../utils/photoFilter'
import { countActiveFilters } from '../composables/useFilter'
import { formatPhotoDate, formatLocationLabel } from '../utils/dateFormat'
import { useGuestSession } from '../composables/useGuestSession'
import { useGuestPushNotifications } from '../composables/useGuestPushNotifications'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))

const route = useRoute()
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

watch(album, (a) => {
  if (!a) return
  // Map-enabled albums open in map view (the curated experience).
  viewMode.value = a.display_mode === 'map' ? 'map' : 'grid'
}, { immediate: true })

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

function handleMapFullscreen(dayPhotos: Photo[], startIndex: number, _day: string) {
  // Scope navigation to the photos of the day TripMap currently has
  // selected. The user can only step through the day's photos in
  // fullscreen — other days are reached via the timeline.
  fullscreenPhotos.value = dayPhotos
  fullscreenIndex.value = Math.max(0, Math.min(startIndex, dayPhotos.length - 1))
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

// ── Info panel (slides up from bottom, photo shrinks to 60%) ────────────────

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
        v-if="!isMapView"
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
      :showDetailsButton="showInfoButton"
      :detailsActive="showInfo"
      :autoAdvanceMs="10000"
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
      <template #bottom-bar>
        <div
          class="shared-album-info-panel"
          :class="{ 'is-open': showInfo }"
          @click.stop
          @touchstart.stop
          @touchend.stop
          @touchmove.stop
        >
          <div v-if="currentPhoto" class="info-panel-content">
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
            <div v-if="currentDescription" class="info-row info-description">
              <i class="pi pi-align-left" />
              <p>{{ currentDescription }}</p>
            </div>
            <div v-if="currentPhoto" class="info-row info-comments">
              <GuestPhotoReactions
                :share-token="shareToken"
                :photo-id="currentPhoto.id"
                :guest="guestSession.guest.value"
                @request-register="openRegisterDialog"
                @request-verify="handleResendVerifyMail"
              />
            </div>
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
  background: var(--p-surface-ground, #f8f9fa);
}

.shared-header {
  padding: 1.5rem 1rem;
  text-align: center;
  background: var(--p-surface-card, #fff);
  border-bottom: 1px solid var(--p-content-border-color, #dee2e6);
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
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
}

.shared-header .description {
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
}

.shared-header .meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

/* Toggle between raster + map for albums where the owner enabled the map.
   Lives inside the centred header, sized to read as a quiet utility. */
.shared-view-mode-switch {
  display: inline-flex;
  margin-top: 0.75rem;
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

.shared-album-info-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40dvh;
  background: rgba(18, 18, 18, 0.96);
  backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.92);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  transform: translateY(100%);
  transition: transform 0.3s ease;
  z-index: 11;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
  padding-bottom: calc(1.25rem + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
}

.shared-album-info-panel.is-open {
  transform: translateY(0);
}

.info-panel-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 48rem;
  margin: 0 auto;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  font-size: 0.95rem;
  line-height: 1.4;
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
  color: rgba(255, 255, 255, 0.95);
  font-weight: 500;
}

.info-location {
  color: rgba(255, 255, 255, 0.8);
}

.info-location-link {
  color: rgba(120, 180, 255, 0.95);
  text-decoration: none;
}

.info-location-link:active {
  opacity: 0.7;
}

.info-description {
  color: rgba(255, 255, 255, 0.75);
  white-space: pre-wrap;
}

/* Comment thread inside the slide-up panel. The panel forces a dark
   backdrop regardless of the active app theme, so the shared
   PhotoCommentThread would pick up the light-mode `--p-text-color`
   and render its bubble text as dark-on-dark. Override the tokens
   the base reads (text, muted, border) with values from Aura's
   absolute surface palette so everything inside stays legible
   without any hardcoded colours. */
.info-comments {
  display: block;
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--p-surface-0) 12%, transparent);
  --p-text-color: var(--p-surface-0);
  --p-text-muted-color: var(--p-surface-300);
  --p-surface-border-color: color-mix(in srgb, var(--p-surface-0) 18%, transparent);
}

@media (max-width: 768px) {
  .shared-album-info-panel {
    padding: 1rem 1rem;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }

  .info-panel-content {
    gap: 0.75rem;
  }

  .info-row {
    font-size: 0.9rem;
  }
}

/* ── Photo shrink + nav hide when info panel is open ─────────────────────── */

.fullscreen-content:has(> .shared-album-info-panel.is-open) {
  padding-top: 3.5rem;
  padding-bottom: 40dvh;
  transition: padding 0.3s ease;
}

/* Hide nav buttons while info panel is open to avoid overlap */
.fullscreen-overlay:has(.shared-album-info-panel.is-open) .fs-nav {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
</style>
