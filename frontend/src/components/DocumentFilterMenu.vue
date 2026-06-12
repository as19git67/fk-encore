<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import AutoComplete from 'primevue/autocomplete'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import ToggleSwitch from 'primevue/toggleswitch'
import DateRangePresets from './DateRangePresets.vue'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import type { DocumentFilter } from '../composables/useDocumentFilter'
import type { DocumentCategory } from '../api/documents'

interface CatOption { label: string; slug: string }

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
  syncCategorySelection()
  syncTagSelection()
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

// ── Category AutoComplete ──────────────────────────────────────────────────

const allCatOptions = computed<CatOption[]>(() =>
  props.categories.map((c) => ({
    label: (c.parent_id == null ? '' : '— ') + c.name,
    slug: c.slug,
  })),
)

const categorySuggestions = ref<CatOption[]>([])
const selectedCategory = ref<CatOption | null>(null)

function syncCategorySelection() {
  const slug = local.value.category
  selectedCategory.value = slug
    ? allCatOptions.value.find((o) => o.slug === slug) ?? null
    : null
}
syncCategorySelection()

function searchCategories(event: { query: string }) {
  const q = event.query.toLowerCase()
  categorySuggestions.value = q
    ? allCatOptions.value.filter((o) => o.label.toLowerCase().includes(q))
    : allCatOptions.value
}

watch(selectedCategory, (v) => {
  const slug = v && typeof v === 'object' ? v.slug : undefined
  if (slug !== (local.value.category ?? undefined)) {
    local.value = { ...local.value, category: slug || undefined }
  }
})

// ── Tag AutoComplete ───────────────────────────────────────────────────────

const tagSuggestions = ref<string[]>([])
const selectedTag = ref<string | null>(null)

function syncTagSelection() {
  selectedTag.value = local.value.tag ?? null
}
syncTagSelection()

function searchTags(event: { query: string }) {
  const q = event.query.toLowerCase()
  tagSuggestions.value = q
    ? props.knownTags.filter((t) => t.toLowerCase().includes(q))
    : [...props.knownTags]
}

watch(selectedTag, (v) => {
  const tag = v && typeof v === 'string' ? v : undefined
  if (tag !== (local.value.tag ?? undefined)) {
    local.value = { ...local.value, tag: tag || undefined }
  }
})

// ── Static option lists ────────────────────────────────────────────────────

const statusOptions: Array<{ label: string; value: string }> = [
  { label: 'Alle', value: '' },
  { label: 'Fertig', value: 'ready' },
  { label: 'In Arbeit', value: 'classifying' },
  { label: 'Fehler', value: 'failed' },
  { label: 'Warteschlange', value: 'pending' },
  { label: 'Text-Extraktion', value: 'extracting' },
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
  selectedCategory.value = null
  selectedTag.value = null
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
        <AutoComplete
          v-model="selectedCategory"
          :suggestions="categorySuggestions"
          option-label="label"
          :input-style="{ width: '100%' }"
          placeholder="Kategorie suchen…"
          dropdown
          @complete="searchCategories"
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
        <AutoComplete
          v-model="selectedTag"
          :suggestions="tagSuggestions"
          :input-style="{ width: '100%' }"
          placeholder="Tag suchen…"
          dropdown
          @complete="searchTags"
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
