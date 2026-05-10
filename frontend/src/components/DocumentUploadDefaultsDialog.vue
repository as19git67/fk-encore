<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import Select from 'primevue/select'
import Message from 'primevue/message'
import {
  getUploadDefaults,
  setUploadDefaults,
  type GroupSummary,
} from '../api/documents'

const props = defineProps<{
  visible: boolean
  groups: GroupSummary[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved'): void
}>()

const mode = ref<'private' | 'group'>('private')
const groupId = ref<number | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

const groupOptions = computed(() =>
  props.groups.map((g) => ({ label: g.name, value: g.id })),
)

watch(
  () => props.visible,
  async (v) => {
    if (!v) return
    error.value = null
    loading.value = true
    try {
      const cur = await getUploadDefaults()
      if (cur.group_id != null && props.groups.some((g) => g.id === cur.group_id)) {
        mode.value = 'group'
        groupId.value = cur.group_id
      } else {
        mode.value = 'private'
        groupId.value = props.groups[0]?.id ?? null
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  },
)

async function save() {
  if (mode.value === 'group' && groupId.value == null) {
    error.value = 'Bitte eine Gruppe auswählen.'
    return
  }
  saving.value = true
  error.value = null
  try {
    await setUploadDefaults({
      group_id: mode.value === 'group' ? groupId.value : null,
    })
    emit('saved')
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
    header="Standard für neue Dokumente"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <p class="hint">
      Neu hochgeladene Dokumente landen automatisch in der gewählten Gruppe.
    </p>

    <div v-if="loading" class="loading-row">
      <i class="pi pi-spin pi-spinner" /> Lade Einstellung…
    </div>

    <template v-else>
      <div class="option">
        <RadioButton v-model="mode" inputId="def-private" value="private" />
        <label for="def-private">Privat (Standard)</label>
      </div>
      <div class="option">
        <RadioButton
          v-model="mode"
          inputId="def-group"
          value="group"
          :disabled="groups.length === 0"
        />
        <label for="def-group">Standardmäßig in Gruppe</label>
      </div>

      <div v-if="mode === 'group'" class="group-row">
        <Select
          v-model="groupId"
          :options="groupOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Gruppe wählen…"
          class="group-select"
        />
      </div>
    </template>

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
        label="Speichern"
        :loading="saving"
        :disabled="loading"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 1rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.loading-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
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
