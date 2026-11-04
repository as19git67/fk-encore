<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import Message from 'primevue/message'
import { batchReclassifyDocuments } from '../api/documents'

/** What runs again: only the AI on the text there is, text and AI, or OCR and AI. */
export type ReprocessMode = 'classify' | 'extract' | 'ocr'

const props = withDefaults(
  defineProps<{
    visible: boolean
    /** IDs of the currently selected documents. */
    documentIds: number[]
    /** The choice the dialog opens with. */
    initialMode?: ReprocessMode
  }>(),
  { initialMode: 'classify' },
)

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done', payload: { affected: number; mode: ReprocessMode; extractedFirst: number }): void
}>()

const MODES: { value: ReprocessMode; label: string; hint: string }[] = [
  {
    value: 'classify',
    label: 'Nur klassifizieren',
    hint: 'Der vorhandene Text bleibt; nur die KI-Analyse (Kategorie, Titel, Tags, Steuer) und die semantische Indexierung laufen neu. Dokumente ohne Text werden dabei zuerst eingelesen.',
  },
  {
    value: 'extract',
    label: 'Text neu einlesen und klassifizieren',
    hint: 'Text-Extraktion (OCR nur bei Bedarf), KI-Analyse und Indexierung laufen neu.',
  },
  {
    value: 'ocr',
    label: 'OCR erzwingen und klassifizieren',
    hint: 'Text-Layer der PDF ignorieren und komplett per OCR neu einlesen (hilft bei Scans mit fehlenden Leerzeichen oder fehlerhaften Zeichen).',
  },
]

const mode = ref<ReprocessMode>(props.initialMode)
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    mode.value = props.initialMode
    error.value = null
  },
)

const header = computed(() => (mode.value === 'classify' ? 'Neu klassifizieren' : 'OCR & KI neu starten'))

async function apply() {
  saving.value = true
  error.value = null
  try {
    const res = await batchReclassifyDocuments(
      mode.value === 'classify'
        ? { document_ids: props.documentIds, classify_only: true }
        : { document_ids: props.documentIds, force_ocr: mode.value === 'ocr' },
    )
    emit('done', {
      affected: res.affected_documents,
      mode: mode.value,
      extractedFirst: res.extracted_first ?? 0,
    })
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
    class="dialog-sm"
    :visible="visible"
    :modal="true"
    :closable="!saving"
    :header="header"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Anwenden auf <strong>{{ documentIds.length }}</strong>
      {{ documentIds.length === 1 ? 'Dokument' : 'Dokumente' }}
    </p>

    <p class="hint">
      Bestehende Kategorien, Titel und Tags können dabei überschrieben werden.
    </p>

    <div class="options" role="radiogroup" aria-label="Was neu laufen soll">
      <div v-for="m in MODES" :key="m.value" class="option">
        <RadioButton v-model="mode" :value="m.value" :input-id="`batch-reprocess-${m.value}`" name="batch-reprocess-mode" />
        <label :for="`batch-reprocess-${m.value}`">
          {{ m.label }}
          <span class="option-sub">{{ m.hint }}</span>
        </label>
      </div>
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
      <Button
        :label="mode === 'classify' ? 'Klassifizieren' : 'Neu starten'"
        :icon="mode === 'classify' ? 'pi pi-sparkles' : 'pi pi-refresh'"
        :loading="saving"
        @click="apply"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.count {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
}
.hint {
  margin: 0 0 1rem;
  font-size: var(--text-base);
  line-height: 1.4;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
  font-weight: 400;
}
.error-msg {
  margin-top: 0.75rem;
}
</style>
