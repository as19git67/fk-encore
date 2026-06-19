<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import RadioButton from 'primevue/radiobutton'
import Message from 'primevue/message'
import { batchNotice } from '../../api/finance'

/**
 * Bulk-edit the notice field across the current basket selection.
 *
 * - replace: overwrite whatever each transaction had before.
 * - append: keep existing text, add the new line below (separated by
 *   a blank line). Existing-empty entries fall through to "new text only".
 *
 * Append-with-empty is rejected (server-side too) — it would be a no-op
 * the user did not intend.
 */

const props = defineProps<{
  visible: boolean
  transactionIds: number[]
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  applied: [response: { affected_transactions: number; skipped_unauthorized: number }]
}>()

const noticeText = ref('')
const mode = ref<'replace' | 'append'>('append')
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.visible,
  (open) => {
    if (open) {
      noticeText.value = ''
      mode.value = 'append'
      saving.value = false
      error.value = null
    }
  },
)

function close() {
  if (saving.value) return
  emit('update:visible', false)
}

async function apply() {
  if (props.transactionIds.length === 0) return
  const trimmed = noticeText.value.trim()
  if (mode.value === 'append' && trimmed.length === 0) {
    error.value = 'Bitte einen Text eingeben.'
    return
  }
  saving.value = true
  error.value = null
  try {
    const resp = await batchNotice({
      transaction_ids: props.transactionIds,
      notice: noticeText.value,
      mode: mode.value,
    })
    emit('applied', resp)
    emit('update:visible', false)
  } catch (e: any) {
    error.value = e?.message ?? 'Notiz konnte nicht angewendet werden'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Notiz auf Auswahl anwenden"
    :style="{ width: '32rem' }"
    :closable="!saving"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <p class="confirm-hint">
      {{ transactionIds.length }}
      Buchung{{ transactionIds.length === 1 ? '' : 'en' }} erhalten dieselbe Notiz.
    </p>

    <div class="mode-row">
      <div class="mode-option">
        <RadioButton v-model="mode" input-id="bn-append" value="append" />
        <label for="bn-append">
          <strong>Anhängen</strong>
          <span class="hint">— neuen Text unter der bestehenden Notiz hinzufügen</span>
        </label>
      </div>
      <div class="mode-option">
        <RadioButton v-model="mode" input-id="bn-replace" value="replace" />
        <label for="bn-replace">
          <strong>Ersetzen</strong>
          <span class="hint">— bestehende Notiz überschreiben (leer = leeren)</span>
        </label>
      </div>
    </div>

    <Textarea
      v-model="noticeText"
      class="notice-input"
      placeholder="Notiz …"
      rows="4"
      auto-resize
    />

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        text
        :disabled="saving"
        @click="close"
      />
      <Button
        label="Anwenden"
        icon="pi pi-check"
        :loading="saving"
        :disabled="transactionIds.length === 0"
        @click="apply"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-hint {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
}
.mode-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.mode-option {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.mode-option label {
  cursor: pointer;
  line-height: 1.35;
}
.mode-option .hint {
  color: var(--p-text-muted-color);
  margin-left: 0.25rem;
  font-size: 0.9rem;
}
.notice-input {
  width: 100%;
}
</style>
