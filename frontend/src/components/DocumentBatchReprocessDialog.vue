<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { batchReclassifyDocuments } from '../api/documents'

const props = defineProps<{
  visible: boolean
  /** IDs of the currently selected documents. */
  documentIds: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done', payload: { affected: number }): void
}>()

const forceOcr = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    // Default to the cheaper path (reuse the existing text layer); the
    // user opts into full OCR explicitly via the checkbox.
    forceOcr.value = false
    error.value = null
  },
)

async function apply() {
  saving.value = true
  error.value = null
  try {
    const res = await batchReclassifyDocuments({
      document_ids: props.documentIds,
      force_ocr: forceOcr.value,
    })
    emit('done', { affected: res.affected_documents })
    emit('update:visible', false)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    :modal="true"
    :closable="!saving"
    :style="{ width: '30rem' }"
    :breakpoints="{ '768px': '95vw' }"
    header="OCR & KI neu starten"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Anwenden auf <strong>{{ documentIds.length }}</strong>
      {{ documentIds.length === 1 ? 'Dokument' : 'Dokumente' }}
    </p>

    <p class="hint">
      Text-Extraktion (inkl. OCR bei Bedarf), KI-Klassifikation und die
      semantische Indexierung werden für die ausgewählten Dokumente erneut
      ausgeführt. Bestehende Kategorien, Titel und Tags können dabei
      überschrieben werden.
    </p>

    <div class="option">
      <Checkbox v-model="forceOcr" :binary="true" inputId="batch-force-ocr" />
      <label for="batch-force-ocr">
        OCR erzwingen
        <span class="option-sub">
          Text-Layer der PDF ignorieren und komplett per OCR neu einlesen
          (hilft bei Scans mit fehlenden Leerzeichen oder fehlerhaften
          Zeichen).
        </span>
      </label>
    </div>

    <Message v-if="error" severity="error" :closable="false" class="error-msg">
      {{ error }}
    </Message>

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        :disabled="saving"
        @click="emit('update:visible', false)"
      />
      <Button label="Neu starten" icon="pi pi-refresh" :loading="saving" @click="apply" />
    </template>
  </Dialog>
</template>

<style scoped>
.count {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.hint {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  line-height: 1.4;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.option label {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.option-sub {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  font-weight: 400;
}
.error-msg {
  margin-top: 0.75rem;
}
</style>
