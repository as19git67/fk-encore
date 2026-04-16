<script setup lang="ts">
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Checkbox from 'primevue/checkbox'
import HeicImage from './HeicImage.vue'
import PhotoMiniMap from './PhotoMiniMap.vue'
import PhotoLocationMenu from './PhotoLocationMenu.vue'
import { getPhotoUrl, listAlbums, getPhotosAlbums, batchUpdateAlbumPhotos, updateAlbum, updateAlbumUserSettings, createAlbum, updatePhotoDescription, type Album } from '../api/photos'
import { getAlbumCheckState as calculateAlbumCheckState, getNewPendingAction } from '../utils/albumSelection'
import type { Photo, Face, LandmarkItem, Person, CurationStatus } from '../api/photos'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { formatPhotoDateCompact } from '../utils/dateFormat'

const props = defineProps<{
  photo: Photo
  selectedPhotos?: Photo[]
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

const albums = ref<Album[]>([])
const loadingAlbums = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({}) // photoId -> albumIds[]
const pendingAlbumChanges = ref<Record<number, 'add' | 'remove'>>({})
const savingAlbums = ref(false)
const isAlbumsExpanded = ref(false)

async function loadAlbums() {
  loadingAlbums.value = true
  try {
    const res = await listAlbums()
    albums.value = res.albums.sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    loadingAlbums.value = false
  }
}

async function loadPhotosAlbums() {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
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
// The parent's `selectedPhotos` array is re-created on every photo-hydration
// batch (photos.value is replaced in place), so watching the array reference
// directly would re-fire /photos/albums on every hydration batch even though
// the selection is unchanged. Watching the joined ID list avoids that.
const selectedPhotoIdsKey = computed(() => {
  const ids = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
  return ids.join(',')
})

watch(selectedPhotoIdsKey, () => {
  pendingAlbumChanges.value = {}
  loadPhotosAlbums()
}, { immediate: true })


function getAlbumCheckState(albumId: number) {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
  return calculateAlbumCheckState(albumId, photoIds, photoAlbumMap.value)
}

function getEffectiveAlbumCheckState(albumId: number) {
  if (pendingAlbumChanges.value[albumId]) {
    return pendingAlbumChanges.value[albumId] === 'add' ? true : false
  }
  return getAlbumCheckState(albumId)
}

function handleAlbumChange(albumId: number, checked: boolean) {
  const originalState = getAlbumCheckState(albumId)
  const action = getNewPendingAction(checked, originalState)
  
  if (action === 'delete_pending') {
    delete pendingAlbumChanges.value[albumId]
  } else {
    pendingAlbumChanges.value[albumId] = action
  }
}

async function saveAlbumChanges() {
  const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
    ? props.selectedPhotos.map(p => p.id)
    : [props.photo.id]
    
  if (photoIds.length === 0) return
  savingAlbums.value = true
  
  const adds = Object.entries(pendingAlbumChanges.value)
    .filter(([_, action]) => action === 'add')
    .map(([id]) => parseInt(id))
    
  const removes = Object.entries(pendingAlbumChanges.value)
    .filter(([_, action]) => action === 'remove')
    .map(([id]) => parseInt(id))
    
  try {
    if (adds.length > 0) await batchUpdateAlbumPhotos(adds, photoIds, 'add')
    if (removes.length > 0) await batchUpdateAlbumPhotos(removes, photoIds, 'remove')
    
    pendingAlbumChanges.value = {}
    await loadPhotosAlbums()
  } catch (err) {
    console.error('Failed to save album changes:', err)
  } finally {
    savingAlbums.value = false
  }
}

const sortedAlbums = computed(() => {
  return [...albums.value].sort((a, b) => {
    const stateA = getEffectiveAlbumCheckState(a.id)
    const stateB = getEffectiveAlbumCheckState(b.id)
    // selected (true) or indeterminate (null) come before unselected (false)
    const selA = stateA === true || stateA === null ? 1 : 0
    const selB = stateB === true || stateB === null ? 1 : 0
    if (selA !== selB) return selB - selA
    return a.name.localeCompare(b.name)
  })
})

const showNewAlbumInput = ref(false)
const newAlbumName = ref('')
const creatingAlbum = ref(false)

async function handleCreateAlbumAndAdd() {
  const name = newAlbumName.value.trim()
  if (!name) return
  creatingAlbum.value = true
  try {
    const album = await createAlbum(name)
    const photoIds = props.selectedPhotos && props.selectedPhotos.length > 0
      ? props.selectedPhotos.map(p => p.id)
      : [props.photo.id]
    await batchUpdateAlbumPhotos([album.id], photoIds, 'add')
    newAlbumName.value = ''
    showNewAlbumInput.value = false
    await loadAlbums()
    await loadPhotosAlbums()
  } catch (err) {
    console.error('Failed to create album:', err)
  } finally {
    creatingAlbum.value = false
  }
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
    <div class="sidebar-header">
      <span class="sidebar-title">Details</span>
    </div>
    <div v-if="selectedPhotos && selectedPhotos.length > 1" class="sidebar-scroll">
      <div class="sidebar-section">
        <div class="section-label">
          <i class="pi pi-images" />
          <span>{{ selectedPhotos.length }} Fotos ausgewählt</span>
        </div>
        
        <div class="album-list-container">
          <div class="section-label mt-lg">
            <i class="pi pi-book" />
            <span>Alben</span>
          </div>
          <div v-if="loadingAlbums" class="loading-row"><i class="pi pi-spin pi-spinner" /> Lade Alben…</div>
          <div v-else class="album-checkbox-list">
            <div v-for="album in (limitAlbumsShown && !isAlbumsExpanded ? sortedAlbums.slice(0, 3) : sortedAlbums)" :key="album.id" class="album-checkbox-item">
              <Checkbox
                :modelValue="getEffectiveAlbumCheckState(album.id) === true"
                :indeterminate="getEffectiveAlbumCheckState(album.id) === null"
                @update:modelValue="(val) => handleAlbumChange(album.id, val)"
                :binary="true"
                :id="'album-multi-' + album.id"
              />
              <label :for="'album-multi-' + album.id">{{ album.name }}</label>
            </div>
            <div v-if="limitAlbumsShown && sortedAlbums.length > 3" class="expand-toggle">
              <Button 
                :label="isAlbumsExpanded ? 'Weniger anzeigen' : 'Mehr anzeigen'" 
                :icon="isAlbumsExpanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" 
                text 
                size="small" 
                @click="isAlbumsExpanded = !isAlbumsExpanded"
                class="p-0"
              />
            </div>
          </div>
        </div>

        <div class="new-album-inline mt-sm">
          <div v-if="showNewAlbumInput" class="new-album-form">
            <input v-model="newAlbumName" type="text" class="p-inputtext new-album-input" placeholder="Albumname…" @keydown.enter="handleCreateAlbumAndAdd" @keydown.escape="showNewAlbumInput = false" />
            <Button icon="pi pi-check" size="small" :loading="creatingAlbum" :disabled="!newAlbumName.trim()" @click="handleCreateAlbumAndAdd" />
            <Button icon="pi pi-times" size="small" text @click="showNewAlbumInput = false; newAlbumName = ''" />
          </div>
          <Button v-else label="Neues Album" icon="pi pi-plus" size="small" text @click="showNewAlbumInput = true" class="p-0" />
        </div>

        <div class="sidebar-divider my-xl" />

        <div class="multi-actions">
          <Button
            label="Speichern"
            icon="pi pi-save"
            class="w-full"
            :disabled="Object.keys(pendingAlbumChanges).length === 0"
            :loading="savingAlbums"
            @click="saveAlbumChanges"
          />
        </div>
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
        <div v-if="loadingAlbums" class="loading-row"><i class="pi pi-spin pi-spinner" /> Lade Alben…</div>
        <div v-if="!loadingAlbums && albums.length > 0" class="album-checkbox-list">
          <div v-for="album in (limitAlbumsShown && !isAlbumsExpanded ? sortedAlbums.slice(0, 3) : sortedAlbums)" :key="album.id" class="album-checkbox-item">
            <Checkbox
                :modelValue="getEffectiveAlbumCheckState(album.id) === true"
                :indeterminate="getEffectiveAlbumCheckState(album.id) === null"
                @update:modelValue="(val) => handleAlbumChange(album.id, val)"
                :binary="true"
                :id="'album-single-' + album.id"
            />
            <label :for="'album-single-' + album.id">{{ album.name }}</label>
            <Button
                v-if="getEffectiveAlbumCheckState(album.id) === true && album.id !== albumId"
                icon="pi pi-external-link"
                severity="secondary"
                text
                rounded
                size="small"
                class="album-jump-btn"
                v-tooltip.left="'Zu diesem Album springen'"
                :aria-label="`Zu Album ${album.name} springen`"
                @click.stop="goToAlbum(album.id)"
            />
          </div>
          <div v-if="limitAlbumsShown && sortedAlbums.length > 3" class="expand-toggle">
            <Button
                :label="isAlbumsExpanded ? 'Weniger anzeigen' : 'Mehr anzeigen'"
                :icon="isAlbumsExpanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                text
                size="small"
                @click="isAlbumsExpanded = !isAlbumsExpanded"
                class="p-0"
            />
          </div>
        </div>
        <div class="new-album-inline mt-sm">
          <div v-if="showNewAlbumInput" class="new-album-form">
            <input v-model="newAlbumName" type="text" class="p-inputtext new-album-input" placeholder="Albumname…" @keydown.enter="handleCreateAlbumAndAdd" @keydown.escape="showNewAlbumInput = false; newAlbumName = ''" />
            <Button icon="pi pi-check" size="small" :loading="creatingAlbum" :disabled="!newAlbumName.trim()" @click="handleCreateAlbumAndAdd" />
            <Button icon="pi pi-times" size="small" text @click="showNewAlbumInput = false; newAlbumName = ''" />
          </div>
          <Button v-else label="Neues Album" icon="pi pi-plus" size="small" text @click="showNewAlbumInput = true" class="p-0" />
        </div>
        <div class="multi-actions mt-md">
          <Button v-if="Object.keys(pendingAlbumChanges).length > 0"
                  label="Speichern"
                  icon="pi pi-save"
                  class="w-full"
                  size="small"
                  :disabled="Object.keys(pendingAlbumChanges).length === 0"
                  :loading="savingAlbums"
                  @click="saveAlbumChanges"
          />
        </div>
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

/* Header would be redundant — the flyout already implies "Details". */
.details-sidebar--flyout .sidebar-header {
  display: none;
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
  /* Kein separater Header im Sheet – Close-Button kommt vom Parent */
  .sidebar-header {
    display: none;
  }
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--p-text-muted-color);
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

.album-checkbox-list {
  padding: 0.25rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-hover-background);
}

.album-checkbox-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  font-size: 0.875rem;
  border-radius: 4px;
}

.album-checkbox-item:hover {
  background: var(--p-content-hover-background);
}

.expand-toggle {
  padding-inline: 0.5rem;
  margin-top: 0.25rem;
}

.album-checkbox-item label {
  cursor: pointer;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.album-jump-btn {
  flex-shrink: 0;
  width: 1.75rem !important;
  height: 1.75rem !important;
}

.album-jump-btn :deep(.p-button-icon) {
  font-size: 0.85rem;
}

.new-album-inline {
  padding-inline: 0.25rem;
}

.new-album-form {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.new-album-input {
  flex: 1;
  min-width: 0;
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
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
