<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import {
  listDocuments,
  listDocumentCategories,
  searchDocuments,
  type DocumentSummary,
  type DocumentCategory,
  type DocumentStatus,
  type SearchMode,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const items = ref<DocumentSummary[]>([])
const categories = ref<DocumentCategory[]>([])
const loading = ref(true)
const error = ref('')

const q = ref('')
const selectedCategory = ref<string | null>(null)
const selectedStatus = ref<DocumentStatus | null>(null)
const searchMode = ref<SearchMode>('hybrid')

const searchModeOptions = [
  { label: 'Hybrid', value: 'hybrid' },
  { label: 'Text', value: 'fts' },
  { label: 'Bedeutung', value: 'semantic' },
]

const statusOptions: Array<{ label: string; value: DocumentStatus | null }> = [
  { label: 'Alle', value: null },
  { label: 'Fertig', value: 'ready' },
  { label: 'In Arbeit', value: 'classifying' },
  { label: 'Fehler', value: 'failed' },
]

const categoryOptions = computed(() => {
  const opts: Array<{ label: string; value: string | null }> = [{ label: 'Alle Kategorien', value: null }]
  for (const c of categories.value) {
    const prefix = c.parent_id == null ? '' : '— '
    opts.push({ label: `${prefix}${c.name}`, value: c.slug })
  }
  return opts
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    if (q.value.trim().length > 0) {
      const res = await searchDocuments(q.value.trim(), searchMode.value, 50)
      items.value = res.items
    } else {
      const res = await listDocuments({
        category: selectedCategory.value ?? undefined,
        status: selectedStatus.value ?? undefined,
        limit: 100,
      })
      items.value = res.items
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Dokumente'
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  try {
    const res = await listDocumentCategories()
    categories.value = res.items
  } catch (err: any) {
    // Non-fatal: list still loads without the filter.
    console.warn('[documents] failed to load categories:', err)
  }
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null
watch([q, selectedCategory, selectedStatus, searchMode], () => {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(load, 300)
})

function openDocument(doc: DocumentSummary) {
  router.push({ name: 'dokumente-detail', params: { id: doc.id } })
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'pending': return 'secondary'
    case 'extracting':
    case 'classifying':
      return 'info'
    default: return 'secondary'
  }
}

function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'ready': return 'Fertig'
    case 'failed': return 'Fehler'
    case 'pending': return 'Warteschlange'
    case 'extracting': return 'Text-Extraktion'
    case 'classifying': return 'KI-Analyse'
    default: return status
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onMounted(async () => {
  await Promise.all([loadCategories(), load()])
})
</script>

<template>
  <div class="documents-view">
    <div class="header">
      <h1 class="title">Dokumente</h1>
      <Button
        v-if="auth.hasPermission('documents.upload')"
        label="Hochladen"
        icon="pi pi-upload"
        @click="router.push({ name: 'dokumente-upload' })"
      />
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div class="filters">
      <span class="p-input-icon-left search-wrapper">
        <i class="pi pi-search" />
        <InputText
          v-model="q"
          placeholder="Suche in Dokumenten…"
          class="search-input"
        />
      </span>

      <SelectButton
        v-model="searchMode"
        :options="searchModeOptions"
        optionLabel="label"
        optionValue="value"
        :allowEmpty="false"
        :disabled="q.trim().length === 0"
        v-tooltip.bottom="'Suchmodus: Text = genaue Wörter, Bedeutung = Paraphrasen, Hybrid = beides kombiniert'"
      />

      <Select
        v-model="selectedCategory"
        :options="categoryOptions"
        optionLabel="label"
        optionValue="value"
        placeholder="Kategorie"
        class="filter-select"
        :disabled="q.trim().length > 0"
      />

      <Select
        v-model="selectedStatus"
        :options="statusOptions"
        optionLabel="label"
        optionValue="value"
        placeholder="Status"
        class="filter-select"
        :disabled="q.trim().length > 0"
      />
    </div>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Dokumente werden geladen…
    </div>
    <div v-else-if="items.length === 0" class="info-text">
      <template v-if="q.trim().length > 0">Keine Treffer für „{{ q }}".</template>
      <template v-else>Noch keine Dokumente vorhanden.</template>
    </div>

    <div v-else class="document-list">
      <div
        v-for="doc in items"
        :key="doc.id"
        class="document-card"
        tabindex="0"
        @click="openDocument(doc)"
        @keydown.enter="openDocument(doc)"
      >
        <div class="document-icon"><i class="pi pi-file-pdf" /></div>
        <div class="document-body">
          <div class="document-title-row">
            <span class="document-title">{{ doc.title || doc.original_filename }}</span>
            <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
          </div>
          <div class="document-meta">
            <span v-if="doc.category_slug" class="document-category">
              <i class="pi pi-folder" /> {{ doc.category_slug }}
            </span>
            <span v-if="doc.sender"><i class="pi pi-user" /> {{ doc.sender }}</span>
            <span v-if="doc.doc_date"><i class="pi pi-calendar" /> {{ formatDate(doc.doc_date) }}</span>
            <span class="document-size"><i class="pi pi-database" /> {{ formatSize(doc.size_bytes) }}</span>
          </div>
          <div v-if="doc.tags.length > 0" class="document-tags">
            <Chip v-for="tag in doc.tags" :key="tag" :label="tag" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.documents-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  padding-inline: 0.5em;
}

@media (min-width: 800px) {
  .documents-view { padding-inline: 1em; }
}

.title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem 0.5rem;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.search-wrapper {
  flex: 1;
  min-width: 220px;
  position: relative;
}
.search-wrapper i {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--p-text-muted-color);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding-left: 2rem;
}

.filter-select { min-width: 180px; }

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

.document-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.document-card {
  display: flex;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}
.document-card:hover,
.document-card:focus-visible {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.document-icon {
  font-size: 2rem;
  color: var(--p-primary-color);
  flex-shrink: 0;
}

.document-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.document-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.document-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.document-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.document-meta span { display: inline-flex; align-items: center; gap: 0.25rem; }

.document-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
</style>
