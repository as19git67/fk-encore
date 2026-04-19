<script setup lang="ts">
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import type { SortField, SortState } from '../composables/useSort'

/**
 * Dialog for configuring a list view's sort order. Mirrors FilterMenu:
 * edits a draft in place, parent owns `visible` and `draft` via v-model, and
 * emits `apply` / `reset` which the parent hooks into its data flow.
 */

const props = defineProps<{
  visible: boolean
  draft: SortState
  fields: SortField[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'update:draft', v: SortState): void
  (e: 'apply'): void
  (e: 'reset'): void
}>()

const directionOptions = [
  { label: 'Aufsteigend', value: 'asc' },
  { label: 'Absteigend', value: 'desc' },
]

function updateField(value: string) {
  emit('update:draft', { ...props.draft, field: value })
}
function updateDirection(value: 'asc' | 'desc') {
  emit('update:draft', { ...props.draft, direction: value })
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Sortierung"
    :style="{ width: 'min(100%, 420px)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="sort-menu">
      <div class="sort-row">
        <label class="sort-label">Feld</label>
        <Select
          :model-value="draft.field"
          :options="fields"
          option-label="label"
          option-value="value"
          @update:model-value="updateField"
        />
      </div>
      <div class="sort-row">
        <label class="sort-label">Richtung</label>
        <SelectButton
          :model-value="draft.direction"
          :options="directionOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          @update:model-value="updateDirection"
        />
      </div>
    </div>
    <template #footer>
      <Button label="Zurücksetzen" text severity="secondary" @click="emit('reset')" />
      <Button label="Abbrechen" text @click="emit('update:visible', false)" />
      <Button label="Anwenden" icon="pi pi-check" @click="emit('apply')" />
    </template>
  </Dialog>
</template>

<style scoped>
.sort-menu { display: flex; flex-direction: column; gap: 1rem; }
.sort-row { display: flex; flex-direction: column; gap: 0.4rem; }
.sort-label { font-weight: 600; font-size: 0.9rem; }
</style>
