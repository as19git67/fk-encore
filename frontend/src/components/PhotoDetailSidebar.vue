<script setup lang="ts">
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import HeicImage from './HeicImage.vue'
import PhotoMiniMap from './PhotoMiniMap.vue'
import PhotoLocationMenu from './PhotoLocationMenu.vue'
import PhotoReactions from './PhotoReactions.vue'
import PhotoAlbumDialog from './PhotoAlbumDialog.vue'
import { getPhotoUrl, getPhotosAlbums, updateAlbum, updateAlbumUserSettings, updatePhotoDescription } from '../api/photos'
import { getAlbumCheckState as calculateAlbumCheckState } from '../utils/albumSelection'
import type { Photo, Face, LandmarkItem, Person, CurationStatus } from '../api/photos'
import { useReferenceData } from '../composables/useReferenceData'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { formatPhotoDateCompact } from '../utils/dateFormat'

const props = defineProps<{
  photo: Photo
  /** When 2+ IDs are passed, the sidebar switches to multi-select mode
   *  (album chips show the union with tristate "partial" markers, the
   *  album dialog drives a batch update). `undefined` or a list of 0/1
   *  IDs renders the regular single-photo view. */
  selectedPhotoIds?: number[]
  faces: Face[]
  loadingFaces: boolean
  landmarks: LandmarkItem[]
  loadingLandmarks: boolean
  persons: Person[]
  canDelete: boolean
  canUpload: boolean
  reindexingPhoto: boolean
  isEditingDate: boolean
  updatingDate: boolean
  showPersons?: boolean
  limitAlbumsShown?: boolean
  albumId?: number
  coverPhotoId?: number | null
  albumRole?: 'owner' | 'admin' | 'contributor' | 'viewer'
  /** When false the "Neu erkennen" button is disabled (insightface not reachable). */
  faceServiceAvailable?: boolean
  /** Show a "Go to photo" navigation button (e.g. from PersonsView). */
  showNavigateToPhoto?: boolean
  /** Hide the "Alle Fotos" entry in the location menu (we're already there). */
  locationMenuExcludeAllPhotos?: boolean
  /** When true, the sidebar is rendered inside the fullscreen details
   *  flyout: it fills the available width, the photo preview is hidden
   *  (the user already sees the photo in the fullscreen view), and a
   *  small map with a pin is shown under the location section. */
  inFlyout?: boolean
}>()

const editDate = defineModel<Date | null>('editDate', { default: null })

const { albums, albumsLoaded, fetchAlbums } = useReferenceData()
const loadingAlbums = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({}) // photoId -> albumIds[]
const albumDialogVisible = ref(false)

async function loadAlbums() {
  if (albumsLoaded.value) return
  loadingAlbums.value = true
  try {
    await fetchAlbums()
  } finally {
    loadingAlbums.value = false
  }
}

/** True when the parent passed 2+ IDs (multi-select mode). */
const isMultiSelect = computed(
  () => (props.selectedPhotoIds?.length ?? 0) > 1,
)

/** IDs that drive the album section: every selected photo in multi-mode,
 *  the cursor photo otherwise. */
const albumPhotoIds = computed<number[]>(() => (
  isMultiSelect.value ? (props.selectedPhotoIds as number[]) : [props.photo.id]
))

async function loadPhotosAlbums() {
  const photoIds = albumPhotoIds.value
  try {
    const res = await getPhotosAlbums(photoIds)
    const map: Record<number, number[]> = {}
    res.results.forEach(r => {
      map[r.photoId] = r.albumIds
    })
    photoAlbumMap.value = map
  } catch (err) {
    console.error('Failed to load photos albums:', err)
  }
}

// Watch a stable key derived from the IDs currently shown in the sidebar.
// The parent often hands us a fresh array on every render even when the
// selection is unchanged; watching the joined ID list avoids re-firing
// `/photos/albums` on each unrelated re-render.
const albumPhotoIdsKey = computed(() => albumPhotoIds.value.join(','))

watch(albumPhotoIdsKey, () => {
  loadPhotosAlbums()
}, { immediate: true })


function getAlbumCheckState(albumId: number) {
  return calculateAlbumCheckState(
    albumId,
    albumPhotoIds.value,
    photoAlbumMap.value,
  )
}

const currentAlbumChips = computed(() => {
  const result: { id: number; name: string; partial: boolean }[] = []
  for (const album of albums.value) {
    const state = getAlbumCheckState(album.id)
    if (state === true || state === null) {
      result.push({ id: album.id, name: album.name, partial: state === null })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
})

function openAlbumDialog() {
  albumDialogVisible.value = true
}

const router = useRouter()

/** Jump directly to the given album, pre-selecting the current photo.
 *  Used by the inline "jump" button next to each album the photo is in —
 *  a shortcut for the PhotoLocationMenu dialog. */
function goToAlbum(targetAlbumId: number) {
  if (targetAlbumId === props.albumId) return
  router.push({
    name: 'fotos-album-detail',
    params: { id: String(targetAlbumId) },
    query: { photoId: String(props.photo.id) },
  })
}

const togglingCover = ref(false)
async function toggleCover() {
  if (!props.albumId || togglingCover.value) return

  const isCurrentlyCover = props.coverPhotoId === props.photo.id
  const newCoverId = isCurrentlyCover ? null : props.photo.id

  togglingCover.value = true
  try {
    const canWriteAlbum = props.albumRole === 'owner' || props.albumRole === 'contributor'
    if (canWriteAlbum) {
      await updateAlbum(props.albumId, { coverPhotoId: newCoverId })
    } else {
      await updateAlbumUserSettings(props.albumId, { cover_photo_id: newCoverId })
    }
    emit('update:coverPhotoId', newCoverId)
  } catch (err) {
    console.error('Failed to update album cover:', err)
  } finally {
    togglingCover.value = false
  }
}

onMounted(loadAlbums)

const emit = defineEmits<{
  'update:coverPhotoId': [id: number | null]
  fullscreen: []
  'ignore-face': [faceId: number]
  reindex: []
  'start-edit-date': []
  'update-date': []
  'cancel-edit-date': []
  'toggle-favorite': [id: number, status: CurationStatus]
  hide: [id: number]
  restore: [id: number]
  'navigate-to-photo': [id: number]
}>()

function formatPhotoDateDisplay(photo: Photo) {
  return formatPhotoDateCompact(photo.taken_at || photo.created_at)
}

function getPersonName(personId?: number) {
  if (!personId) return 'Unbekannt'
  const person = props.persons.find(p => p.id === personId)
  return person ? person.name : 'Unbekannt'
}

const namedFaces = computed(() =>
  props.faces.filter(f => {
    if (f.ignored || !f.person_id) return false
    const person = props.persons.find(p => p.id === f.person_id)
    const name = person?.name?.trim()
    return !!name && name.toLowerCase() !== 'unbenannt'
  })
)

// ── Description editing ──────────────────────────────────────────────────────
const isEditingDescription = ref(false)
const descriptionText = ref('')
const savingDescription = ref(false)

function startEditDescription() {
  descriptionText.value = props.photo.description ?? ''
  isEditingDescription.value = true
}

function cancelEditDescription() {
  isEditingDescription.value = false
}

async function saveDescription() {
  savingDescription.value = true
  try {
    const value = descriptionText.value.trim() || null
    const res = await updatePhotoDescription(props.photo.id, value)
    props.photo.description = res.description ?? undefined
    isEditingDescription.value = false
  } catch (err) {
    console.error('Failed to save description:', err)
  } finally {
    savingDescription.value = false
  }
}

watch(() => props.photo.id, () => {
  isEditingDescription.value = false
})
</script>

<template>
  <aside class="details-sidebar" :class="{ 'details-sidebar--flyout': inFlyout }">
    <div v-if="isMultiSelect" class="sidebar-scroll">
      <div class="sidebar-section">
        <div class="section-label">
          <i class="pi pi-images" />
          <span>{{ selectedPhotoIds!.length }} Fotos ausgewählt</span>
        </div>

        <div class="section-label mt-lg">
          <i class="pi pi-book" />
          <span>Alben</span>
        </div>
        <div v-if="loadingAlbums" class="loading-row">
          <i class="pi pi-spin pi-spinner" /> Lade Alben…
        </div>
        <template v-else>
          <div v-if="currentAlbumChips.length === 0" class="empty-hint">
            Keine gemeinsamen Alben
          </div>
          <div v-else class="album-chips">
            <span
              v-for="chip in currentAlbumChips"
              :key="chip.id"
              class="album-chip"
              :class="{ 'album-chip--partial': chip.partial }"
              :title="chip.partial ? 'In einigen ausgewählten Fotos' : 'In allen ausgewählten Fotos'"
            >
              <i class="pi pi-book" />
              {{ chip.name }}
            </span>
          </div>
          <Button
            label="Alben bearbeiten"
            icon="pi pi-pencil"
            size="small"
            outlined
            class="album-edit-btn"
            @click="openAlbumDialog"
          />
        </template>
      </div>
    </div>
    <div v-else class="sidebar-scroll">
      <div v-if="!inFlyout" class="preview-container" @click="emit('fullscreen')" title="Vollbild">
        <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" objectFit="contain" />
        <div class="preview-overlay"><i class="pi pi-expand"></i></div>
      </div>

      <div v-if="!inFlyout" class="quick-actions">
        <Button icon="pi pi-expand" v-tooltip.bottom="'Vollbild'" @click="emit('fullscreen')" severity="secondary" text rounded />
        <Button v-if="showNavigateToPhoto" icon="pi pi-images" v-tooltip.bottom="'In Fotos anzeigen'" @click="emit('navigate-to-photo', photo.id)" severity="secondary" text rounded />
        <template v-if="canDelete">
          <Button :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" v-tooltip.bottom="photo.curation_status === 'favorite' ? 'Kein Favorit' : 'Favorit'" @click="emit('toggle-favorite', photo.id, photo.curation_status)" :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'" text rounded />
          <Button :icon="photo.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'" v-tooltip.bottom="photo.curation_status === 'hidden' ? 'Wiederherstellen' : 'Ausblenden'" @click="photo.curation_status === 'hidden' ? emit('restore', photo.id) : emit('hide', photo.id)" :severity="photo.curation_status === 'hidden' ? 'danger' : 'secondary'" text rounded />
        </template>
        <template v-if="albumId" class="meta-row cover-action">
          <Button
              icon="pi pi-image"
              v-tooltip.bottom="coverPhotoId === photo.id ? 'Vom Cover entfernen' : 'Als Cover setzen'"
              :severity="coverPhotoId === photo.id ? 'warn' : 'secondary'"
              :class="{ 'cover-btn--active': coverPhotoId === photo.id }"
              text
              rounded
              :loading="togglingCover"
              @click="toggleCover"
          />
        </template>
        <PhotoLocationMenu
          :photo-id="photo.id"
          :exclude-all-photos="locationMenuExcludeAllPhotos"
          :exclude-album-id="albumId"
        />
      </div>

      <!-- Likes and comments (visible to everyone with photo access). -->
      <div class="sidebar-divider" />
      <div class="sidebar-section">
        <div class="section-label"><i class="pi pi-comments" /> Reaktionen</div>
        <PhotoReactions :photo-id="photo.id" />
      </div>

      <!-- Curation opinions (shared albums only) -->
      <template v-if="(photo as any).curation_stats && (photo as any).curation_stats.member_count > 1">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-users" /> Meinungen ({{ (photo as any).curation_stats.member_count }} Teilnehmer)</div>
          <div class="curation-opinion-bars">
            <div class="opinion-row">
              <span class="opinion-label"><i class="pi pi-heart-fill opinion-icon opinion-icon--fav" /> Favorit</span>
              <div class="opinion-bar-track">
                <div class="opinion-bar-fill opinion-bar-fill--fav" :style="{ width: `${((photo as any).curation_stats.fav_count / (photo as any).curation_stats.member_count) * 100}%` }" />
              </div>
              <span class="opinion-count">{{ (photo as any).curation_stats.fav_count }} von {{ (photo as any).curation_stats.member_count }}</span>
            </div>
            <div v-if="(photo as any).curation_stats.hide_count > 0" class="opinion-row">
              <span class="opinion-label"><i class="pi pi-eye-slash opinion-icon opinion-icon--hide" /> Ausgeblendet</span>
              <div class="opinion-bar-track">
                <div class="opinion-bar-fill opinion-bar-fill--hide" :style="{ width: `${((photo as any).curation_stats.hide_count / (photo as any).curation_stats.member_count) * 100}%` }" />
              </div>
              <span class="opinion-count">{{ (photo as any).curation_stats.hide_count }} von {{ (photo as any).curation_stats.member_count }}</span>
            </div>
            <div v-if="photo.ai_quality_score != null" class="opinion-row">
              <span class="opinion-label"><i class="pi pi-star-fill opinion-icon opinion-icon--ai" /> KI-Bewertung</span>
              <div class="opinion-bar-track">
                <div class="opinion-bar-fill opinion-bar-fill--ai" :style="{ width: `${photo.ai_quality_score * 100}%` }" />
              </div>
              <span class="opinion-count">{{ (photo.ai_quality_score * 100).toFixed(0) }}%</span>
            </div>
          </div>
        </div>
      </template>

      <div class="sidebar-divider" />

      <div class="meta-list">
        <div class="meta-row">
          <i class="pi pi-calendar meta-icon" />
          <span class="meta-value date-value">{{ formatPhotoDateDisplay(photo) }}</span>
          <Button v-if="canUpload && !isEditingDate" icon="pi pi-pencil" text rounded size="small" @click="emit('start-edit-date')" class="edit-btn" />
        </div>
        <div v-if="isEditingDate" class="date-editor">
          <DatePicker v-model="editDate" showTime hourFormat="24" fluid />
          <div class="edit-actions">
            <Button icon="pi pi-check" severity="success" text rounded @click="emit('update-date')" :loading="updatingDate" />
            <Button icon="pi pi-times" severity="danger" text rounded @click="emit('cancel-edit-date')" :disabled="updatingDate" />
          </div>
        </div>
      </div>

      <div class="sidebar-divider" />

      <div class="sidebar-section">
        <!-- Editor when editing, the text itself when set, otherwise a
             muted italic "Keine Beschreibung" placeholder. The edit pencil
             is always inline with the content (center-aligned). -->
        <div v-if="isEditingDescription" class="description-editor">
          <textarea v-model="descriptionText" class="p-inputtext description-textarea" rows="3" placeholder="Beschreibung eingeben…" @keydown.escape="cancelEditDescription" />
          <div class="edit-actions">
            <Button icon="pi pi-check" severity="success" text rounded @click="saveDescription" :loading="savingDescription" />
            <Button icon="pi pi-times" severity="danger" text rounded @click="cancelEditDescription" :disabled="savingDescription" />
          </div>
        </div>
        <div v-else-if="photo.description" class="description-text">
          <i class="pi pi-align-left meta-icon description-icon" />
          <span class="description-body">{{ photo.description }}</span>
          <Button v-if="canUpload" icon="pi pi-pencil" text rounded size="small" @click="startEditDescription" class="edit-btn" />
        </div>
        <div v-else class="empty-description">
          <i class="pi pi-align-left meta-icon description-icon" />
          <span class="empty-description-text">Keine Beschreibung</span>
          <Button v-if="canUpload" icon="pi pi-pencil" text rounded size="small" @click="startEditDescription" class="edit-btn" />
        </div>
      </div>

      <template v-if="photo.location_city || photo.location_name || loadingLandmarks || landmarks.length > 0 || (inFlyout && photo.latitude != null && photo.longitude != null)">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div v-if="photo.location_name || photo.location_city" class="meta-row location-row">
            <i class="pi pi-map-marker meta-icon" />
            <span class="meta-value">
              <template v-if="photo.location_name">{{ photo.location_name }}</template>
              <template v-else-if="photo.location_city && photo.location_country">{{ photo.location_city }}, {{ photo.location_country }}</template>
              <template v-else>{{ photo.location_city }}</template>
            </span>
          </div>
          <PhotoMiniMap
            v-if="inFlyout && photo.latitude != null && photo.longitude != null"
            :key="photo.id"
            :latitude="photo.latitude"
            :longitude="photo.longitude"
            :label="photo.location_name || photo.location_city"
            class="mini-map"
          />
          <div v-if="loadingLandmarks" class="loading-row"><i class="pi pi-spin pi-spinner" /> Gebäude werden erkannt…</div>
          <div v-else-if="landmarks.some(lm => lm.confidence >= 0.6)" class="landmark-chips">
            <template v-for="lm in landmarks" :key="lm.id">
              <span v-if="lm.confidence >= 0.6" class="landmark-tag" :title="`${Math.round(lm.confidence * 100)}%`">
                <i class="pi pi-building" /> {{ lm.label }} <span class="landmark-confidence">{{ Math.round(lm.confidence * 100) }}%</span>
              </span>
            </template>
          </div>
        </div>
      </template>

      <template v-if="photo.keywords && photo.keywords.length > 0">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-tag" /> Tags</div>
          <div class="keyword-chips">
            <span v-for="kw in photo.keywords" :key="kw" class="keyword-tag">{{ kw }}</span>
          </div>
        </div>
      </template>

      <template v-if="showPersons !== false">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-users" /> Personen</div>
          <div v-if="loadingFaces" class="loading-row"><i class="pi pi-spin pi-spinner" /> Lade…</div>
          <div v-else-if="namedFaces.length === 0" class="empty-hint">Keine Personen erkannt</div>
          <div v-else class="person-list">
            <div v-for="face in namedFaces" :key="face.id" class="person-row">
              <i class="pi pi-user person-icon" />
              <span class="person-name">{{ getPersonName(face.person_id) }}</span>
              <Button icon="pi pi-times" severity="secondary" text rounded size="small" @click="emit('ignore-face', face.id)" v-tooltip="'Entfernen'" />
            </div>
          </div>
          <Button label="Neu erkennen" icon="pi pi-refresh" @click="emit('reindex')" :loading="reindexingPhoto" :disabled="faceServiceAvailable === false" class="reindex-btn" severity="secondary" outlined size="small" :title="faceServiceAvailable === false ? 'Gesichtserkennungs-Dienst nicht verfügbar' : undefined" />
        </div>
      </template>

      <div class="sidebar-section">
        <div class="section-label"><i class="pi pi-book" /> Alben</div>
        <div v-if="loadingAlbums" class="loading-row">
          <i class="pi pi-spin pi-spinner" /> Lade Alben…
        </div>
        <template v-else>
          <div v-if="currentAlbumChips.length === 0" class="empty-hint">
            In keinem Album
          </div>
          <div v-else class="album-chips">
            <span
              v-for="chip in currentAlbumChips"
              :key="chip.id"
              class="album-chip"
            >
              <i class="pi pi-book" />
              {{ chip.name }}
              <Button
                v-if="chip.id !== albumId"
                icon="pi pi-external-link"
                severity="secondary"
                text
                rounded
                size="small"
                class="album-chip-jump"
                v-tooltip.top="'Zu diesem Album springen'"
                :aria-label="`Zu Album ${chip.name} springen`"
                @click.stop="goToAlbum(chip.id)"
              />
            </span>
          </div>
          <Button
            label="Alben bearbeiten"
            icon="pi pi-pencil"
            size="small"
            outlined
            class="album-edit-btn"
            @click="openAlbumDialog"
          />
        </template>
      </div>

      <div class="sidebar-divider" />

      <div class="meta-list">
        <div class="meta-row">
          <i class="pi pi-file meta-icon" />
          <span class="meta-value" :title="photo.original_name">{{ photo.original_name }}</span>
        </div>
        <div v-if="photo.size" class="meta-row">
          <i class="pi pi-database meta-icon" />
          <span class="meta-value">{{ (photo.size / 1024 / 1024).toFixed(2) }} MB</span>
        </div>
        <!-- Stored filename on disk (UUID-ish) – useful when tracking a photo
             down inside the Docker volume. -->
        <div v-if="photo.filename" class="meta-row">
          <i class="pi pi-hashtag meta-icon" />
          <span class="meta-value meta-value--mono" :title="photo.filename">{{ photo.filename }}</span>
        </div>
      </div>
    </div>

    <PhotoAlbumDialog
      v-model:visible="albumDialogVisible"
      :photo-ids="albumPhotoIds"
      @saved="loadPhotosAlbums"
    />
  </aside>
</template>

<style scoped>
.details-sidebar {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--p-content-background);
  border-left: 1px solid var(--p-content-border-color);
  overflow: hidden;
}

/* Flyout variant: fill the entire width of the surrounding flyout and
   drop the vertical border (the flyout already has its own border).
   Also defer scrolling to the surrounding flyout to avoid a double
   scroll container. */
.details-sidebar--flyout {
  width: 100%;
  border-left: none;
  background: var(--p-content-background);
  overflow: visible;
}

.details-sidebar--flyout .sidebar-scroll {
  overflow: visible;
}

.mini-map {
  margin-top: 0.1rem;
  margin-bottom: 0.5rem;
}

@media (max-width: 768px) {
  /* Als Bottom-Sheet: volle Breite und undurchsichtiger Hintergrund */
  .details-sidebar {
    width: 100%;
    background: var(--p-content-background);
    overflow-y: auto;
    border-left: none;
  }
}

.sidebar-scroll {
  flex: 1;
  overflow-y: auto;
}

.preview-container {
  position: relative;
  cursor: pointer;
  background: var(--p-content-hover-background);
  width: 100%;
}

/* Höhe richtet sich nach dem natürlichen Seitenverhältnis des Bildes,
   maximal so hoch wie die Sidebar breit ist (= quadratisch).
   HeicImage setzt im contain-Modus aspect-ratio + height:auto am
   image-content-wrapper; wir überschreiben die height:100%-Ketten. */
.preview-container :deep(.heic-image-container) {
  height: auto !important;
  width: 100%;
  min-height: 60px; /* Platzhalter während des Ladens */
}
.preview-container :deep(.image-wrapper) {
  height: auto !important;
}
.preview-container :deep(.image-content-wrapper) {
  /* Inline-Style maxHeight:'100%' überschreiben → feste Pixel-Schranke */
  max-height: 280px !important; /* = Sidebar-Breite auf Desktop */
}

@media (max-width: 768px) {
  .preview-container :deep(.image-content-wrapper) {
    max-height: 100vw !important; /* = volle Sheet-Breite auf Mobile */
  }
}

.preview-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  justify-content: center;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s;
  color: white;
  font-size: 1.5rem;
}
.preview-container:hover .preview-overlay { opacity: 1; }

.quick-actions {
  display: flex;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.5rem 1rem;
}

/* Active-state highlight for the Cover toggle (PrimeVue "warn" on a text
   button can be subtle on light backgrounds – give it a filled chip feel
   so the "set" state stays clearly visible). */
.quick-actions :deep(.cover-btn--active) {
  background: var(--p-content-hover-background);
}

.sidebar-divider { height: 1px; background: var(--p-content-border-color); }

.sidebar-section { padding: 0.75rem 1rem; }

.section-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--p-text-muted-color);
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.section-label .pi { font-size: 0.75rem; }

.meta-list {
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.875rem;
}

.meta-icon {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}

.meta-value {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  line-height: 1.4;
}

.meta-value--mono {
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  word-break: break-all;
}

.cover-action {
  margin-top: 0.25rem;
  padding-left: 1.25rem;
}

.date-value {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.edit-btn { flex-shrink: 0; opacity: 0.6; }
.edit-btn:hover { opacity: 1; }

.date-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0.5rem 0;
  padding: 0.75rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
}

.edit-actions { display: flex; gap: 0.5rem; }

.location-row {
  margin-bottom: 0.5rem;
}

.landmark-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }

.landmark-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 1rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  cursor: default;
}
.landmark-tag .pi-building { font-size: 0.7rem; color: var(--p-text-muted-color); }
.landmark-confidence { font-size: 0.7rem; color: var(--p-text-muted-color); }

.keyword-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.keyword-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 1rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  cursor: default;
}

.loading-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
}

.empty-hint {
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}

.person-list { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.25rem; }
.person-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding-inline: 0.4rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color);
}
.person-icon { font-size: 0.8rem; color: var(--p-text-muted-color); }
.person-name { flex: 1; font-size: 0.875rem; }

.description-editor {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.description-textarea {
  width: 100%;
  resize: vertical;
  font-size: 0.85rem;
  padding: 0.5rem;
  border-radius: 6px;
  font-family: inherit;
}

.description-text {
  font-size: 0.85rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.description-body {
  flex: 1;
  min-width: 0;
}

.empty-description {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}

.empty-description-text {
  flex: 1;
  min-width: 0;
}

.reindex-btn { width: 100%; margin-top: 0.5rem; }

.multi-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.album-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}

.album-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 1rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
}

.album-chip .pi-book {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}

.album-chip--partial {
  border-style: dashed;
  font-style: italic;
}

.album-chip-jump {
  width: 1.5rem !important;
  height: 1.5rem !important;
  margin-left: 0.1rem;
}

.album-chip-jump :deep(.p-button-icon) {
  font-size: 0.75rem;
}

.album-edit-btn {
  margin-top: 0.25rem;
  width: 100%;
}

/* ── Curation opinions ─────────────────────────────────────────────────── */
.curation-opinion-bars {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.opinion-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
}

.opinion-label {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 7rem;
  color: var(--p-text-muted-color);
  font-size: 0.78rem;
}

.opinion-icon { font-size: 0.75rem; }
.opinion-icon--fav { color: var(--p-orange-400); }
.opinion-icon--hide { color: var(--p-red-400); }
.opinion-icon--ai { color: var(--p-yellow-500); }

.opinion-bar-track {
  flex: 1;
  height: 6px;
  background: var(--p-content-border-color);
  border-radius: 3px;
  overflow: hidden;
}

.opinion-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.opinion-bar-fill--fav { background: var(--p-orange-400); }
.opinion-bar-fill--hide { background: var(--p-red-400); }
.opinion-bar-fill--ai { background: var(--p-yellow-500); }

.opinion-count {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  min-width: 3.5rem;
  text-align: right;
  white-space: nowrap;
}

</style>
