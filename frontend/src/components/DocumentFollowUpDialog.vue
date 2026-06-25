<script setup lang="ts">
/**
 * Schedule a follow-up ("Wiedervorlage") for one or more documents.
 *
 * Picks a future date and an optional note; saving parks the documents out of
 * the work-item basket until that date, when the daily cron returns them and
 * notifies the user. Used from both the basket (multi-select) and the document
 * detail view (single document).
 */
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Textarea from 'primevue/textarea'
import Message from 'primevue/message'
import { setDocumentFollowUp } from '../api/documents'
import { toLocalIsoDate } from '../utils/dateFormat'

const props = defineProps<{
  visible: boolean
  documentIds: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done', payload: { scheduled: number }): void
}>()

const date = ref<Date | null>(null)
const note = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

/** Tomorrow — the earliest valid follow-up date (must be in the future). */
const minDate = computed(() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d
})

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    // Default to one week out — a sensible "deal with it later" horizon.
    const d = new Date()
    d.setDate(d.getDate() + 7)
    d.setHours(0, 0, 0, 0)
    date.value = d
    note.value = ''
    error.value = null
  },
)

async function apply() {
  if (props.documentIds.length === 0) return
  if (!date.value) {
    error.value = 'Bitte ein Datum wählen.'
    return
  }
  saving.value = true
  error.value = null
  try {
    const res = await setDocumentFollowUp({
      document_ids: props.documentIds,
      follow_up_date: toLocalIsoDate(date.value),
      note: note.value.trim() || null,
    })
    emit('done', { scheduled: res.scheduled })
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
    :style="{ width: '26rem' }"
    :breakpoints="{ '768px': '95vw' }"
    header="Wiedervorlage"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Wiedervorlage für <strong>{{ documentIds.length }}</strong>
      {{ documentIds.length === 1 ? 'Dokument' : 'Dokumente' }}.
      Das Dokument verschwindet aus dem Arbeitskorb und taucht am gewählten
      Datum wieder auf.
    </p>

    <label class="field">
      <span class="label">Datum</span>
      <DatePicker
        v-model="date"
        date-format="dd.mm.yy"
        :min-date="minDate"
        show-icon
        fluid
      />
    </label>

    <label class="field">
      <span class="label">Notiz (optional)</span>
      <Textarea v-model="note" rows="2" auto-resize fluid placeholder="z. B. Beleg nachreichen" />
    </label>

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
      <Button label="Speichern" icon="pi pi-clock" :loading="saving" @click="apply" />
    </template>
  </Dialog>
</template>

<style scoped>
.count {
  margin: 0 0 1rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.field {
  display: block;
  margin-bottom: 0.85rem;
}
.label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
  color: var(--p-text-muted-color);
}
.error-msg {
  margin-top: 0.5rem;
}
</style>
