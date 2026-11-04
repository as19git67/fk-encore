<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { batchReclassifyDocuments } from '../api/documents'

/**
 * "Neu klassifizieren" for one document or many (basket, detail page).
 *
 * Conservative by default: only the AI runs again on the text there is, and
 * whatever a human pinned stays. Each box opts into more — handing the
 * attribution or the tax assignment back to the classifier, or reading the
 * text anew with OCR first. A reset is the destructive part, so the button
 * turns red as soon as one is ticked.
 */
const props = withDefaults(
  defineProps<{
    visible: boolean
    /** IDs of the documents to reprocess. */
    documentIds: number[]
    /** Text documents written in the app have no scan to OCR. */
    allowOcr?: boolean
  }>(),
  { allowOcr: true },
)

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done', payload: { affected: number; extractedFirst: number; reset: boolean; ocr: boolean }): void
}>()

const resetAttributes = ref(false)
const resetTax = ref(false)
const ocr = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    resetAttributes.value = false
    resetTax.value = false
    ocr.value = false
    error.value = null
  },
)

const resetting = computed(() => resetAttributes.value || resetTax.value)
const noun = computed(() => (props.documentIds.length === 1 ? 'Dokument' : 'Dokumente'))
const applyLabel = computed(() => (resetting.value ? 'Zurücksetzen und klassifizieren' : 'Klassifizieren'))

async function apply() {
  saving.value = true
  error.value = null
  try {
    const res = await batchReclassifyDocuments({
      document_ids: props.documentIds,
      classify_only: true,
      force_ocr: ocr.value && props.allowOcr ? true : undefined,
      reset_attributes: resetAttributes.value || undefined,
      reset_tax: resetTax.value || undefined,
    })
    emit('done', {
      affected: res.affected_documents,
      extractedFirst: res.extracted_first ?? 0,
      reset: resetting.value,
      ocr: ocr.value && props.allowOcr,
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
    header="Neu klassifizieren"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Anwenden auf <strong>{{ documentIds.length }}</strong> {{ noun }}
    </p>

    <p class="hint">
      Die KI-Analyse (Kategorie, Titel, Tags, Steuer) und die semantische Indexierung laufen
      neu, der vorhandene Text bleibt. Was von Hand gesetzt oder bestätigt wurde, bleibt
      stehen, solange du es hier nicht zurücksetzt.
    </p>

    <div class="options">
      <div class="option">
        <Checkbox v-model="resetAttributes" :binary="true" input-id="reprocess-reset-attributes" />
        <label for="reprocess-reset-attributes">
          Attributierung zurücksetzen
          <span class="option-sub">
            Von Hand gesetzte Kategorie, Titel, Datum, Absender, Tags und Bezugspersonen sowie
            „Zuordnung bestätigt“ gehen an die KI zurück und werden neu bestimmt.
          </span>
        </label>
      </div>
      <div class="option">
        <Checkbox v-model="resetTax" :binary="true" input-id="reprocess-reset-tax" />
        <label for="reprocess-reset-tax">
          Steuerliche Einordnung zurücksetzen
          <span class="option-sub">
            Von Hand gesetzte Steuerrolle, Steuerjahr und Sektionen gehen an die KI zurück. Bei
            einer von Hand gesetzten Kategorie wirkt das nur zusammen mit der Attributierung.
          </span>
        </label>
      </div>
      <div v-if="allowOcr" class="option">
        <Checkbox v-model="ocr" :binary="true" input-id="reprocess-ocr" />
        <label for="reprocess-ocr">
          Vorher OCR ausführen
          <span class="option-sub">
            Text-Layer der PDF ignorieren und komplett per OCR neu einlesen (hilft bei Scans mit
            fehlenden Leerzeichen oder fehlerhaften Zeichen). Dauert deutlich länger.
          </span>
        </label>
      </div>
    </div>

    <Message v-if="resetting" severity="warn" :closable="false" class="warn-msg">
      Von Hand gepflegte Angaben können dabei verloren gehen.
    </Message>

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
        :label="applyLabel"
        :icon="resetting ? 'pi pi-exclamation-triangle' : 'pi pi-sparkles'"
        :severity="resetting ? 'danger' : undefined"
        :loading="saving"
        data-testid="reprocess-apply"
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
.warn-msg,
.error-msg {
  margin-top: 0.75rem;
}
</style>
