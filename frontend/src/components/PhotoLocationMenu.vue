<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import { getPhotoLocations } from '../api/photos'
import { usePhotoNavStore } from '../stores/photoNav'

type Destination =
  | { kind: 'all-photos' }
  | { kind: 'album'; id: number; name: string }

const props = defineProps<{
  /** ID of the photo whose jump destinations should be shown. */
  photoId: number
  /** When true, hide the "Alle Fotos" option (we're already there). */
  excludeAllPhotos?: boolean
  /** Hide the entry for this album (we're already viewing it). */
  excludeAlbumId?: number
  /**
   * When true, navigate so the target view *selects the photo in its grid*
   * (via the photoNav store) instead of deep-linking it open in fullscreen.
   * Used by the feed, where tapping "open in" should land on the grid with
   * the photo highlighted.
   */
  selectInGrid?: boolean
  /** Extra query params merged into the navigation (e.g. { from: 'stream' }). */
  extraQuery?: Record<string, string>
}>()

const router = useRouter()
const photoNav = usePhotoNavStore()
const loading = ref(false)
const dialogVisible = ref(false)
const destinations = ref<Destination[]>([])

function goToAllPhotos() {
  if (props.selectInGrid) {
    photoNav.selectPhoto(props.photoId)
    router.push({ name: 'fotos-gallery', query: { ...(props.extraQuery ?? {}) } })
    return
  }
  router.push({ name: 'fotos-gallery', query: { photoId: String(props.photoId), ...(props.extraQuery ?? {}) } })
}
function goToAlbum(albumId: number) {
  if (props.selectInGrid) {
    photoNav.selectPhotoInAlbum(props.photoId, albumId)
    router.push({ name: 'fotos-album-detail', params: { id: String(albumId) }, query: { ...(props.extraQuery ?? {}) } })
    return
  }
  router.push({ name: 'fotos-album-detail', params: { id: String(albumId) }, query: { photoId: String(props.photoId), ...(props.extraQuery ?? {}) } })
}

function goTo(dest: Destination) {
  dialogVisible.value = false
  if (dest.kind === 'all-photos') goToAllPhotos()
  else goToAlbum(dest.id)
}

async function handleClick(event: MouseEvent) {
  // Prevent the click from bubbling to ancestors that may close overlays.
  event.stopPropagation()
  if (loading.value) return
  loading.value = true
  try {
    const locations = await getPhotoLocations(props.photoId)

    const list: Destination[] = []
    if (!props.excludeAllPhotos) {
      list.push({ kind: 'all-photos' })
    }
    for (const a of locations.albums) {
      if (props.excludeAlbumId === a.id) continue
      list.push({ kind: 'album', id: a.id, name: a.name })
    }

    if (list.length === 1) {
      // Only one target — navigate directly without showing the dialog.
      goTo(list[0]!)
      return
    }

    destinations.value = list
    dialogVisible.value = true
  } catch (err) {
    console.error('Failed to load photo locations:', err)
  } finally {
    loading.value = false
  }
}

function iconFor(dest: Destination): string {
  if (dest.kind === 'all-photos') return 'pi pi-images'
  return 'pi pi-book'
}

function labelFor(dest: Destination): string {
  if (dest.kind === 'all-photos') return 'Alle Fotos'
  return dest.name
}

const albumDests = () => destinations.value.filter((d): d is Extract<Destination, { kind: 'album' }> => d.kind === 'album')
const allPhotosDest = () => destinations.value.find((d): d is Extract<Destination, { kind: 'all-photos' }> => d.kind === 'all-photos')
</script>

<template>
  <Button
    :icon="loading ? 'pi pi-spin pi-spinner' : 'pi pi-external-link'"
    severity="secondary"
    text
    rounded
    :disabled="loading"
    v-tooltip.bottom="'Foto anzeigen in\u2026'"
    aria-label="Foto anzeigen in…"
    @click="handleClick"
  />
  <Dialog
    v-model:visible="dialogVisible"
    modal
    header="Foto anzeigen in…"
    :style="{ width: 'min(100%, 28rem)' }"
    :dismissable-mask="true"
    :draggable="false"
  >
    <div v-if="destinations.length === 0" class="plm-empty">
      Keine weiteren Fundorte.
    </div>
    <div v-else class="plm-list">
      <button
        v-if="allPhotosDest()"
        type="button"
        class="plm-item"
        @click="goTo(allPhotosDest()!)"
      >
        <i :class="iconFor(allPhotosDest()!)" />
        <span class="plm-label">{{ labelFor(allPhotosDest()!) }}</span>
      </button>

      <template v-if="albumDests().length > 0">
        <div class="plm-section-header">Alben</div>
        <button
          v-for="a in albumDests()"
          :key="'a-' + a.id"
          type="button"
          class="plm-item"
          @click="goTo(a)"
        >
          <i :class="iconFor(a)" />
          <span class="plm-label">{{ labelFor(a) }}</span>
        </button>
      </template>
    </div>

    <template #footer>
      <Button label="Abbrechen" icon="pi pi-times" text @click="dialogVisible = false" />
    </template>
  </Dialog>
</template>

<style scoped>
.plm-empty {
  padding: 1rem 0.25rem;
  color: var(--p-text-muted-color);
  text-align: center;
}

.plm-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.plm-section-header {
  font-size: 0.75em;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.5rem 0.25rem 0.25rem;
}

.plm-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}

.plm-item:hover,
.plm-item:focus-visible {
  background: var(--p-content-hover-background);
  outline: none;
}

.plm-item .pi {
  font-size: 1.1em;
  opacity: 0.8;
  flex-shrink: 0;
}

.plm-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
