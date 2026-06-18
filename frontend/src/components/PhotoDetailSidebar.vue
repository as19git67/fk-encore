<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PhotoDetailSidebarBase from './PhotoDetailSidebarBase.vue'
import {
  getPhotoDetailsBatch,
  type CurationStatus,
  type Face,
  type Photo,
  type Person,
  type PoiMatchItem,
} from '../api/photos'
import {
  peekPhotoPoiMatchesCached,
  refreshPhotoPoiMatches,
} from '../composables/usePhotoMetaCache'

const props = defineProps<{
  photo: Photo
  selectedPhotoIds?: number[]
  faces: Face[]
  loadingFaces: boolean
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
  faceServiceAvailable?: boolean
  showNavigateToPhoto?: boolean
  locationMenuExcludeAllPhotos?: boolean
  inFlyout?: boolean
  flyoutOpen?: boolean
  imageReady?: boolean
  curationStats?: { fav_count: number; hide_count: number; member_count: number }
  readOnly?: boolean
}>()

const editDate = defineModel<Date | null>('editDate', { default: null })

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

// Gallery and album already pass hydrated photo records. Person detail can pass
// a face-embedded light photo object from /persons/:id; hydrate by photo id here
// so the split-view always shows the complete, shared photo-detail data path
// (description, owner, filename, GPS/location/map, quality, curation, albums…).
const hydratedPhoto = ref<Photo | null>(null)
const internalPoiMatches = ref<PoiMatchItem[]>([])
const internalLoadingPoiMatches = ref(false)
let hydrateToken = 0
let poiToken = 0

function needsHydration(photo: Photo): boolean {
  return photo.mime_type == null
    || photo.size == null
    || photo.curation_status == null
    || photo.user_id == null
    || photo.created_at == null
    || (photo.description === undefined
      && photo.latitude === undefined
      && photo.longitude === undefined
      && photo.location_name === undefined
      && photo.location_city === undefined
      && photo.location_country === undefined
      && photo.location_short === undefined
      && photo.ai_quality_score === undefined)
}

watch(() => props.photo.id, async (id) => {
  const token = ++hydrateToken
  hydratedPhoto.value = null
  if (!id || !needsHydration(props.photo)) return
  try {
    const res = await getPhotoDetailsBatch([id])
    if (token !== hydrateToken) return
    hydratedPhoto.value = res.photos.find(p => p.id === id) ?? null
  } catch {
    if (token === hydrateToken) hydratedPhoto.value = null
  }
}, { immediate: true })

watch(() => [props.photo.id, props.poiMatches] as const, async ([id, parentPoi]) => {
  const token = ++poiToken
  internalPoiMatches.value = []
  internalLoadingPoiMatches.value = false
  if (!id || parentPoi !== undefined) return

  const cached = peekPhotoPoiMatchesCached(id)
  if (cached !== undefined) {
    internalPoiMatches.value = cached
    return
  }

  internalLoadingPoiMatches.value = true
  try {
    const matches = await refreshPhotoPoiMatches(id)
    if (token !== poiToken) return
    internalPoiMatches.value = matches
  } catch {
    if (token === poiToken) internalPoiMatches.value = []
  } finally {
    if (token === poiToken) internalLoadingPoiMatches.value = false
  }
}, { immediate: true })

const effectivePhoto = computed<Photo>(() => {
  if (!hydratedPhoto.value) return props.photo
  // Keep optimistic curation changes from the parent/grid if they happen after
  // hydration. Other fields come from the canonical details endpoint.
  return {
    ...hydratedPhoto.value,
    curation_status: props.photo.curation_status ?? hydratedPhoto.value.curation_status,
  }
})

const effectivePoiMatches = computed(() => props.poiMatches ?? internalPoiMatches.value)
const effectiveLoadingPoiMatches = computed(() => props.loadingPoiMatches ?? internalLoadingPoiMatches.value)
</script>

<template>
  <PhotoDetailSidebarBase
    :photo="effectivePhoto"
    :selected-photo-ids="selectedPhotoIds"
    :faces="faces"
    :loading-faces="loadingFaces"
    :poi-matches="effectivePoiMatches"
    :loading-poi-matches="effectiveLoadingPoiMatches"
    :persons="persons"
    :can-delete="canDelete"
    :can-upload="canUpload"
    :reindexing-photo="reindexingPhoto"
    :is-editing-date="isEditingDate"
    v-model:editDate="editDate"
    :updating-date="updatingDate"
    :show-persons="showPersons"
    :limit-albums-shown="limitAlbumsShown"
    :album-id="albumId"
    :cover-photo-id="coverPhotoId"
    :album-role="albumRole"
    :face-service-available="faceServiceAvailable"
    :show-navigate-to-photo="showNavigateToPhoto"
    :location-menu-exclude-all-photos="locationMenuExcludeAllPhotos"
    :in-flyout="inFlyout"
    :flyout-open="flyoutOpen"
    :image-ready="imageReady"
    :curation-stats="curationStats"
    :read-only="readOnly"
    @update:coverPhotoId="emit('update:coverPhotoId', $event)"
    @fullscreen="emit('fullscreen')"
    @ignore-face="emit('ignore-face', $event)"
    @reindex="emit('reindex')"
    @start-edit-date="emit('start-edit-date')"
    @update-date="emit('update-date')"
    @cancel-edit-date="emit('cancel-edit-date')"
    @toggle-favorite="(id, status) => emit('toggle-favorite', id, status)"
    @hide="emit('hide', $event)"
    @restore="emit('restore', $event)"
    @navigate-to-photo="emit('navigate-to-photo', $event)"
    @comment-count-change="emit('comment-count-change', $event)"
  />
</template>
