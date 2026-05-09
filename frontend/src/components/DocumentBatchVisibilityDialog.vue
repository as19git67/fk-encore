<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import Select from 'primevue/select'
import Message from 'primevue/message'
import {
  batchUpdateDocumentVisibility,
  type DocumentVisibility,
  type GroupSummary,
} from '../api/documents'

const props = defineProps<{
  visible: boolean
  documentIds: number[]
  groups: GroupSummary[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'done', payload: { affected: number; skipped: number }): void
}>()

const visibility = ref<DocumentVisibility>('private')
const groupId = ref<number | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    visibility.value = 'private'
    groupId.value = props.groups[0]?.id ?? null
    error.value = null
  },
)

const groupOptions = computed(() =>
  props.groups.map((g) => ({ label: g.name, value: g.id })),
)

async function apply() {
  if (visibility.value === 'group' && groupId.value == null) {
    error.value = 'Bitte eine Gruppe auswählen.'
    return
  }
  saving.value = true
  error.value = null
  try {
    const res = await batchUpdateDocumentVisibility({
      document_ids: props.documentIds,
      visibility: visibility.value,
      group_id: visibility.value === 'group' ? groupId.value : null,
    })
    emit('done', {
      affected: res.affected_documents,
      skipped: res.skipped_unauthorized,
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
    :visible="visible"
    :modal="true"
    :closable="!saving"
    :style="{ width: '28rem' }"
    header="Sichtbarkeit ändern"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Anwenden auf <strong>{{ documentIds.length }}</strong>
      {{ documentIds.length === 1 ? 'Dokument' : 'Dokumente' }}
    </p>

    <div class="option">
      <RadioButton
        v-model="visibility"
        inputId="vis-private"
        value="private"
      />
      <label for="vis-private">Privat (nur für mich)</label>
    </div>
    <div class="option">
      <RadioButton
        v-model="visibility"
        inputId="vis-group"
        value="group"
        :disabled="groups.length === 0"
      />
      <label for="vis-group">Gruppe</label>
    </div>

    <div v-if="visibility === 'group'" class="group-row">
      <Select
        v-model="groupId"
        :options="groupOptions"
        optionLabel="label"
        optionValue="value"
        placeholder="Gruppe wählen…"
        class="group-select"
      />
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
      <Button label="Anwenden" :loading="saving" @click="apply" />
    </template>
  </Dialog>
</template>

<style scoped>
.count {
  margin: 0 0 1rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.option label {
  cursor: pointer;
}
.group-row {
  margin-top: 0.5rem;
  margin-left: 1.75rem;
}
.group-select {
  width: 100%;
}
.error-msg {
  margin-top: 0.75rem;
}
</style>
