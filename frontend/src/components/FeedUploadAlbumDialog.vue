<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import type { UploadAlbum } from '../utils/feedUpload'

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
watch(
  () => props.visible,
  (v) => {
    if (v) selected.value = [...props.initial]
  },
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
    :dismissableMask="true"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <p class="hint">
      {{ fileCount }} {{ fileCount === 1 ? 'Foto' : 'Fotos' }} hochladen — wähle mindestens ein Album.
    </p>
    <div class="album-list">
      <label v-for="a in albums" :key="a.id" class="album-row">
        <Checkbox v-model="selected" :value="a.id" />
        <span class="album-name">{{ a.name }}</span>
      </label>
    </div>
    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="cancel" />
      <Button label="Hochladen" icon="pi pi-upload" :disabled="!canConfirm" @click="confirm" />
    </template>
  </Dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
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
