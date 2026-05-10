<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import Select from 'primevue/select'
import Message from 'primevue/message'
import {
  batchUpdateDocumentVisibility,
  type DocumentSummary,
  type DocumentVisibility,
  type GroupSummary,
} from '../api/documents'

const props = defineProps<{
  visible: boolean
  /** Documents currently selected. We read `visibility` and `group_id`
   *  off them to pre-fill the form when all selected docs share the
   *  same visibility (the common case for batch edits). */
  documents: DocumentSummary[]
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

const documentIds = computed(() => props.documents.map((d) => d.id))

/** Common visibility across the selection, or null when mixed. */
const commonVisibility = computed<DocumentVisibility | null>(() => {
  const first = props.documents[0]
  if (!first) return null
  return props.documents.every((d) => d.visibility === first.visibility)
    ? first.visibility
    : null
})

/** Common group_id across the selection (only meaningful when
 *  `commonVisibility === 'group'`), or null when mixed. */
const commonGroupId = computed<number | null>(() => {
  const first = props.documents[0]
  if (!first) return null
  return props.documents.every((d) => d.group_id === first.group_id)
    ? first.group_id
    : null
})

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    // Pre-fill with the common state if the selection is uniform; fall
    // back to private + first-group otherwise so the user has a sane
    // starting point either way.
    if (commonVisibility.value === 'group' && commonGroupId.value != null) {
      visibility.value = 'group'
      groupId.value = commonGroupId.value
    } else if (commonVisibility.value === 'private') {
      visibility.value = 'private'
      groupId.value = props.groups[0]?.id ?? null
    } else {
      visibility.value = 'private'
      groupId.value = props.groups[0]?.id ?? null
    }
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
      document_ids: documentIds.value,
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
    :breakpoints="{ '768px': '95vw' }"
    header="Sichtbarkeit ändern"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="count">
      Anwenden auf <strong>{{ documents.length }}</strong>
      {{ documents.length === 1 ? 'Dokument' : 'Dokumente' }}
    </p>

    <Message
      v-if="documents.length > 1 && commonVisibility === null"
      severity="info"
      :closable="false"
      class="mixed-msg"
    >
      Die ausgewählten Dokumente haben unterschiedliche Sichtbarkeiten.
    </Message>

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
.mixed-msg {
  margin-bottom: 0.75rem;
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
