<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MultiSelectDialog from './MultiSelectDialog.vue'
import {
  getPhotosAlbums,
  batchUpdateAlbumPhotos,
  createAlbum,
} from '../api/photos'
import { getAlbumCheckState as calculateAlbumCheckState } from '../utils/albumSelection'
import { useReferenceData } from '../composables/useReferenceData'

/**
 * Self-contained album-multi-select dialog driven by a list of photo IDs.
 * Loads /photos/albums for the current set whenever the dialog opens (so
 * the tristate baseline matches the current selection), saves via
 * `batchUpdateAlbumPhotos`, and lets the user create a new album inline.
 *
 * Used both from `PhotoDetailSidebar` (single + multi from the sidebar)
 * and from `GalleryView`'s mobile select-bar where the sidebar is not
 * available (#345).
 */
const props = defineProps<{
  visible: boolean
  /** Photos to operate on. 1 ID = single-photo mode, 2+ = batch mode. */
  photoIds: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved'): void
}>()

const { albums, albumsLoaded, fetchAlbums, invalidateAlbums } = useReferenceData()
const loadingAlbums = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({})
const saving = ref(false)

async function loadAlbumsList() {
  if (albumsLoaded.value) return
  loadingAlbums.value = true
  try {
    await fetchAlbums()
  } finally {
    loadingAlbums.value = false
  }
}

async function loadPhotosAlbums() {
  if (props.photoIds.length === 0) return
  try {
    const res = await getPhotosAlbums(props.photoIds)
    const map: Record<number, number[]> = {}
    res.results.forEach((r) => {
      map[r.photoId] = r.albumIds
    })
    photoAlbumMap.value = map
  } catch (err) {
    console.error('Failed to load photos albums:', err)
  }
}

watch(
  () => props.visible,
  async (v) => {
    if (!v) return
    await loadAlbumsList()
    await loadPhotosAlbums()
  },
)

const items = computed(() => albums.value.map((a) => ({ id: a.id, label: a.name })))

function getAlbumCheckState(albumId: number) {
  return calculateAlbumCheckState(albumId, props.photoIds, photoAlbumMap.value)
}

async function onSave(payload: { adds: number[]; removes: number[] }) {
  if (props.photoIds.length === 0) return
  saving.value = true
  try {
    if (payload.adds.length > 0) {
      await batchUpdateAlbumPhotos(payload.adds, props.photoIds, 'add')
    }
    if (payload.removes.length > 0) {
      await batchUpdateAlbumPhotos(payload.removes, props.photoIds, 'remove')
    }
    await loadPhotosAlbums()
    emit('saved')
    emit('update:visible', false)
  } catch (err) {
    console.error('Failed to save album changes:', err)
  } finally {
    saving.value = false
  }
}

async function onCreate(name: string) {
  try {
    await createAlbum(name)
    invalidateAlbums()
    await fetchAlbums(true)
  } catch (err) {
    console.error('Failed to create album:', err)
  }
}
</script>

<template>
  <MultiSelectDialog
    :visible="visible"
    title="Alben zuweisen"
    :items="items"
    :initial-state="(id) => getAlbumCheckState(id as number)"
    :subject-count="photoIds.length"
    :subject-label="photoIds.length === 1 ? 'Foto' : 'Fotos'"
    :loading="loadingAlbums"
    :saving="saving"
    allow-create
    create-label="Neues Album"
    create-placeholder="Albumname…"
    empty-message="Keine Alben vorhanden"
    @update:visible="(v) => emit('update:visible', v)"
    @save="onSave"
    @create="onCreate"
  />
</template>
