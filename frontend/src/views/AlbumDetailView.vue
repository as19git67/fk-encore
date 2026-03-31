<script lang="ts" setup>
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {useRoute} from 'vue-router'
import SelectButton from 'primevue/selectbutton'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import GalleryLayout from '../components/GalleryLayout.vue'
import HeicImage from '../components/HeicImage.vue'
import PhotoDetailSidebar from '../components/PhotoDetailSidebar.vue'
import {
  type AlbumWithPhotos,
  type AlbumShareWithUser,
  deletePhoto,
  getPhotoFaces,
  getAlbum,
  getAlbumShares,
  getPhotoLandmarks,
  getPhotoUrl,
  ignoreFace,
  listPersons,
  reindexPhoto,
  removeAlbumShare,
  shareAlbum,
  type CurationStatus,
  type Face,
  type LandmarkItem,
  type Person,
  updatePhotoCuration,
  updateAlbum,
  updateAlbumUserSettings
} from '../api/photos'
import { listUsers, type UserWithRoles } from '../api/users'
import {useAuthStore} from '../stores/auth'

const route = useRoute()
const albumId = Number(route.params.id)
const auth = useAuthStore()

const album = ref<AlbumWithPhotos | null>(null)
const loading = ref(true)
const error = ref('')

const selectedIndex = ref(-1)
const isFullscreen = ref(false)
const activeSection = ref('')

const viewOptions = [
  {label: 'Alle', value: 'all'},
  {label: 'Favoriten', value: 'favorites'}
]

const hideModeOptions = [
  {label: 'Meine ausgeblendeten', value: 'mine'},
  {label: 'Alle ausgeblendeten', value: 'all'}
]

async function loadData() {
  loading.value = true
  try {
    album.value = await getAlbum(albumId)
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
  try {
    const res = await listPersons()
    persons.value = res.persons
  } catch (err) {
    console.error('Failed to load persons:', err)
  }
}

async function loadSidebarData(photoId: number) {
  loadingFaces.value = true
  loadingLandmarks.value = true
  try {
    const [facesRes, landmarksRes] = await Promise.all([
      getPhotoFaces(photoId),
      getPhotoLandmarks(photoId),
    ])
    detectedFaces.value = facesRes.faces
    detectedLandmarks.value = landmarksRes.landmarks
  } catch (err) {
    console.error('Failed to load sidebar data:', err)
  } finally {
    loadingFaces.value = false
    loadingLandmarks.value = false
  }
}

const selectedPhoto = computed(() => {
  if (selectedIndex.value < 0 || !album.value) return null
  return album.value.photos[selectedIndex.value] || null
})

const prevPhoto = computed(() => {
  if (!album.value || selectedIndex.value <= 0) return null
  return album.value.photos[selectedIndex.value - 1] || null
})

const nextPhoto = computed(() => {
  if (!album.value || selectedIndex.value >= album.value.photos.length - 1) return null
  return album.value.photos[selectedIndex.value + 1] || null
})

function scrollToPhoto(photoId: number) {
  const el = gridScrollRef.value?.querySelector(`[data-photo-id="${photoId}"]`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    activeSection.value = id
  }
}

watch(selectedPhoto, (photo) => {
  if (photo) {
    loadSidebarData(photo.id)
    if (showPersons.value) void loadPersons()
  } else {
    detectedFaces.value = []
    detectedLandmarks.value = []
  }
})

watch(selectedIndex, (newIdx) => {
  const photo = album.value?.photos[newIdx]
  if (photo && !isFullscreen.value) scrollToPhoto(photo.id)
})

const canWrite = computed(() => album.value?.role === 'owner' || album.value?.role === 'contributor')
const isOwner = computed(() => album.value?.role === 'owner')
const canDeletePhotos = computed(() => auth.hasPermission('photos.delete'))
const canUploadPhotos = computed(() => auth.hasPermission('photos.upload'))
const showPersons = computed(() => auth.hasPermission('people.view'))

const detectedFaces = ref<Face[]>([])
const loadingFaces = ref(false)
const detectedLandmarks = ref<LandmarkItem[]>([])
const loadingLandmarks = ref(false)
const reindexingPhoto = ref(false)
const persons = ref<Person[]>([])

interface PhotoItem {
  photo: NonNullable<AlbumWithPhotos['photos']>[number]
  index: number
}

interface MonthGroup {
  month: string
  photos: PhotoItem[]
}

interface YearGroup {
  year: string
  months: MonthGroup[]
}

const groupedPhotos = computed<YearGroup[]>(() => {
  const groups: YearGroup[] = []
  if (!album.value) return groups

  for (const [index, photo] of album.value.photos.entries()) {
    const date = new Date(photo.taken_at || photo.created_at)
    const year = date.getFullYear().toString()
    const month = date.toLocaleString('de-DE', { month: 'long' })

    let yearGroup = groups.find(g => g.year === year)
    if (!yearGroup) {
      yearGroup = { year, months: [] }
      groups.push(yearGroup)
    }

    let monthGroup = yearGroup.months.find(m => m.month === month)
    if (!monthGroup) {
      monthGroup = { month, photos: [] }
      yearGroup.months.push(monthGroup)
    }

    monthGroup.photos.push({ photo, index })
  }

  // Newest year/month at top
  groups.reverse()
  for (const yg of groups) yg.months.reverse()

  return groups
})

// Flat list of section first-photo-indices for up/down keyboard nav
const flatSectionFirstIndices = computed<number[]>(() => {
  const indices: number[] = []
  for (const yg of groupedPhotos.value) {
    for (const mg of yg.months) {
      if (mg.photos.length > 0) {
        indices.push(mg.photos[0].index)
      }
    }
  }
  return indices
})

// ── Column count tracking ────────────────────────────────────────────────────
const columnCount = ref(4)
const gridScrollRef = ref<HTMLElement | null>(null)
let gridResizeObserver: ResizeObserver | null = null

function updateColumnCount() {
  const grid = gridScrollRef.value?.querySelector('.photo-grid')
  if (grid) {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    if (cols > 0) columnCount.value = cols
  }
}

// ── Keyboard navigation ──────────────────────────────────────────────────────
function handleKeydown(e: KeyboardEvent) {
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return

  if (isFullscreen.value) {
    if (e.key === 'Escape' || e.key === ' ') {
      isFullscreen.value = false
      e.preventDefault()
    } else if (e.key === 'ArrowLeft') {
      if (selectedIndex.value > 0) selectedIndex.value--
    } else if (e.key === 'ArrowRight') {
      if (album.value && selectedIndex.value < album.value.photos.length - 1) selectedIndex.value++
    }
    return
  }

  if (!album.value || album.value.photos.length === 0) return

  if (e.key === 'ArrowRight') {
    if (selectedIndex.value < album.value.photos.length - 1) selectedIndex.value++
    else selectedIndex.value = 0
  } else if (e.key === 'ArrowLeft') {
    if (selectedIndex.value > 0) selectedIndex.value--
    else selectedIndex.value = album.value.photos.length - 1
  } else if (e.key === 'ArrowDown') {
    // Jump to first photo of next section
    const indices = flatSectionFirstIndices.value
    const next = indices.find(idx => idx > selectedIndex.value)
    if (next !== undefined) selectedIndex.value = next
    e.preventDefault()
  } else if (e.key === 'ArrowUp') {
    // Jump to first photo of previous section
    const indices = flatSectionFirstIndices.value
    const prev = [...indices].reverse().find(idx => idx < selectedIndex.value)
    if (prev !== undefined) selectedIndex.value = prev
    e.preventDefault()
  } else if (e.key === ' ') {
    if (selectedIndex.value !== -1) { isFullscreen.value = true; e.preventDefault() }
  }
}

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
  try {
    updatingAlbum.value = true
    await updateAlbum(albumId, {description: descDraft.value})
    album.value.description = descDraft.value
    editingDescription.value = false
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Beschreibung'
  } finally {
    updatingAlbum.value = false
  }
}

function handleCoverPhotoIdUpdate(id: number | null) {
  if (!album.value) return
  album.value.cover_photo_id = id ?? undefined
}

function updatePhotoStatus(id: number, status: CurationStatus) {
  if (!album.value) return
  album.value.photos = album.value.photos.map(photo => (
    photo.id === id ? { ...photo, curation_status: status } : photo
  ))
}

async function handleIgnoreFaceInSidebar(faceId: number) {
  try {
    await ignoreFace(faceId)
    detectedFaces.value = detectedFaces.value.filter(f => f.id !== faceId)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Ignorieren des Gesichts'
  }
}

async function handleReindexPhoto() {
  if (!selectedPhoto.value) return
  reindexingPhoto.value = true
  try {
    await reindexPhoto(selectedPhoto.value.id)
    await loadSidebarData(selectedPhoto.value.id)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Neu-Erkennen'
  } finally {
    reindexingPhoto.value = false
  }
}

async function handleHidePhoto(id: number) {
  try {
    await deletePhoto(id)
    updatePhotoStatus(id, 'hidden')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Ausblenden'
  }
}

async function handleRestorePhoto(id: number) {
  try {
    await updatePhotoCuration(id, 'visible')
    updatePhotoStatus(id, 'visible')
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Wiederherstellen'
  }
}

async function handleToggleFavorite(id: number, currentStatus: CurationStatus) {
  const newStatus = currentStatus === 'favorite' ? 'visible' : 'favorite'
  updatePhotoStatus(id, newStatus)
  try {
    await updatePhotoCuration(id, newStatus)
  } catch (err: any) {
    updatePhotoStatus(id, currentStatus)
    error.value = err.message || 'Fehler beim Ändern des Favoriten-Status'
  }
}

async function scrollToCover() {
  if (!album.value?.cover_photo_id) return
  const idx = album.value.photos.findIndex(p => p.id === album.value!.cover_photo_id)
  if (idx >= 0) {
    selectedIndex.value = idx
    await nextTick()
    scrollToPhoto(album.value.cover_photo_id)
  }
}

// ── Album Sharing ────────────────────────────────────────────────────────────
const showShareDialog = ref(false)
const albumShares = ref<AlbumShareWithUser[]>([])
const allUsers = ref<UserWithRoles[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<'read' | 'write'>('read')
const sharing = ref(false)
const loadingShares = ref(false)

const accessLevelOptions = [
  { label: 'Nur lesen', value: 'read' },
  { label: 'Bearbeiten', value: 'write' },
]

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumShares.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  return allUsers.value.filter(u => u.id !== currentUserId && !sharedIds.has(u.id))
})

async function openShareDialog() {
  showShareDialog.value = true
  loadingShares.value = true
  try {
    const [sharesRes, usersRes] = await Promise.all([
      getAlbumShares(albumId),
      auth.hasPermission('users.list') ? listUsers() : Promise.resolve({ users: [] }),
    ])
    albumShares.value = sharesRes.shares
    allUsers.value = usersRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Freigaben'
  } finally {
    loadingShares.value = false
  }
}

async function handleShare() {
  if (!shareUserId.value) return
  sharing.value = true
  try {
    await shareAlbum(albumId, shareUserId.value, shareAccessLevel.value)
    const sharesRes = await getAlbumShares(albumId)
    albumShares.value = sharesRes.shares
    shareUserId.value = null
    shareAccessLevel.value = 'read'
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Freigeben'
  } finally {
    sharing.value = false
  }
}

async function handleRemoveShare(userId: number) {
  try {
    await removeAlbumShare(albumId, userId)
    albumShares.value = albumShares.value.filter(s => s.user_id !== userId)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Entfernen der Freigabe'
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(() => {
  void loadData()
  if (showPersons.value) void loadPersons()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  photoObserver?.disconnect()
  sectionObserver?.disconnect()
  gridResizeObserver?.disconnect()
})

// Reuse observer logic for performance
const visiblePhotoIds = ref(new Set<number>())
let photoObserver: IntersectionObserver | null = null
let sectionObserver: IntersectionObserver | null = null

function setGridScrollRef(el: HTMLElement | null) {
  gridScrollRef.value = el
}

function setupObservers() {
  photoObserver?.disconnect()
  sectionObserver?.disconnect()
  gridResizeObserver?.disconnect()
  visiblePhotoIds.value = new Set()
  if (!gridScrollRef.value) return

  photoObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.photoId)
          if (entry.isIntersecting) visiblePhotoIds.value.add(id)
          else visiblePhotoIds.value.delete(id)
        }
      },
      {root: gridScrollRef.value, rootMargin: '300px 0px'}
  )
  const photoEls = gridScrollRef.value.querySelectorAll('[data-photo-id]')
  photoEls.forEach(el => photoObserver!.observe(el))

  const rootRect = gridScrollRef.value.getBoundingClientRect()
  photoEls.forEach(el => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > rootRect.top - 300 && rect.top < rootRect.bottom + 300) {
      const id = Number((el as HTMLElement).dataset.photoId)
      if (id) visiblePhotoIds.value.add(id)
    }
  })

  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeSection.value = (entry.target as HTMLElement).id
        }
      }
    },
    { root: gridScrollRef.value, rootMargin: '-5% 0px -90% 0px' }
  )
  gridScrollRef.value.querySelectorAll('[data-section-header]').forEach(el => sectionObserver!.observe(el))

  gridResizeObserver = new ResizeObserver(() => updateColumnCount())
  const grid = gridScrollRef.value.querySelector('.photo-grid')
  if (grid) gridResizeObserver.observe(grid)
  updateColumnCount()
}

watch(groupedPhotos, async () => {
  await nextTick()
  setupObservers()
})

watch(gridScrollRef, () => {
  nextTick(() => setupObservers())
})
</script>

<template>
  <div class="album-detail-view">
    <div v-if="album" class="subheader">
      <div class="header">
        <div class="header-left">
          <h1 class="title">{{ album.name }}</h1>
          <span :class="['role-badge', `role-badge--${album.role}`]">{{ album.role }}</span>
        </div>
        <div class="controls">
          <Button
            v-if="album.cover_photo_id"
            icon="pi pi-image"
            label="Cover fokussieren"
            size="small"
            text
            @click="scrollToCover"
            title="Zum Cover-Foto springen"
          />
          <Button
            v-if="isOwner"
            icon="pi pi-share-alt"
            label="Freigeben"
            size="small"
            text
            @click="openShareDialog"
            title="Album freigeben"
          />
          <div v-if="album.settings" class="control-group">
            <label>Ansicht:</label>
            <SelectButton
                v-model="album.settings.active_view"
                :options="viewOptions"
                optionLabel="label"
                optionValue="value"
                @change="handleSettingsChange"
            />
          </div>
          <div v-if="album.settings" class="control-group">
            <label>Ausblenden:</label>
            <SelectButton
                v-model="album.settings.hide_mode"
                :options="hideModeOptions"
                optionLabel="label"
                optionValue="value"
                @change="handleSettingsChange"
            />
          </div>
        </div>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading && !album" class="info-text">
      <i class="pi pi-spin pi-spinner"/> Album wird geladen…
    </div>

    <div v-if="album" class="album-info-block">
      <div class="album-info-block__description">
        <div v-if="!editingDescription" class="album-info-block__description-content">
          <span :class="{ 'album-info-block__description-text--empty': !album.description }" class="album-info-block__description-text">
            {{ album.description || 'Keine Beschreibung' }}
          </span>
          <Button v-if="canWrite" icon="pi pi-pencil" size="small" text @click="startEditDesc" class="album-info-block__edit-btn"/>
        </div>
        <div v-else class="album-info-block__edit">
          <textarea v-model="descDraft" class="p-inputtextarea p-inputtext" rows="2"></textarea>
          <div class="album-info-block__edit-actions">
            <Button :loading="updatingAlbum" icon="pi pi-check" size="small" @click="saveDescription"/>
            <Button :disabled="updatingAlbum" icon="pi pi-times" size="small" text @click="editingDescription = false"/>
          </div>
        </div>
      </div>

      <div class="album-info-block__meta">
        <span class="album-info-block__meta-text">
          {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
          <template v-if="album.oldest_photo_at && album.newest_photo_at">
            • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
          </template>
        </span>
      </div>
    </div>

    <GalleryLayout v-if="album && groupedPhotos.length > 0" :center-ref="setGridScrollRef">
      <template #left>
        <div v-for="yearGroup in groupedPhotos" :key="'nav-' + yearGroup.year" class="nav-year-group">
          <a
            @click.prevent="scrollToSection('year-' + yearGroup.year)"
            class="nav-year"
            :class="{ active: activeSection === 'year-' + yearGroup.year }"
          >
            {{ yearGroup.year }}
          </a>
          <div class="nav-months">
            <a
              v-for="monthGroup in yearGroup.months"
              :key="'nav-' + yearGroup.year + monthGroup.month"
              @click.prevent="scrollToSection('month-' + yearGroup.year + '-' + monthGroup.month)"
              class="nav-month"
              :class="{ active: activeSection === 'month-' + yearGroup.year + '-' + monthGroup.month }"
            >
              {{ monthGroup.month.substring(0, 3) }}
            </a>
          </div>
        </div>
      </template>

      <template #default>
        <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
          <h2 class="year-title" :id="'year-' + yearGroup.year" data-section-header>{{ yearGroup.year }}</h2>

          <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
            <h3
              v-if="monthGroup.month"
              class="month-title"
              :id="'month-' + yearGroup.year + '-' + monthGroup.month"
              data-section-header
            >
              {{ monthGroup.month }}
            </h3>

            <div class="photo-grid">
              <div
                v-for="item in monthGroup.photos"
                :key="item.photo.id"
                :data-photo-id="item.photo.id"
                class="photo-item"
                :class="{ selected: item.index === selectedIndex }"
                @click="selectedIndex = item.index; isFullscreen = true"
              >
                <div class="photo-thumb">
                  <HeicImage
                    v-if="visiblePhotoIds.has(item.photo.id)"
                    :alt="item.photo.original_name"
                    :src="getPhotoUrl(item.photo.filename, 400)"
                    objectFit="cover"
                  />
                  <div v-else class="thumb-placeholder" />
                </div>
                <div class="photo-meta">
                  <span class="photo-name">{{ item.photo.original_name }}</span>
                </div>
              </div>
            </div>
          </template>
        </template>
      </template>

      <template #right>
        <PhotoDetailSidebar
          v-if="selectedPhoto"
          :can-delete="canDeletePhotos"
          :can-upload="canUploadPhotos"
          :faces="detectedFaces"
          :is-editing-date="false"
          :landmarks="detectedLandmarks"
          :loading-faces="loadingFaces"
          :loading-landmarks="loadingLandmarks"
          :persons="persons"
          :photo="selectedPhoto"
          :reindexing-photo="reindexingPhoto"
          :updating-date="false"
          :album-id="albumId"
          :cover-photo-id="album.cover_photo_id"
          :show-persons="showPersons"
          :limit-albums-shown="true"
          @update:cover-photo-id="handleCoverPhotoIdUpdate"
          @fullscreen="isFullscreen = true"
          @toggle-favorite="handleToggleFavorite"
          @hide="handleHidePhoto"
          @restore="handleRestorePhoto"
          @ignore-face="handleIgnoreFaceInSidebar"
          @reindex="handleReindexPhoto"
        />
      </template>
    </GalleryLayout>

    <div v-else-if="album" class="info-text">
      Keine Fotos in dieser Ansicht.
    </div>

    <!-- Fullscreen overlay -->
    <div v-if="isFullscreen && selectedPhoto" class="fullscreen-overlay" @click="isFullscreen = false">
      <div style="display: none">
        <HeicImage v-if="prevPhoto" :src="getPhotoUrl(prevPhoto.filename)" />
        <HeicImage v-if="nextPhoto" :src="getPhotoUrl(nextPhoto.filename)" />
      </div>
      <div class="fullscreen-content" @click.stop>
        <HeicImage :src="getPhotoUrl(selectedPhoto.filename)" :alt="selectedPhoto.original_name" objectFit="contain" />
        <div class="fs-topbar">
          <Button icon="pi pi-arrow-left" class="fs-topbar-btn" rounded text @click="isFullscreen = false" />
          <div class="fs-date-bar">
            {{ selectedPhoto.taken_at ? new Date(selectedPhoto.taken_at).toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '' }}
          </div>
          <div class="fs-toolbar">
            <Button
              v-if="selectedPhoto.curation_status === 'hidden'"
              icon="pi pi-eye"
              class="fs-topbar-btn"
              rounded text severity="warn"
              @click="handleRestorePhoto(selectedPhoto.id)"
            />
            <Button
              v-else
              icon="pi pi-eye-slash"
              class="fs-topbar-btn"
              rounded text severity="info"
              @click="handleHidePhoto(selectedPhoto.id)"
            />
            <Button
              :icon="selectedPhoto.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              class="fs-topbar-btn"
              rounded text
              :severity="selectedPhoto.curation_status === 'favorite' ? 'warn' : 'secondary'"
              @click="handleToggleFavorite(selectedPhoto.id, selectedPhoto.curation_status)"
            />
          </div>
        </div>
        <Button
          v-if="selectedIndex > 0"
          icon="pi pi-chevron-left"
          class="fs-nav fs-nav-left"
          rounded text
          @click="selectedIndex--"
        />
        <Button
          v-if="album && selectedIndex < album.photos.length - 1"
          icon="pi pi-chevron-right"
          class="fs-nav fs-nav-right"
          rounded text
          @click="selectedIndex++"
        />
      </div>
    </div>

    <!-- Share Dialog -->
    <Dialog v-model:visible="showShareDialog" header="Album freigeben" modal style="width: 480px">
      <div v-if="loadingShares" class="share-loading">
        <i class="pi pi-spin pi-spinner" /> Lädt…
      </div>
      <template v-else>
        <!-- Existing shares -->
        <div class="share-section">
          <h4 class="share-section-title">Aktuelle Freigaben</h4>
          <div v-if="albumShares.length === 0" class="share-empty">Noch keine Freigaben.</div>
          <div v-for="share in albumShares" :key="share.user_id" class="share-row">
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

        <!-- Add new share -->
        <div class="share-section">
          <h4 class="share-section-title">Benutzer hinzufügen</h4>
          <div class="share-add-form">
            <Select
              v-if="allUsers.length > 0"
              v-model="shareUserId"
              :options="usersNotShared"
              optionLabel="name"
              optionValue="id"
              placeholder="Benutzer auswählen…"
              class="share-user-select"
            />
            <input
              v-else
              v-model.number="shareUserId"
              type="number"
              placeholder="Benutzer-ID"
              class="p-inputtext share-userid-input"
            />
            <SelectButton
              v-model="shareAccessLevel"
              :options="accessLevelOptions"
              optionLabel="label"
              optionValue="value"
            />
            <Button
              label="Freigeben"
              icon="pi pi-check"
              :loading="sharing"
              :disabled="!shareUserId"
              @click="handleShare"
            />
          </div>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>

.album-info-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--surface-border);
}

.album-info-block__description {
  flex: 1 1 24rem;
  min-width: 16rem;
  display: flex;
  align-items: center;
}

.album-info-block__description-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.album-info-block__description-text {
  font-size: 0.9rem;
}

.album-info-block__description-text--empty {
  color: var(--text-color-secondary);
  font-style: italic;
}

.album-info-block__edit {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.album-info-block__edit textarea {
  flex: 1;
  min-height: 2.5rem;
}

.album-info-block__edit-actions {
  display: flex;
  gap: 0.25rem;
}

.album-info-block__meta {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.album-info-block__meta-text {
  font-size: 0.85rem;
  color: var(--text-color-secondary);
  white-space: nowrap;
}

.album-detail-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}

@media (min-width: 800px) {
  .album-detail-view {
    margin-inline: 0.5em;
  }
}

.album-detail-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  gap: 0.5em;
  border-bottom: 1px solid var(--surface-border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.role-badge {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  background: var(--surface-200);
  text-transform: uppercase;
}

.role-badge--owner {
  background: #fee2e2;
  color: #991b1b;
}

.role-badge--contributor {
  background: #dcfce7;
  color: #166534;
}

.controls {
  display: flex;
  gap: 2rem;
  align-items: center;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.control-group label {
  font-size: 0.85rem;
  color: var(--text-color-secondary);
}

.year-title {
  border-bottom: 2px solid #3b82f6;
  padding-bottom: 0.5rem;
}

.month-title {
  border-bottom: 1px solid var(--surface-border);
  color: #3b82f6;
  margin-top: 1rem;
}

.nav-year-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.nav-year {
  font-weight: bold;
  font-size: 0.9rem;
  color: #3b82f6;
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.2s;
}

.nav-year:hover { background: #eff6ff; }
.nav-year.active { background: #3b82f6; color: white; }

.nav-months {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  align-items: center;
}

.nav-month {
  font-size: 0.75rem;
  color: var(--text-color-secondary);
  cursor: pointer;
  text-decoration: none;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  transition: color 0.2s;
}

.nav-month.active {
  color: #3b82f6;
  font-weight: bold;
  background: #eff6ff;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.photo-item {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: var(--surface-100);
}

.photo-item.selected {
  border-color: #3b82f6;
}

.photo-thumb {
  width: 100%;
  height: 100%;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  background: var(--surface-200);
}

.photo-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 0.25rem;
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-container {
  width: 320px;
  border-left: 1px solid var(--surface-border);
  background: var(--surface-card);
}

.info-text {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-color-secondary);
}

/* ── Fullscreen ──────────────────────────────────────────────────────────── */
.fullscreen-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.95);
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fullscreen-content {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fs-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent);
  z-index: 10;
}

.fs-topbar-btn {
  color: white !important;
}

.fs-date-bar {
  flex: 1;
  color: white;
  font-size: 0.95rem;
  text-align: center;
}

.fs-toolbar {
  display: flex;
  gap: 0.25rem;
}

.fs-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  color: white !important;
  background: rgba(0,0,0,0.4) !important;
  z-index: 10;
}

.fs-nav-left { left: 1rem; }
.fs-nav-right { right: 1rem; }

/* ── Share Dialog ────────────────────────────────────────────────────────── */
.share-loading {
  padding: 1rem;
  text-align: center;
  color: var(--text-color-secondary);
}

.share-section {
  margin-bottom: 1.5rem;
}

.share-section-title {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-color-secondary);
  margin-bottom: 0.75rem;
}

.share-empty {
  font-size: 0.9rem;
  color: var(--text-color-secondary);
  font-style: italic;
}

.share-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--surface-border);
}

.share-user-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.share-user-name {
  font-size: 0.9rem;
  font-weight: 500;
}

.share-user-email {
  font-size: 0.75rem;
  color: var(--text-color-secondary);
}

.share-badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  white-space: nowrap;
}

.share-badge--read {
  background: var(--surface-200);
  color: var(--text-color-secondary);
}

.share-badge--write {
  background: #dcfce7;
  color: #166534;
}

.share-add-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.share-user-select,
.share-userid-input {
  width: 100%;
}
</style>
