<script setup lang="ts">
/**
 * "Auswahl ändern": the narrowing a book was made with — quality, aesthetics,
 * faces, the maximum, series and weights — changed afterwards. Saving lays
 * the book out again from its source under the new narrowing, so it says
 * what is lost, like "Neu verteilen". When nothing is left the book stays as
 * it was.
 */
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import PhotoBookNarrowingFields from './PhotoBookNarrowingFields.vue'
import { rebuildPhotoBook, type PhotoBook } from '../../api/photoBooks'
import { draftToNarrowing, narrowingDraft } from '../../utils/photoBookNarrowing'

const props = defineProps<{ visible: boolean; book: PhotoBook }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved', book: PhotoBook): void
}>()

const draft = ref(narrowingDraft(props.book.source))
const saving = ref(false)
const error = ref('')

watch(() => props.visible, (open) => {
  if (!open) return
  draft.value = narrowingDraft(props.book.source)
  error.value = ''
})

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    emit('saved', await rebuildPhotoBook(props.book.id, draftToNarrowing(draft.value)))
    emit('update:visible', false)
  } catch (err: any) {
    error.value = err?.code === 'failed_precondition'
      ? 'Nach dem Eingrenzen bleibt kein Foto übrig. Das Buch bleibt, wie es ist.'
      : err?.message ?? 'Die Auswahl konnte nicht geändert werden.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Auswahl ändern"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="pbn-lead">
      Das Buch wird danach aus seiner Quelle neu verteilt. Geänderte Kapiteltitel, Layouts und herausgenommene Fotos gehen dabei verloren; Bildunterschriften bleiben.
    </p>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <PhotoBookNarrowingFields v-model="draft" id-prefix="pbn" />
    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button label="Übernehmen und neu verteilen" icon="pi pi-refresh" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.pbn-lead {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
</style>
