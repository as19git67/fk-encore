<script setup lang="ts">
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import HeicImage from './HeicImage.vue'
import PhotoMiniMap from './PhotoMiniMap.vue'
import PhotoLocationMenu from './PhotoLocationMenu.vue'
import PhotoReactions from './PhotoReactions.vue'
import PhotoAlbumDialog from './PhotoAlbumDialog.vue'
import PhotoTransformEditor from './PhotoTransformEditor.vue'
import { getPhotoUrl, getPhotosAlbums, updateAlbum, updateAlbumUserSettings, updatePhotoDescription } from '../api/photos'
import { getAlbumCheckState as calculateAlbumCheckState } from '../utils/albumSelection'
import type { Photo, Face, PoiMatchItem, Person, CurationStatus } from '../api/photos'
import { useReferenceData } from '../composables/useReferenceData'
import { useUserPhotoTransform } from '../composables/useUserPhotoTransform'
import { useAuthStore } from '../stores/auth'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { formatPhotoDateCompact } from '../utils/dateFormat'
import { resolveCurationOpinions } from '../utils/curationOpinions'
import { detailPanelEditable } from '../utils/detailPanelEditable'

const props = defineProps<{
  photo: Photo
  /** When 2+ IDs are passed, the sidebar switches to multi-select mode
   *  (album chips show the union with tristate "partial" markers, the
   *  album dialog drives a batch update). `undefined` or a list of 0/1
   *  IDs renders the regular single-photo view. */
  selectedPhotoIds?: number[]
  faces: Face[]
  loadingFaces: boolean
  /** POI matches produced by the osm-admin pipeline (Epic #383).
   *  When the matches array is non-empty the sidebar shows them in
   *  the location section. */
  poiMatches?: PoiMatchItem[]
  loadingPoiMatches?: boolean
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
  /** Album-scoped curation opinions (fav/hide across album participants).
   *  Supplied by the album views because the fullscreen/split cursor photo —
   *  hydrated from the grid + photo-details batch — doesn't carry this
   *  album-only data. Falls back to photo.curation_stats when omitted. */
  curationStats?: { fav_count: number; hide_count: number; member_count: number }
  /** View-only mode: hide every edit affordance (description, date, comments,
   *  album, face actions). Driven by a running fullscreen slideshow — paused
   *  slideshow makes the panel editable again. */
  readOnly?: boolean
}>()

const editDate = defineModel<Date | null>('editDate', { default: null })

const auth = useAuthStore()

const { albums, albumsLoaded, fetchAlbums, users, fetchUsers } = useReferenceData()
const ownerName = computed(() => users.value.find(u => u.id === props.photo.user_id)?.name)
fetchUsers()

const loadingAlbums = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({}) // photoId -> albumIds[]
const albumDialogVisible = ref(false)
const transformEditorVisible = ref(false)

// Per-user photo recipe — applied as CSS filter to the preview image
// so the user's exposure/contrast/gamma show up in the sidebar without
// requiring an editor visit. Crop is NOT shown here (would require
// invasive layout changes inside HeicImage); for the full transformed
// view the user opens the editor or downloads the export.
// Album-scoped curation opinions: prefer the explicitly supplied stats (album
// views pass these for the fullscreen/split cursor photo), else the photo's
// own. Null when there's nothing meaningful to show (no stats / one member).
const effectiveCurationStats = computed(
  () => resolveCurationOpinions(props.curationStats, (props.photo as any).curation_stats),
)

const previewPhotoId = computed(() => props.photo?.id ?? null)
const {
  recipe: userRecipe,
  cssFilter: userPhotoFilter,
  svgFilterMarkup: userSvgMarkup,
  buildRenderedUrl: buildUserRenderedUrl,
} = useUserPhotoTransform(previewPhotoId)

// When the user has saved a recipe (crop + colour), point the preview
// at the server-rendered URL so the crop is reflected. Without this, a
// saved crop would invisibly persist — see issue feedback after Phase 1.
const previewSrc = computed(() => {
  return buildUserRenderedUrl(800) ?? getPhotoUrl(props.photo.filename)
})

// Apply the CSS filter only when we're showing the original (no recipe
// yet); the rendered URL already bakes the colour adjustments in.
const previewImageStyle = computed(() =>
  userRecipe.value || !userPhotoFilter.value
    ? undefined
    : { filter: userPhotoFilter.value },
)

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
  'comment-count-change': [payload: { photoId: number; delta: number }]
}>()

function formatPhotoDateDisplay(photo: Photo) {
  return formatPhotoDateCompact(photo.taken_at || photo.created_at)
}

// The date/description PATCH endpoints only authorize the photo's owner
// (photos.user_id === userId), so only show the edit pencil when the
// current user could actually persist the change server-side. Everyone
// else (album viewers, contributors who didn't upload this photo) sees
// the values read-only.
const canEditPhotoMeta = computed(() =>
  detailPanelEditable(auth.user?.id != null && props.photo.user_id === auth.user.id, props.readOnly),
)

// Resolve the display name for an assigned face. Prefer the name the backend
// already joined onto the face (person_name); only fall back to the
// separately-loaded persons list. Relying on that list alone left the
// "Personen" section empty whenever it hadn't loaded — the bug where a photo
// matched the "with assigned person" filter yet showed no names here.
function faceDisplayName(f: { person_id?: number; person_name?: string }): string {
  const fromFace = f.person_name?.trim()
  if (fromFace) return fromFace
  if (f.person_id == null) return ''
  return props.persons.find(p => p.id === f.person_id)?.name?.trim() ?? ''
}

const namedFaces = computed(() =>
  props.faces.filter(f => {
    if (f.ignored || !f.person_id) return false
    const name = faceDisplayName(f)
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

// Turning read-only (e.g. starting the slideshow while a field was open) closes
// any open editor so it can't linger over a non-editable panel.
watch(() => props.readOnly, (ro) => {
  if (!ro) return
  isEditingDescription.value = false
  if (props.isEditingDate) emit('cancel-edit-date')
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
            v-if="!readOnly"
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
        <svg v-if="userSvgMarkup && !userRecipe" width="0" height="0" style="position: absolute; pointer-events: none">
          <defs v-html="userSvgMarkup"></defs>
        </svg>
        <HeicImage
          :src="previewSrc"
          :alt="photo.original_name"
          objectFit="contain"
          :imageStyle="previewImageStyle"
        />
        <div class="preview-overlay"><i class="pi pi-expand"></i></div>
      </div>

      <div v-if="!inFlyout" class="quick-actions">
        <Button icon="pi pi-expand" v-tooltip.bottom="'Vollbild'" @click="emit('fullscreen')" severity="secondary" text rounded />
        <Button v-if="canUpload" icon="pi pi-sliders-h" v-tooltip.bottom="'Schnitt &amp; Belichtung bearbeiten'" @click="transformEditorVisible = true" severity="secondary" text rounded />
        <Button v-if="showNavigateToPhoto" icon="pi pi-images" v-tooltip.bottom="'In Fotos anzeigen'" @click="emit('navigate-to-photo', photo.id)" severity="secondary" text rounded />
        <template v-if="canDelete">
          <Button :icon="photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'" v-tooltip.bottom="photo.curation_status === 'favorite' ? 'Kein Favorit' : 'Favorit'" @click="emit('toggle-favorite', photo.id, photo.curation_status)" :severity="photo.curation_status === 'favorite' ? 'warn' : 'secondary'" text rounded />
          <Button :icon="photo.curation_status === 'hidden' ? 'pi pi-thumbs-down-fill' : 'pi pi-thumbs-down'" v-tooltip.bottom="photo.curation_status === 'hidden' ? 'Wiederherstellen' : 'Ausblenden'" @click="photo.curation_status === 'hidden' ? emit('restore', photo.id) : emit('hide', photo.id)" :severity="photo.curation_status === 'hidden' ? 'danger' : 'secondary'" text rounded />
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

      <!-- Description first (#434): the most useful metadata leads the
           details view. Editor when editing, the text itself when set,
           otherwise a muted italic "Keine Beschreibung" placeholder. -->
      <div class="sidebar-section">
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
          <Button v-if="canEditPhotoMeta" icon="pi pi-pencil" text rounded size="small" @click="startEditDescription" class="edit-btn" />
        </div>
        <div v-else class="empty-description">
          <i class="pi pi-align-left meta-icon description-icon" />
          <span class="empty-description-text">Keine Beschreibung</span>
          <Button v-if="canEditPhotoMeta" icon="pi pi-pencil" text rounded size="small" @click="startEditDescription" class="edit-btn" />
        </div>
      </div>

      <!-- Curation opinions (shared albums only): how many participants
           favorited / hid this photo. Placed between description and comments
           so the split-view detail pane mirrors the legacy sidebar. -->
      <template v-if="effectiveCurationStats">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-users" /> Meinungen ({{ effectiveCurationStats.member_count }} Teilnehmer)</div>
          <div class="curation-opinion-bars">
            <div class="opinion-row">
              <span class="opinion-label"><i class="pi pi-heart-fill opinion-icon opinion-icon--fav" /> Favorit</span>
              <div class="opinion-bar-track">
                <div class="opinion-bar-fill opinion-bar-fill--fav" :style="{ width: `${(effectiveCurationStats.fav_count / effectiveCurationStats.member_count) * 100}%` }" />
              </div>
              <span class="opinion-count">{{ effectiveCurationStats.fav_count }} von {{ effectiveCurationStats.member_count }}</span>
            </div>
            <div v-if="effectiveCurationStats.hide_count > 0" class="opinion-row">
              <span class="opinion-label"><i class="pi pi-thumbs-down-fill opinion-icon opinion-icon--hide" /> Ausgeblendet</span>
              <div class="opinion-bar-track">
                <div class="opinion-bar-fill opinion-bar-fill--hide" :style="{ width: `${(effectiveCurationStats.hide_count / effectiveCurationStats.member_count) * 100}%` }" />
              </div>
              <span class="opinion-count">{{ effectiveCurationStats.hide_count }} von {{ effectiveCurationStats.member_count }}</span>
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

      <!-- Comments, scoped to the album this photo is viewed in. Only
           shown inside an album context (album detail / shared album):
           outside an album there is no scope to attach a comment to, so
           commenting is unavailable in the gallery and persons views. -->
      <template v-if="albumId != null">
        <div class="sidebar-divider" />
        <div class="sidebar-section">
          <div class="section-label"><i class="pi pi-comments" /> Reaktionen</div>
          <PhotoReactions
            :photo-id="photo.id"
            :album-id="albumId"
            :read-only="readOnly"
            @comment-count-change="emit('comment-count-change', $event)"
          />
        </div>
      </template>

      <div class="sidebar-divider" />

      <div class="meta-list">
        <div class="meta-row">
          <i class="pi pi-calendar meta-icon" />
          <span class="meta-value date-value">{{ formatPhotoDateDisplay(photo) }}</span>
          <Button v-if="canEditPhotoMeta && !isEditingDate" icon="pi pi-pencil" text rounded size="small" @click="emit('start-edit-date')" class="edit-btn" />
        </div>
        <div v-if="isEditingDate" class="date-editor">
          <DatePicker v-model="editDate" showTime hourFormat="24" fluid />
          <div class="edit-actions">
            <Button icon="pi pi-check" severity="success" text rounded @click="emit('update-date')" :loading="updatingDate" />
            <Button icon="pi pi-times" severity="danger" text rounded @click="emit('cancel-edit-date')" :disabled="updatingDate" />
          </div>
        </div>
      </div>

      <template v-if="photo.location_city || photo.location_name || (poiMatches && poiMatches.length > 0) || loadingPoiMatches || (inFlyout && photo.latitude != null && photo.longitude != null)">
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
          <!-- POI matches (Epic #383). Each match has a name, optional
               Wikipedia link, optional Commons thumbnail, distance, and
               a score; ambiguous=true means the matcher couldn't pick
               a clear winner so we show all alternatives in a row. -->
          <div v-if="loadingPoiMatches" class="loading-row"><i class="pi pi-spin pi-spinner" /> Sehenswürdigkeit wird erkannt…</div>
          <div v-else-if="poiMatches && poiMatches.length > 0" class="poi-matches">
            <div v-for="m in poiMatches" :key="m.id" class="poi-match">
              <img
                v-if="m.commonsImageUrl"
                :src="m.commonsImageUrl"
                :alt="m.name"
                class="poi-thumb"
                loading="lazy"
              />
              <div class="poi-info">
                <div class="poi-name">
                  <a
                    v-if="m.wikipediaUrl"
                    :href="m.wikipediaUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ m.nameDe || m.name }}</a>
                  <span v-else>{{ m.nameDe || m.name }}</span>
                  <span v-if="m.ambiguous" class="poi-ambiguous" title="Eindeutigkeit nicht erreicht">?</span>
                </div>
                <div class="poi-meta">
                  <span v-if="m.distanceM !== null">{{ Math.round(m.distanceM) }} m</span>
                  <span class="poi-score">{{ Math.round(m.matchScore * 100) }}%</span>
                </div>
              </div>
            </div>
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
              <span class="person-name">{{ faceDisplayName(face) }}</span>
              <Button v-if="!readOnly" icon="pi pi-times" severity="secondary" text rounded size="small" @click="emit('ignore-face', face.id)" v-tooltip="'Entfernen'" />
            </div>
          </div>
          <Button v-if="!readOnly" label="Neu erkennen" icon="pi pi-refresh" @click="emit('reindex')" :loading="reindexingPhoto" :disabled="faceServiceAvailable === false" class="reindex-btn" severity="secondary" outlined size="small" :title="faceServiceAvailable === false ? 'Gesichtserkennungs-Dienst nicht verfügbar' : undefined" />
        </div>
      </template>

      <div class="sidebar-section">
        <div class="section-label section-label--with-action">
          <span><i class="pi pi-book" /> Alben</span>
          <!-- Jump to the gallery / other albums holding this photo. Lives
               in the quick-actions row in the docked sidebar, but that row
               is hidden in the flyout (split view) — surface it here so the
               "Foto anzeigen in…" navigation stays reachable there too. -->
          <PhotoLocationMenu
            v-if="inFlyout"
            :photo-id="photo.id"
            :exclude-all-photos="locationMenuExcludeAllPhotos"
            :exclude-album-id="albumId"
          />
        </div>
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
            v-if="!readOnly"
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
        <div v-if="ownerName" class="meta-row">
          <i class="pi pi-user meta-icon" />
          <span class="meta-value">{{ ownerName }}</span>
        </div>
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
    <PhotoTransformEditor
      v-model:visible="transformEditorVisible"
      :photo-id="photo.id"
      :photo-filename="photo.filename"
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
/* Label on the left, an inline action (e.g. the jump-to menu) on the
   right. The action button keeps its own normal-case styling. */
.section-label--with-action {
  justify-content: space-between;
}
.section-label--with-action > span {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

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

.poi-matches {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.4rem;
}
.poi-match {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.poi-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-hover-background);
  flex-shrink: 0;
}
.poi-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.poi-name { font-weight: 500; }
.poi-name a { color: var(--p-primary-color); text-decoration: none; }
.poi-name a:hover { text-decoration: underline; }
.poi-ambiguous {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 0.3rem;
  background: var(--p-tag-warn-background, rgba(255,160,0,0.2));
  color: var(--p-tag-warn-color);
  border-radius: 0.5rem;
  font-size: 0.7rem;
}
.poi-meta {
  display: flex;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.poi-score { font-variant-numeric: tabular-nums; }

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
