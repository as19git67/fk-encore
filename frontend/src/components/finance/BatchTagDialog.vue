<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import RadioButton from 'primevue/radiobutton'
import TagAutoComplete from './TagAutoComplete.vue'
import Message from 'primevue/message'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useTagsStore } from '../../stores/finance/tags'

const props = defineProps<{
  visible: boolean
  transactionIds: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done'): void
}>()

const txStore = useTransactionsStore()
const tagsStore = useTagsStore()

const addTags = ref<string[]>([])
const removeTags = ref<string[]>([])
const mode = ref<'add' | 'replace'>('add')
const promoteAiTags = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
watch(
  () => props.visible,
  async (v) => {
    if (v && tagsStore.items.length === 0) {
      await tagsStore.refresh('user')
    }
    if (!v) {
      addTags.value = []
      removeTags.value = []
      mode.value = 'add'
      promoteAiTags.value = false
      error.value = null
    }
  },
)

async function apply() {
  if (addTags.value.length === 0 && removeTags.value.length === 0 && mode.value !== 'replace') {
    error.value = 'Mindestens einen Tag angeben oder „Ersetzen" wählen.'
    return
  }
  saving.value = true
  error.value = null
  try {
    await txStore.batchTag({
      transaction_ids: props.transactionIds,
      add: addTags.value,
      remove: mode.value === 'replace' ? undefined : removeTags.value,
      replace: mode.value === 'replace',
      promote_ai_tags: promoteAiTags.value,
    })
    tagsStore.addLocal(addTags.value)
    emit('done')
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
    :style="{ width: '32rem' }"
    header="Tags auf Auswahl anwenden"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Ausgewählt: <strong>{{ transactionIds.length }}</strong> Transaktionen
    </p>

    <div class="field">
      <label>Tags hinzufügen</label>
      <TagAutoComplete
        v-model="addTags"
        placeholder="Tag eingeben und Enter drücken"
      />
    </div>

    <div v-if="mode === 'add'" class="field">
      <label>Tags entfernen (optional)</label>
      <TagAutoComplete v-model="removeTags" />
    </div>

    <div class="mode">
      <div class="mode-option">
        <RadioButton v-model="mode" inputId="mode-add" value="add" />
        <label for="mode-add">Nur hinzufügen</label>
      </div>
      <div class="mode-option">
        <RadioButton v-model="mode" inputId="mode-replace" value="replace" />
        <label for="mode-replace">Vorhandene User-Tags ersetzen</label>
      </div>
    </div>

    <div class="ai-option">
      <Checkbox v-model="promoteAiTags" inputId="promote-ai" binary />
      <label for="promote-ai">KI-Tags übernehmen</label>
      <span class="ai-hint">{{ promoteAiTags ? 'KI-Tags werden zu manuellen Tags hochgestuft' : 'KI-Tags werden entfernt' }}</span>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        :disabled="saving"
        @click="emit('update:visible', false)"
      />
      <Button
        label="Anwenden"
        :loading="saving"
        @click="apply"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.count {
  margin: 0 0 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}
.mode {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.5rem;
}
.mode-option {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.ai-option {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--p-content-border-color);
}
.ai-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
</style>
