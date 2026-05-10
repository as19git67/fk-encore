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
/** Combined loading flag: true while EITHER the album list OR the
 *  per-photo album map is in flight. The downstream MultiSelectDialog
 *  watches this transition to refresh its tristate baseline once the
 *  data has actually arrived (otherwise the synchronous snapshot at
 *  open-time captures an empty `photoAlbumMap` and every album shows
 *  as unchecked). */
const loading = ref(false)
const photoAlbumMap = ref<Record<number, number[]>>({})
const saving = ref(false)

async function loadAlbumsList() {
  if (albumsLoaded.value) return
  await fetchAlbums()
}

async function loadPhotosAlbums() {
  if (props.photoIds.length === 0) {
    photoAlbumMap.value = {}
    return
  }
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
    loading.value = true
    try {
      await Promise.all([loadAlbumsList(), loadPhotosAlbums()])
    } finally {
      loading.value = false
    }
  },
)

const items = computed(() => albums.value.map((a) => ({ id: a.id, label: a.name })))

/**
 * Reactive lookup function. We expose it as a computed (and not as an
 * inline arrow on the template) so Vue tracks `photoAlbumMap` and
 * `photoIds` as render dependencies of this component. Without that,
 * `photoAlbumMap.value = …` after the fetch wouldn't re-render the
 * parent, MultiSelectDialog would keep handing out stale `false`
 * tristate values, and every album would appear unchecked even when
 * the selected photos were already in it.
 */
const initialState = computed(() => {
  const map = photoAlbumMap.value
  const ids = props.photoIds
  return (id: number) => calculateAlbumCheckState(id, ids, map)
})

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
    :initial-state="initialState"
    :subject-count="photoIds.length"
    :subject-label="photoIds.length === 1 ? 'Foto' : 'Fotos'"
    :loading="loading"
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
