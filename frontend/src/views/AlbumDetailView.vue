<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import PhotoGrid from '../components/PhotoGrid.vue'
import TimelineNav from '../components/TimelineNav.vue'
import FullscreenOverlay from '../components/FullscreenOverlay.vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import PhotoCompareView from '../components/PhotoCompareView.vue'

const TripMap = defineAsyncComponent(() => import('../components/TripMap.vue'))
import {
  type ActiveView,
  type AlbumWithPhotos,
  deleteAlbum,
  getPhotoFaces,
  getAlbum,
  getPhotoLandmarks,
  ignoreFace,
  listPersons,
  listPhotoGroups,
  reindexPhoto,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type Person,
  type Photo,
  type PhotoGroup,
  updatePhotoCuration,
  updateAlbum,
  updateAlbumUserSettings,
  batchFavoritePhotos
} from '../api/photos'
import { useAuthStore } from '../stores/auth'
import { useServiceHealthStore } from '../stores/serviceHealth'
import { usePhotoGrouping } from '../composables/usePhotoGrouping'
import { useGalleryKeyboard } from '../composables/useGalleryKeyboard'
import type { PhotoItem } from '../composables/usePhotoGrouping'
import { onUnmounted } from 'vue'

const route = useRoute()
const router = useRouter()
const albumId = Number(route.params.id)
const auth = useAuthStore()
const serviceHealth = useServiceHealthStore()

// ── Data ──────────────────────────────────────────────────────────────────────
const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)
watch(isFullscreen, (val) => {
  if (!val) nextTick(() => photoGridRef.value?.scrollToPhoto(selectedIndex.value, 'instant'))
})
const activeSection = ref('')

// Flat Photo[] for composables, sorted oldest-first
const albumPhotos = computed<Photo[]>(() =>
  [...((album.value?.photos ?? []) as Photo[])].sort((a, b) =>
    new Date(a.taken_at || a.created_at).getTime() -
    new Date(b.taken_at || b.created_at).getTime()
  )
)

// ── Similar-photo groups (stacks) ─────────────────────────────────────────────
// Load all user's groups; filter to those with 2+ members in this album.
const photoGroupsList = ref<PhotoGroup[]>([])
const activeGroup = ref<PhotoGroup | null>(null)

const albumPhotoIds = computed(() => new Set(albumPhotos.value.map(p => p.id)))

// Groups scoped to this album: only include groups where at least 2 photos
// are in the album. Trim each group's member list to the album members and
// choose an album-internal cover photo.
const albumPhotoGroups = computed<PhotoGroup[]>(() => {
  const result: PhotoGroup[] = []
  for (const g of photoGroupsList.value) {
    const membersInAlbum = g.photo_ids.filter(id => albumPhotoIds.value.has(id))
    if (membersInAlbum.length < 2) continue
    const coverInAlbum = g.cover_photo_id && albumPhotoIds.value.has(g.cover_photo_id)
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

const photoToGroup = computed(() => {
  const map = new Map<number, PhotoGroup>()
  // Reviewed first, unreviewed last — so unreviewed groups win for photos
  // that belong to both (happens transiently when members were added and a
  // new superset group was created alongside the old reviewed one).
  for (const group of albumPhotoGroups.value) {
    if (!group.reviewed_at) continue
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  for (const group of albumPhotoGroups.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) map.set(pid, group)
  }
  return map
})

const unreviewedGroupCount = computed(() =>
  albumPhotoGroups.value.filter(g => !g.reviewed_at).length
)

const hiddenByStack = computed(() => {
  const set = new Set<number>()
  for (const group of albumPhotoGroups.value) {
    if (group.reviewed_at) continue
    for (const pid of group.photo_ids) {
      if (pid !== group.cover_photo_id) set.add(pid)
    }
  }
  return set
})

// ── Grouping (via composable) ─────────────────────────────────────────────────
const { groupedPhotos } = usePhotoGrouping(albumPhotos, {
  hiddenByStack,
  photoToGroup,
})

// ── Navigation refs ───────────────────────────────────────────────────────────
const photoGridRef = ref<InstanceType<typeof PhotoGrid> | null>(null)
const timelineNavRef = ref<InstanceType<typeof TimelineNav> | null>(null)

// ── Keyboard navigation (via composable) ─────────────────────────────────────
useGalleryKeyboard({
  isBlocked: () => !!activeGroup.value,
  onLeft() {
    if (isFullscreen.value) { if (selectedIndex.value > 0) selectedIndex.value--; return }
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = albumPhotos.value.length - 1
  },
  onRight() {
    if (isFullscreen.value) {
      if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++; return
    }
    if (selectedIndex.value < albumPhotos.value.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  },
  onUp() { timelineNavRef.value?.navigateUp() },
  onDown() { timelineNavRef.value?.navigateDown() },
  onSpace() {
    if (selectedIndex.value !== -1) isFullscreen.value = !isFullscreen.value
  },
  onExtra(e) {
    if (e.key === 'Escape' && isFullscreen.value) { isFullscreen.value = false; e.preventDefault() }
    else if (e.key === 'Enter' && !isFullscreen.value && selectedIndex.value !== -1) { isFullscreen.value = true; e.preventDefault() }
    else if ((e.key === 'f' || e.key === 'F') && selectedPhoto.value) { handleToggleFavorite(selectedPhoto.value.id, selectedPhoto.value.curation_status); e.preventDefault() }
  },
})

// ── Computed ──────────────────────────────────────────────────────────────────
const selectedPhoto = computed(() =>
  selectedIndex.value >= 0 ? albumPhotos.value[selectedIndex.value] ?? null : null
)
const prevPhoto = computed(() =>
  selectedIndex.value > 0 ? albumPhotos.value[selectedIndex.value - 1] ?? null : null
)
const nextPhoto = computed(() =>
  selectedIndex.value < albumPhotos.value.length - 1
    ? albumPhotos.value[selectedIndex.value + 1] ?? null : null
)

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const isOwner = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const canManageData = computed(() => auth.hasPermission('data.manage'))
const showPersons = computed(() => auth.hasPermission('people.view'))

// ── Display mode (Album-Eigenschaft) ─────────────────────────────────────────
const displayMode = ref<'grid' | 'map'>('grid')

watch(album, (a) => {
  if (a) displayMode.value = a.display_mode ?? 'grid'
}, { immediate: true })

// ── Map fullscreen ───────────────────────────────────────────────────────────
const tripMapRef = ref<{ selectStopByPhotoId: (id: number) => boolean } | null>(null)
const mapFullscreenPhotos = ref<Photo[]>([])
const mapFullscreenIndex = ref(0)
const isMapFullscreen = ref(false)

function handleMapFullscreen(stopPhotos: Photo[], startIndex: number) {
  // Use all album photos so left/right navigation works across stops
  const allPhotos = albumPhotos.value
  const targetPhoto = stopPhotos[startIndex]
  const globalIndex = targetPhoto ? allPhotos.findIndex(p => p.id === targetPhoto.id) : -1
  mapFullscreenPhotos.value = allPhotos
  mapFullscreenIndex.value = globalIndex >= 0 ? globalIndex : 0
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
  isMapFullscreen.value = false
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
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])

watch(selectedPhoto, (photo) => {
  if (photo) {
    loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

watch(selectedIndex, () => {
  const photo = selectedPhoto.value
  if (photo && !isFullscreen.value) {
    const el = photoGridRef.value?.scrollRef?.querySelector(`[data-photo-id="${photo.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
})

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  loading.value = true
  try {
    const [albumRes, groupsRes] = await Promise.all([
      getAlbum(albumId),
      listPhotoGroups().catch(() => ({ groups: [] })),
    ])
    album.value = albumRes
    photoGroupsList.value = groupsRes.groups
    selectedIndex.value = album.value.photos.length > 0 ? 0 : -1
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Albums'
  } finally {
    loading.value = false
  }
}

async function handleSettingsChange() {
  if (!album.value?.settings) return
  try {
    await updateAlbumUserSettings(albumId, album.value.settings)
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Einstellungen'
  }
}

async function loadPersons() {
  try { persons.value = (await listPersons()).persons } catch { /* ignore */ }
}

async function loadSidebarData(photoId: number) {
  loadingFaces.value = true
  loadingLandmarks.value = true
  try {
    const [facesRes, landmarksRes] = await Promise.all([getPhotoFaces(photoId), getPhotoLandmarks(photoId)])
    detectedFaces.value = facesRes.faces
    detectedLandmarks.value = landmarksRes.landmarks
  } catch { detectedFaces.value = []; detectedLandmarks.value = [] }
  finally { loadingFaces.value = false; loadingLandmarks.value = false }
}

// ── Curation ──────────────────────────────────────────────────────────────────
function updatePhotoStatus(id: number, status: CurationStatus) {
  if (!album.value) return
  album.value.photos = album.value.photos.map(p => p.id === id ? { ...p, curation_status: status } : p)
}

async function handleHidePhoto(id: number) {
  try { await updatePhotoCuration(id, 'hidden'); updatePhotoStatus(id, 'hidden') }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleRestorePhoto(id: number) {
  try { await updatePhotoCuration(id, 'visible'); updatePhotoStatus(id, 'visible') }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  updatePhotoStatus(id, newStatus)
  try { await updatePhotoCuration(id, newStatus) }
  catch (err: any) { updatePhotoStatus(id, currentStatus); error.value = err.message || 'Fehler' }
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try { await ignoreFace(faceId); detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId) }
  catch (err: any) { error.value = err.message || 'Fehler' }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try { await reindexPhoto(selectedPhoto.value.id); await loadSidebarData(selectedPhoto.value.id) }
  catch (err: any) { error.value = err.message || 'Fehler' }
  finally { reindexingPhoto.value = false }
}

function handleCoverPhotoIdUpdate(id: number | null) {
  if (!album.value) return
  if (canWrite.value) {
    album.value.cover_photo_id = id ?? undefined
  } else {
    // Viewer: update user-specific settings
    if (!album.value.settings) return
    album.value.settings.cover_photo_id = id
  }
}

async function handleSetMapCover(photoId: number) {
  if (!album.value) return
  const newCoverId = effectiveCoverPhotoId.value === photoId ? null : photoId
  try {
    if (canWrite.value) {
      await updateAlbum(albumId, { coverPhotoId: newCoverId })
      album.value.cover_photo_id = newCoverId ?? undefined
    } else {
      await updateAlbumUserSettings(albumId, { cover_photo_id: newCoverId })
      if (album.value.settings) album.value.settings.cover_photo_id = newCoverId
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Setzen des Covers'
  }
}

// ── Delete album ─────────────────────────────────────────────────────────────
const showDeleteDialog = ref(false)
const deletingAlbum = ref(false)

async function handleDeleteAlbum() {
  if (!album.value) return
  deletingAlbum.value = true
  try {
    await deleteAlbum(album.value.id)
    showDeleteDialog.value = false
    router.push({ name: 'fotos-albums' })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    deletingAlbum.value = false
  }
}

// ── Grid interaction ──────────────────────────────────────────────────────────
function handlePhotoClick(item: PhotoItem) {
  selectedIndex.value = item.index
  // Mobile: Single-Tap öffnet Fullscreen (kein Sidebar sichtbar)
  if (window.innerWidth <= 768) isFullscreen.value = true
}

// ── Stack / similar-photo group handling ─────────────────────────────────────
function handleStackClick(group: PhotoGroup) {
  activeGroup.value = group
}

function selectAfterGroup(group: PhotoGroup | null) {
  if (!group || albumPhotos.value.length === 0) {
    selectedIndex.value = albumPhotos.value.length > 0 ? 0 : -1
    return
  }
  const groupPhotoIds = new Set(group.photo_ids)
  const visible = albumPhotos.value
    .map((p, i) => ({ photo: p, index: i }))
    .filter(({ photo }) => groupPhotoIds.has(photo.id) && !hiddenByStack.value.has(photo.id))
  if (visible.length > 0) {
    selectedIndex.value = visible[0]!.index
    return
  }
  selectedIndex.value = albumPhotos.value.findIndex(p => !hiddenByStack.value.has(p.id))
}

async function handleGroupClose() {
  const group = activeGroup.value
  activeGroup.value = null
  await loadData() // reloads album photos and groups
  selectAfterGroup(group)
}

async function handleGroupNext(reviewedGroupId: number) {
  const candidateId = albumPhotoGroups.value.find(g => !g.reviewed_at && g.id !== reviewedGroupId)?.id
  await loadData()
  if (candidateId !== undefined) {
    // Re-resolve against the freshly loaded list so photo_ids reflect the latest album state.
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
  if (first) activeGroup.value = first
}

// ── Timeline nav ──────────────────────────────────────────────────────────────
function handleScrollTo(sectionId: string) {
  photoGridRef.value?.scrollToSection(sectionId)
  activeSection.value = sectionId

  // Select first photo in the target section
  for (const yearGroup of groupedPhotos.value) {
    if (yearGroup.sectionId === sectionId) {
      const firstMonth = yearGroup.months[0]
      if (firstMonth?.photos.length) {
        selectedIndex.value = firstMonth.photos[0]!.index
      }
      return
    }
    for (const monthGroup of yearGroup.months) {
      if (monthGroup.sectionId === sectionId && monthGroup.photos.length) {
        selectedIndex.value = monthGroup.photos[0]!.index
        return
      }
    }
  }
}

// ── Album cover ───────────────────────────────────────────────────────────────
// Effective cover: user-specific setting takes precedence over album-level cover
const effectiveCoverPhotoId = computed(() => {
  if (!album.value) return undefined
  return album.value.settings?.cover_photo_id ?? album.value.cover_photo_id
})

async function scrollToCover() {
  if (!effectiveCoverPhotoId.value) return
  const idx = albumPhotos.value.findIndex(p => p.id === effectiveCoverPhotoId.value)
  if (idx >= 0) selectedIndex.value = idx
}

// ── Description editing ───────────────────────────────────────────────────────
const updatingAlbum = ref(false)
const editingDescription = ref(false)
const descDraft = ref('')

function startEditDesc() {
  if (!album.value) return
  descDraft.value = album.value.description || ''
  editingDescription.value = true
}

async function saveDescription() {
  if (!album.value) return
  updatingAlbum.value = true
  try {
    await updateAlbum(albumId, { description: descDraft.value })
    album.value.description = descDraft.value
    editingDescription.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Beschreibung'
  } finally {
    updatingAlbum.value = false
  }
}

const viewOptions = [
  { label: 'Alle Fotos', value: 'all', icon: 'pi pi-images' },
  { label: 'Meine Favoriten', value: 'favorites', icon: 'pi pi-heart' },
  { label: 'Gruppen-Highlights', value: 'consensus', icon: 'pi pi-star' },
  { label: 'Favoriten anderer', value: 'others-favorites', icon: 'pi pi-users' },
]

// Show shared-only options only for shared albums
const availableViewOptions = computed(() => {
  if (album.value?.is_shared || (album.value && album.value.role !== 'owner')) return viewOptions
  return viewOptions.filter(o => o.value !== 'consensus' && o.value !== 'others-favorites')
})

// Batch favorite all visible photos (for "others-favorites" view)
const batchFavoriting = ref(false)

async function handleBatchFavoriteAll() {
  if (!album.value) return
  const photoIds = albumPhotos.value.map(p => p.id)
  if (photoIds.length === 0) return
  batchFavoriting.value = true
  try {
    await batchFavoritePhotos(albumId, photoIds)
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Favorisieren'
  } finally {
    batchFavoriting.value = false
  }
}
// ── Mobile drawer state ───────────────────────────────────────────────────────
const mobileTimelineOpen = ref(false)
const mobileSidebarOpen = ref(false)

// ── Init ──────────────────────────────────────────────────────────────────────
void loadData()
if (showPersons.value) void loadPersons()
serviceHealth.startPolling()
onUnmounted(() => serviceHealth.stopPolling())
</script>

<template>
  <div class="album-detail-view">
    <ServiceStatusBar />

    <div v-if="album" class="subheader">
      <div class="header">
        <!-- 1. Album name -->
        <h1 class="header__title">{{ album.name }}</h1>

        <!-- 2. Role badge -->
        <span :class="['header__badge', `header__badge--${album.role}`]">{{ album.role }}</span>

        <!-- 3. Description with edit -->
        <div v-if="displayMode !== 'map'" class="header__description">
          <div v-if="!editingDescription" class="header__description-view">
            <span :class="{ 'header__description-text--empty': !album.description }" class="header__description-text">
              {{ album.description || 'Keine Beschreibung' }}
            </span>
            <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc" />
          </div>
          <div v-else class="header__description-edit">
            <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="2" />
            <div class="header__description-edit-actions">
              <Button :loading="updatingAlbum" icon="pi pi-check" size="small" @click="saveDescription" />
              <Button :disabled="updatingAlbum" icon="pi pi-times" size="small" text @click="editingDescription = false" />
            </div>
          </div>
        </div>

        <!-- 4. Metadata -->
        <div class="header__meta">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            &bull; {{ new Date(album.oldest_photo_at).toLocaleDateString() }} – {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </div>

        <!-- 5a. View switcher – DESKTOP (text labels) -->
        <div v-if="album.settings" class="header__views-desktop">
          <SelectButton v-model="album.settings.active_view" :options="availableViewOptions" optionLabel="label" optionValue="value" @change="handleSettingsChange" />
          <Button
            v-if="album.settings.active_view === 'others-favorites' && albumPhotos.length > 0"
            icon="pi pi-heart-fill"
            :label="`Alle favorisieren (${albumPhotos.length})`"
            size="small"
            severity="warn"
            :loading="batchFavoriting"
            @click="handleBatchFavoriteAll"
          />
        </div>

        <!-- 5b. View switcher – MOBILE (icon-only) -->
        <div v-if="album.settings" class="header__views-mobile">
          <div class="mobile-view-switcher">
            <button
              v-for="opt in availableViewOptions"
              :key="opt.value"
              :class="['mobile-view-btn', { 'mobile-view-btn--active': album.settings!.active_view === opt.value }]"
              @click="album.settings!.active_view = opt.value as ActiveView; handleSettingsChange()"
            >
              <i :class="opt.icon" />
              <span v-if="album.settings!.active_view === opt.value" class="mobile-view-btn__label">{{ opt.label }}</span>
            </button>
          </div>
          <Button
            v-if="album.settings.active_view === 'others-favorites' && albumPhotos.length > 0"
            icon="pi pi-heart-fill"
            size="small"
            severity="warn"
            :loading="batchFavoriting"
            v-tooltip="'Alle favorisieren'"
            @click="handleBatchFavoriteAll"
          />
        </div>

        <!-- 6. Action buttons -->
        <div class="header__actions">
          <Button
            v-if="canManageData && unreviewedGroupCount > 0 && displayMode !== 'map'"
            :label="`Gruppen bearbeiten (${unreviewedGroupCount} offen)`"
            icon="pi pi-images" severity="success" size="small"
            @click="handleStartGroupReview"
          />
          <Button v-if="effectiveCoverPhotoId && displayMode !== 'map'" icon="pi pi-image" label="Cover fokussieren" size="small" text @click="scrollToCover" />
          <Button v-if="isOwner" icon="pi pi-trash" size="small" text severity="danger" v-tooltip="'Album löschen'" @click="showDeleteDialog = true" />
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && !album" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Album wird geladen…
    </div>

    <!-- Map mode -->
    <TripMap
      v-if="album && displayMode === 'map' && albumPhotos.length > 0"
      ref="tripMapRef"
      :photos="albumPhotos"
      :albumName="album.name"
      :albumDescription="album.description"
      @open-fullscreen="handleMapFullscreen"
    />

    <!-- Three-column layout: TimelineNav | PhotoGrid | Sidebar -->
    <div v-else-if="album && groupedPhotos.length > 0" class="gallery-layout">
      <!-- LEFT: Timeline nav – auf Mobile als Slide-in-Drawer -->
      <div class="timeline-drawer" :class="{ 'is-open': mobileTimelineOpen }">
        <TimelineNav
          ref="timelineNavRef"
          :groupedPhotos="groupedPhotos"
          :activeSection="activeSection"
          @scroll-to="handleScrollTo"
        />
      </div>

      <!-- CENTER: Photo grid -->
      <PhotoGrid
        ref="photoGridRef"
        :groupedPhotos="groupedPhotos"
        :photos="albumPhotos"
        :selectedIndex="selectedIndex"
        :selectedPhotoIds="new Set(selectedPhoto ? [selectedPhoto.id] : [])"
        :canDelete="false"
        :hasStacks="true"
        :suppressScroll="isFullscreen"
        @update:columnCount="() => {}"
        @section-change="activeSection = $event"
        @photo-click="handlePhotoClick"
        @photo-dblclick="isFullscreen = true"
        @stack-click="handleStackClick"
        @toggle-favorite="handleToggleFavorite"
        @hide="handleHidePhoto"
        @restore="handleRestorePhoto"
      />

      <!-- RIGHT: Details sidebar – auf Mobile als Bottom-Sheet -->
      <div class="sidebar-sheet" :class="{ 'is-open': mobileSidebarOpen }">
        <div class="sidebar-sheet-header">
          <button class="sidebar-sheet-close" @click="mobileSidebarOpen = false" aria-label="Schließen">
            <i class="pi pi-times" />
          </button>
        </div>
        <PhotoDetailSidebar
          v-if="selectedPhoto"
          :photo="selectedPhoto"
          :can-delete="canDeletePhotos || canWrite"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="false"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :reindexing-photo="reindexingPhoto"
          :updating-date="false"
          :album-id="albumId"
          :cover-photo-id="effectiveCoverPhotoId"
          :album-role="album.role"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          :face-service-available="serviceHealth.faceServiceAvailable"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @fullscreen="isFullscreen = true"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </div>
    </div>

    <div v-else-if="album" class="info-text">Keine Fotos in dieser Ansicht.</div>

    <!-- Mobile: Backdrop zum Schließen von Drawern -->
    <div
      v-if="mobileTimelineOpen || mobileSidebarOpen"
      class="mobile-backdrop"
      @click="mobileTimelineOpen = false; mobileSidebarOpen = false"
    />

    <!-- Mobile: Floating-Button Zeitleiste -->
    <button
      v-if="album && groupedPhotos.length > 0 && displayMode === 'grid'"
      class="mobile-fab mobile-fab--timeline"
      :class="{ active: mobileTimelineOpen }"
      @click="mobileTimelineOpen = !mobileTimelineOpen; mobileSidebarOpen = false"
      aria-label="Zeitleiste"
    >
      <i class="pi pi-calendar" />
    </button>


    <!-- Fullscreen overlay (Grid mode) -->
    <FullscreenOverlay
      v-if="isFullscreen && selectedPhoto"
      :photo="selectedPhoto"
      :prevPhoto="prevPhoto"
      :nextPhoto="nextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="false"
      @close="isFullscreen = false"
      @prev="selectedIndex--"
      @next="selectedIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="isFullscreen = false; mobileSidebarOpen = true; mobileTimelineOpen = false"
    />

    <!-- Fullscreen overlay (Map mode – scoped to stop photos) -->
    <FullscreenOverlay
      v-if="isMapFullscreen && mapSelectedPhoto"
      :photo="mapSelectedPhoto"
      :prevPhoto="mapPrevPhoto"
      :nextPhoto="mapNextPhoto"
      :canDelete="canDeletePhotos || canWrite"
      :showDetailsButton="true"
      :detailsActive="false"
      @close="closeMapFullscreen"
      @prev="mapFullscreenIndex--"
      @next="mapFullscreenIndex++"
      @toggle-favorite="handleToggleFavorite"
      @hide="handleHidePhoto"
      @restore="handleRestorePhoto"
      @show-details="closeMapFullscreen"
    >
      <template #topbar-actions>
        <Button
          :icon="effectiveCoverPhotoId === mapSelectedPhoto.id ? 'pi pi-image-check' : 'pi pi-image'"
          rounded text
          :severity="effectiveCoverPhotoId === mapSelectedPhoto.id ? 'warn' : 'secondary'"
          v-tooltip.bottom="effectiveCoverPhotoId === mapSelectedPhoto.id ? 'Vom Cover entfernen' : 'Als Cover setzen'"
          @click="handleSetMapCover(mapSelectedPhoto.id)"
        />
        <Button
          icon="pi pi-info-circle" rounded text severity="secondary"
          @click="closeMapFullscreen"
          v-tooltip.bottom="'Schließen'"
        />
        <Button
          v-if="canDeletePhotos || canWrite"
          :icon="mapSelectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
          rounded text
          :severity="mapSelectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'"
          @click="handleToggleFavorite(mapSelectedPhoto.id, mapSelectedPhoto.curation_status)"
          v-tooltip.bottom="mapSelectedPhoto.curation_status === 'favorite' ? 'Favorit entfernen' : 'Als Favorit markieren'"
        />
      </template>
    </FullscreenOverlay>

    <!-- Similar-photo group review overlay -->
    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :allPhotos="albumPhotos"
      :totalUnreviewed="unreviewedGroupCount"
      @close="handleGroupClose"
      @next="handleGroupNext"
    />

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

.header__actions { display: flex; align-items: center; gap: 0.25em; }

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

.header__description {
  flex: 1 1 auto;
  min-width: 0;
}
.header__description-view { display: flex; align-items: center; gap: 0.5em; }
.header__description-text { font-size: 0.9em; }
.header__description-text--empty { color: var(--p-text-muted-color); font-style: italic; }
.header__description-edit { display: flex; align-items: center; gap: 0.5em; width: 100%; }
.header__description-edit textarea { flex: 1; min-height: 2.5em; }
.header__description-edit-actions { display: flex; gap: 0.25em; }

.header__meta {
  font-size: 0.85em;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

/* Desktop view switcher: visible by default */
.header__views-desktop { display: flex; align-items: center; gap: 0.5em; }

/* Mobile view switcher: hidden by default */
.header__views-mobile { display: none; }

/* ── Three-column layout ─────────────────────────────────────────────────── */
.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.info-text {
  text-align: center;
  padding: 3em 1em;
  color: var(--p-text-muted-color);
}

/* ── Timeline Drawer Wrapper ─────────────────────────────────────────────── */
.timeline-drawer { display: contents; }

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

/* ── Mobile FABs ─────────────────────────────────────────────────────────── */
.mobile-fab {
  display: none;
  position: fixed;
  bottom: 1.5em;
  z-index: var(--z-mobile-fab);
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  font-size: 1.1em;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  transition: background 0.2s;
}
.mobile-fab--timeline {
  left: 1em;
  background: var(--p-content-background);
  color: var(--p-primary-color);
  border: 1px solid var(--p-content-border-color);
}
.mobile-fab--timeline.active {
  background: var(--p-primary-color);
  color: white;
}


/* ── Mobile Breakpoint ───────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .mobile-backdrop { display: block; }
  .mobile-fab { display: flex; }

  .album-detail-view { margin-inline: 0; }

  .timeline-drawer {
    display: block;
    position: fixed;
    left: 0;
    top: var(--menubar-height, 3.5em);
    bottom: 0;
    width: 80px;
    z-index: var(--z-mobile-drawer);
    background: var(--p-content-background);
    border-right: 1px solid var(--p-content-border-color);
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 3px 0 12px rgba(0, 0, 0, 0.2);
    overflow-y: auto;
  }
  .timeline-drawer.is-open { transform: translateX(0); }

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

  /* Swap view switcher variants */
  .header__views-desktop { display: none; }
  .header__views-mobile { display: flex; flex-wrap: wrap; gap: 0.35em; align-items: center; flex: 1 1 100%; order: 10; }

  /* Compact header on mobile */
  .header { padding: 0.35em 0.65em; gap: 0.25em 0.5em; }
  .header__title { font-size: 1.1em; }
  .header__description { flex: 1 1 100%; }
  .header__description-text--empty { display: none; }

  /* ── Mobile view switcher (custom segmented control) ──────────────────── */
  .mobile-view-switcher {
    display: flex;
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--p-border-radius, 6px);
    overflow: hidden;
  }
  .mobile-view-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3em;
    padding: 0.4em 0.5em;
    border: none;
    background: var(--p-content-background);
    color: var(--p-text-color);
    font-size: 0.8em;
    cursor: pointer;
    transition: background 0.15s;
  }
  .mobile-view-btn + .mobile-view-btn {
    border-left: 1px solid var(--p-content-border-color);
  }
  .mobile-view-btn--active {
    flex: 1;
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color, #fff);
    font-weight: 600;
  }
  .mobile-view-btn__label {
    white-space: nowrap;
  }
}

/* ── Delete dialog ──────────────────────────────────────────────────────── */
.dialog-body { display: flex; flex-direction: column; gap: 0.5em; padding: 0.5em 0; }
.dialog-body .muted { color: var(--p-text-muted-color); font-size: 0.9em; }

</style>
