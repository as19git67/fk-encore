<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import { filterAlbums, sortAlbumsForDialog, type UploadAlbum } from '../utils/feedUpload'

const props = defineProps<{
  visible: boolean
  albums: UploadAlbum[]
  initial: number[]
  fileCount: number
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'confirm', ids: number[]): void
  (e: 'cancel'): void
}>()

const selected = ref<number[]>([])
const query = ref('')
watch(
  () => props.visible,
  (v) => {
    if (v) {
      selected.value = [...props.initial]
      query.value = ''
    }
  },
)

// Pre-selected albums first (then alphabetical), with the search applied on
// top. Ordering uses the initial pre-selection so rows don't jump while the
// user toggles checkboxes. Selection is by id, so it survives filtering.
const visibleAlbums = computed(() =>
  filterAlbums(sortAlbumsForDialog(props.albums, props.initial), query.value),
)

// At least one album is mandatory.
const canConfirm = computed(() => selected.value.length > 0)

function confirm() {
  if (!canConfirm.value) return
  emit('confirm', [...selected.value])
}

function cancel() {
  emit('cancel')
  emit('update:visible', false)
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="In welche Alben aufnehmen?"
    :style="{ width: '28rem' }"
    :breakpoints="{ '640px': '92vw' }"
    :dismissableMask="true"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <p class="hint">
      {{ fileCount }} {{ fileCount === 1 ? 'Foto' : 'Fotos' }} hochladen — wähle mindestens ein Album.
    </p>
    <span class="search">
      <i class="pi pi-search" />
      <InputText v-model="query" placeholder="Album suchen…" class="search-input" />
    </span>
    <div class="album-list">
      <label v-for="a in visibleAlbums" :key="a.id" class="album-row">
        <Checkbox v-model="selected" :value="a.id" />
        <span class="album-name">{{ a.name }}</span>
      </label>
      <p v-if="visibleAlbums.length === 0" class="no-match">Keine Alben gefunden.</p>
    </div>
    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="cancel" />
      <Button label="Hochladen" icon="pi pi-upload" :disabled="!canConfirm" @click="confirm" />
    </template>
  </Dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 0.6rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}
.search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
  color: var(--p-text-muted-color);
}
.search-input {
  flex: 1;
  min-width: 0;
}
.no-match {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  padding: 0.5rem 0.4rem;
}
.album-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 45vh;
  overflow-y: auto;
}
.album-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.4rem;
  border-radius: 6px;
  cursor: pointer;
}
.album-row:hover {
  background: var(--p-content-hover-background);
}
.album-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
