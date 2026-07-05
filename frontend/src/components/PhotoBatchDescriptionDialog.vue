<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Textarea from 'primevue/textarea'
import { batchUpdatePhotoDescriptions, getPhotoDetailsBatch } from '../api/photos'

const props = defineProps<{
  visible: boolean
  photoIds: number[]
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: [updatedIds: number[]]
}>()

const description = ref('')
const existingCount = ref(0)
const inspecting = ref(false)
const inspectionFailed = ref(false)
const saving = ref(false)
const error = ref('')

const photoCountLabel = computed(() => `${props.photoIds.length} ${props.photoIds.length === 1 ? 'Foto' : 'Fotos'}`)

watch(() => props.visible, async (visible) => {
  if (!visible) return
  description.value = ''
  existingCount.value = 0
  inspectionFailed.value = false
  error.value = ''
  inspecting.value = true
  try {
    let count = 0
    for (let start = 0; start < props.photoIds.length; start += 100) {
      const result = await getPhotoDetailsBatch(props.photoIds.slice(start, start + 100))
      count += result.photos.filter(photo => !!photo.description?.trim()).length
    }
    existingCount.value = count
  } catch (err: any) {
    inspectionFailed.value = true
    error.value = err?.message ?? 'Vorhandene Beschreibungen konnten nicht geprüft werden.'
  } finally {
    inspecting.value = false
  }
})

function close() {
  if (!saving.value) emit('update:visible', false)
}

async function save() {
  if (props.photoIds.length === 0 || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const result = await batchUpdatePhotoDescriptions(props.photoIds, description.value.trim() || null)
    if (result.updated.length === 0) {
      error.value = 'Keines der ausgewählten Fotos darf bearbeitet werden.'
      return
    }
    emit('saved', result.updated)
    emit('update:visible', false)
  } catch (err: any) {
    error.value = err?.message ?? 'Die Beschreibungen konnten nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Beschreibung bearbeiten"
    :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
    :closable="!saving"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="batch-description-content">
      <p class="batch-description-hint">
        Diese Beschreibung wird für {{ photoCountLabel }} übernommen.
      </p>
      <Message v-if="existingCount > 0" severity="warn" :closable="false">
        {{ existingCount }} {{ existingCount === 1 ? 'vorhandene Beschreibung wird' : 'vorhandene Beschreibungen werden' }} überschrieben.
      </Message>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Textarea
        v-model="description"
        rows="5"
        auto-resize
        autofocus
        class="batch-description-input"
        placeholder="Beschreibung eingeben…"
        :disabled="saving"
      />
      <small>Ein leeres Feld entfernt die Beschreibung von allen ausgewählten Fotos.</small>
    </div>
    <template #footer>
      <Button label="Abbrechen" severity="secondary" text :disabled="saving" @click="close" />
      <Button
        label="Übernehmen"
        icon="pi pi-check"
        :loading="saving"
        :disabled="inspecting || inspectionFailed"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.batch-description-content {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.batch-description-hint {
  margin: 0;
}

.batch-description-input {
  width: 100%;
  resize: vertical;
}
</style>
