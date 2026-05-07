<script setup lang="ts">
/**
 * Drop-in replacement for AutoComplete in tag fields.
 * Behaviour:
 *  - Shows matching existing tags as suggestions.
 *  - When the query doesn't match any existing tag exactly, appends a
 *    "Neu: <query>" item at the top of the list.
 *  - Selecting the "Neu:" item creates the tag on the fly (adds it to
 *    the modelValue array without a separate API call – the calling
 *    component persists it when saving or via batchTag).
 */

import { ref, computed } from 'vue'
import AutoComplete from 'primevue/autocomplete'
import { useTagsStore } from '../../stores/finance/tags'

interface SuggestionItem {
  label: string
  value: string
  isNew: boolean
}

const props = defineProps<{
  modelValue: string[]
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string[]): void
}>()

const tagsStore = useTagsStore()
const suggestions = ref<SuggestionItem[]>([])

function search(event: { query: string }) {
  const q = event.query.trim()
  const ql = q.toLowerCase()

  const existing = tagsStore.items
    .filter((t) => t.name.toLowerCase().includes(ql))
    .map((t) => ({ label: t.name, value: t.name, isNew: false }))

  const exactMatch = tagsStore.items.some((t) => t.name.toLowerCase() === ql)
  const alreadySelected = props.modelValue.some((v) => v.toLowerCase() === ql)

  if (q.length > 0 && !exactMatch && !alreadySelected) {
    suggestions.value = [
      { label: `+ Neu: "${q}"`, value: q, isNew: true },
      ...existing,
    ]
  } else {
    suggestions.value = existing
  }
}

// AutoComplete passes the full SuggestionItem when multiple + object
// mode, but we store only strings. Normalise on every change.
function onUpdate(raw: Array<string | SuggestionItem>) {
  const names = raw.map((item) =>
    typeof item === 'string' ? item : item.value,
  )
  emit('update:modelValue', names)
}

// The model value is string[] but AutoComplete with optionLabel needs
// objects when displaying chips. We wrap them so the chip label is
// readable.
const displayValue = computed<SuggestionItem[]>(() =>
  props.modelValue.map((v) => ({ label: v, value: v, isNew: false })),
)
</script>

<template>
  <AutoComplete
    class="tag-ac"
    :model-value="displayValue"
    :suggestions="suggestions"
    option-label="label"
    :placeholder="placeholder"
    :disabled="disabled"
    multiple
    force-selection
    @complete="search"
    @update:model-value="onUpdate"
  >
    <template #option="{ option }">
      <span :class="option.isNew ? 'tag-ac-new' : ''">{{ option.label }}</span>
    </template>
    <template #chip="{ value }">
      <span>{{ value.label }}</span>
    </template>
  </AutoComplete>
</template>

<style scoped>
.tag-ac-new {
  font-style: italic;
  color: var(--p-primary-color);
  font-weight: 600;
}

/* Make selected tags clearly look like badges/pills */
.tag-ac :deep(.p-autocomplete-multiple-container) {
  gap: 0.375rem;
  flex-wrap: wrap;
}
.tag-ac :deep(.p-autocomplete-token) {
  background: var(--p-highlight-background);
  border: 1px solid var(--p-content-border-color);
  color: var(--p-highlight-color);
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
}
.tag-ac :deep(.p-autocomplete-token-label) {
  margin-right: 0.25rem;
}
.tag-ac :deep(.p-autocomplete-token-icon) {
  color: var(--p-highlight-color);
}
</style>
