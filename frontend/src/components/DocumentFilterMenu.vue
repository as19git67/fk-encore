<script setup lang="ts">
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import ToggleSwitch from 'primevue/toggleswitch'
import DateRangePresets from './DateRangePresets.vue'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import type { DocumentFilter } from '../composables/useDocumentFilter'
import type { DocumentCategory } from '../api/documents'

const props = defineProps<{
  visible: boolean
  draft: DocumentFilter
  categories: DocumentCategory[]
  knownTags: string[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'update:draft', v: DocumentFilter): void
  (e: 'apply'): void
  (e: 'reset'): void
}>()

const local = ref<DocumentFilter>({ ...props.draft })

watch(local, (v) => emit('update:draft', v), { deep: true })

watch(() => props.visible, (v) => {
  if (!v) return
  local.value = { ...props.draft }
  dateFrom.value = props.draft.dateFrom ? parseLocalDate(props.draft.dateFrom) : null
  dateTo.value = props.draft.dateTo ? parseLocalDate(props.draft.dateTo) : null
})

const dateFrom = ref<Date | null>(props.draft.dateFrom ? parseLocalDate(props.draft.dateFrom) : null)
const dateTo = ref<Date | null>(props.draft.dateTo ? parseLocalDate(props.draft.dateTo) : null)

watch([dateFrom, dateTo], ([from, to]) => {
  local.value = {
    ...local.value,
    dateFrom: from ? toLocalIsoDate(from) : undefined,
    dateTo: to ? toLocalIsoDate(to) : undefined,
  }
})

const categoryOptions = [
  { label: 'Alle Kategorien', value: '' },
  ...props.categories.map((c) => ({
    label: (c.parent_id == null ? '' : '— ') + c.name,
    value: c.slug,
  })),
]

const statusOptions: Array<{ label: string; value: string }> = [
  { label: 'Alle', value: '' },
  { label: 'Fertig', value: 'ready' },
  { label: 'In Arbeit', value: 'classifying' },
  { label: 'Fehler', value: 'failed' },
  { label: 'Warteschlange', value: 'pending' },
  { label: 'Text-Extraktion', value: 'extracting' },
]

const tagOptions = [
  { label: 'Alle Tags', value: '' },
  ...props.knownTags.map((t) => ({ label: t, value: t })),
]

const taxOptions = [
  { label: 'Egal', value: '' },
  { label: 'Ja', value: 'true' },
  { label: 'Nein', value: 'false' },
]

function handleApply() {
  emit('apply')
  emit('update:visible', false)
}

function handleReset() {
  local.value = {}
  dateFrom.value = null
  dateTo.value = null
  emit('reset')
}
</script>

<template>
  <Dialog
    :visible="props.visible"
    @update:visible="(v: boolean) => emit('update:visible', v)"
    header="Filter"
    modal
    :style="{ width: 'min(100%, 560px)' }"
  >
    <div class="filter-menu">
      <div class="filter-row">
        <label class="filter-label">Kategorie</label>
        <Select
          :model-value="local.category ?? ''"
          :options="categoryOptions"
          option-label="label"
          option-value="value"
          @update:model-value="(v: string) => local = { ...local, category: v || undefined }"
        />
      </div>

      <div class="filter-row">
        <label class="filter-label">Status</label>
        <Select
          :model-value="local.status ?? ''"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          @update:model-value="(v: string) => local = { ...local, status: v || undefined }"
        />
      </div>

      <div class="filter-row">
        <label class="filter-label">Tag</label>
        <Select
          :model-value="local.tag ?? ''"
          :options="tagOptions"
          option-label="label"
          option-value="value"
          @update:model-value="(v: string) => local = { ...local, tag: v || undefined }"
        />
      </div>

      <div class="filter-row">
        <label class="filter-label">Absender</label>
        <InputText
          :model-value="local.sender ?? ''"
          placeholder="Absender filtern…"
          @update:model-value="(v: string | undefined) => local = { ...local, sender: v || undefined }"
        />
      </div>

      <div class="filter-row">
        <label class="filter-label">Dokumentdatum</label>
        <DateRangePresets v-model:from="dateFrom" v-model:to="dateTo" />
      </div>

      <div class="filter-row">
        <label class="filter-label">Steuerrelevant</label>
        <Select
          :model-value="local.taxRelevant === undefined ? '' : String(local.taxRelevant)"
          :options="taxOptions"
          option-label="label"
          option-value="value"
          @update:model-value="(v: string) => local = { ...local, taxRelevant: v === '' ? undefined : v === 'true' }"
        />
      </div>

      <div class="filter-switch">
        <ToggleSwitch
          :model-value="local.needs_review ?? false"
          @update:model-value="(v: boolean) => local = { ...local, needs_review: v || undefined }"
        />
        <span>Nur zu prüfen</span>
      </div>
    </div>

    <template #footer>
      <Button label="Zurücksetzen" text severity="secondary" @click="handleReset" />
      <Button label="Abbrechen" text @click="emit('update:visible', false)" />
      <Button label="Anwenden" icon="pi pi-check" @click="handleApply" />
    </template>
  </Dialog>
</template>

<style scoped>
.filter-menu { display: flex; flex-direction: column; gap: 1.25rem; }
.filter-row { display: flex; flex-direction: column; gap: 0.5rem; }
.filter-label { font-weight: 500; font-size: 0.9rem; color: var(--p-text-muted-color); }
.filter-switch { display: flex; align-items: center; gap: 0.6rem; }
</style>
