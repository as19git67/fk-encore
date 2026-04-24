<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import FilterMenu from '../components/FilterMenu.vue'
import GuestStatusBanner from '../components/GuestStatusBanner.vue'
import GuestRegisterDialog from '../components/GuestRegisterDialog.vue'
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
 * True when the viewer is on the map display with no registered
 * guest session. Triggers two layout changes: the full-width banner
 * is suppressed and a compact "Anmelden" button is folded into the
 * TripMap stats overlay next to the Filter button. Once the guest
 * registers the banner returns for the pending-verify prompt and
 * later the opt-in toggles.
 */
const isMapAnonymous = computed(
  () => album.value?.display_mode === 'map' && guestSession.guest.value === null,
)

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
// Public / shared album opens with Highlights on and hidden photos excluded.
// We keep this state local — no URL sync, no query params — because the
// filter UX only makes sense while the viewer is on this page.
const DEFAULT_FILTER: PhotoFilter = { groupHighlight: true }
const FILTER_AVAILABLE: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'> = [
  'hiddenMode', 'groupHighlight',
]
const filter = ref<PhotoFilter>({ ...DEFAULT_FILTER })
const filterDraft = ref<PhotoFilter>({ ...DEFAULT_FILTER })
const filterMenuOpen = ref(false)
const activeCount = computed(() => countActiveFilters(filter.value))

function openFilterMenu() {
  filterDraft.value = { ...filter.value }
  filterMenuOpen.value = true
}
function onApplyFilter() {
  filter.value = { ...filterDraft.value }
}
function onResetFilter() {
  filter.value = { ...DEFAULT_FILTER }
  filterDraft.value = { ...DEFAULT_FILTER }
}

const groupCoverIds = computed<Set<number>>(() =>
  new Set((album.value?.photos ?? []).filter(p => p.is_highlight).map(p => p.id))
)

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
const photoCounter = computed(() => `${fullscreenIndex.value + 1} / ${fullscreenPhotos.value.length}`)

function openFullscreen(photo: Photo) {
  const photos = albumPhotosAsPhoto.value
  fullscreenPhotos.value = photos
  fullscreenIndex.value = photos.findIndex(p => p.id === photo.id)
  if (fullscreenIndex.value < 0) fullscreenIndex.value = 0
  fullscreenFromMap.value = false
  isFullscreen.value = true
}

function handleMapFullscreen(stopPhotos: Photo[], startIndex: number) {
  // Use all album photos so left/right navigation works across stops
  const allPhotos = albumPhotosAsPhoto.value
  const targetPhoto = stopPhotos[startIndex]
  const globalIndex = targetPhoto ? allPhotos.findIndex(p => p.id === targetPhoto.id) : -1
  fullscreenPhotos.value = allPhotos
  fullscreenIndex.value = globalIndex >= 0 ? globalIndex : 0
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
  // The default filter limits the view to "Highlights only". Albums
  // that carry no group-highlight photos would open with an empty
  // map / grid and leave the visitor staring at a blank canvas with
  // no obvious recovery. Relax the filter automatically in that
  // case so the visitor sees the real album content.
  if (album.value && filter.value.groupHighlight) {
    const ctx = { groupCoverIds: groupCoverIds.value }
    const matches = albumPhotosAsPhoto.value.filter((p) =>
      matchesPhotoFilter(p, filter.value, ctx),
    )
    if (matches.length === 0 && albumPhotosAsPhoto.value.length > 0) {
      filter.value = {}
      filterDraft.value = {}
    }
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
  <div class="shared-album-view">
    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <Message v-if="error" severity="error">{{ error }}</Message>

    <template v-if="album">
      <!-- In map mode we hide the banner when the visitor is still
           anonymous — the map already crowds the viewport and we
           replace it with a compact "Anmelden" pill next to the
           Filter button inside the stats overlay. Pending/verified
           guests keep the banner because they need verify info and
           the mail/push toggles. -->
      <GuestStatusBanner
        v-if="!isMapAnonymous"
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

      <div v-if="album.display_mode !== 'map'" class="shared-header">
        <h1 class="title">{{ album.name }}</h1>
        <p v-if="album.description" class="description">{{ album.description }}</p>
        <span class="meta">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            · {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
      </div>

      <!-- Map mode -->
      <TripMap
        v-if="album.display_mode === 'map' && album.photos.length > 0"
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
      v-model:visible="filterMenuOpen"
      v-model:draft="filterDraft"
      :available="FILTER_AVAILABLE"
      @apply="onApplyFilter"
      @reset="onResetFilter"
    />

    <!-- Fullscreen overlay (reuses shared FullscreenOverlay component) -->
    <FullscreenOverlay
      v-if="isFullscreen && currentPhoto"
      :photo="currentPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="false"
      :showDetailsButton="showInfoButton"
      :detailsActive="showInfo"
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
        <div v-if="fullscreenPhotos.length > 1 && !showInfo" class="fs-counter-pill">
          {{ photoCounter }}
        </div>
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

/* ── Counter pill ────────────────────────────────────────────────────────── */

.fs-counter-pill {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  background: rgba(0, 0, 0, 0.4);
  padding: 0.5rem 0.9rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
  z-index: 10;
  backdrop-filter: blur(6px);
  pointer-events: none;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .fs-counter-pill {
    top: auto;
    bottom: 4rem;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.5);
    padding: 0.75rem 1rem;
  }
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
