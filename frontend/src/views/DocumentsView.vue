<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import MultiSelectDialog from '../components/MultiSelectDialog.vue'
import DocumentBatchVisibilityDialog from '../components/DocumentBatchVisibilityDialog.vue'
import DocumentUploadDefaultsDialog from '../components/DocumentUploadDefaultsDialog.vue'
import {
  listDocuments,
  listDocumentCategories,
  listGroups,
  searchDocuments,
  batchUpdateDocumentTags,
  type DocumentSummary,
  type DocumentCategory,
  type DocumentStatus,
  type GroupSummary,
  type SearchMode,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'

const router = useRouter()
const auth = useAuthStore()

const items = ref<DocumentSummary[]>([])
const categories = ref<DocumentCategory[]>([])
const groups = ref<GroupSummary[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

const selectedIds = ref<Set<number>>(new Set())
const tagsDialogVisible = ref(false)
const visibilityDialogVisible = ref(false)
const defaultsDialogVisible = ref(false)
const savingBatchTags = ref(false)

function isSelected(id: number) {
  return selectedIds.value.has(id)
}

function toggleSelected(id: number, checked: boolean) {
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
}

const sessionAddedTags = ref<string[]>([])

const allKnownTags = computed(() => {
  const seen = new Set<string>()
  for (const d of items.value) {
    for (const t of d.tags) seen.add(t)
  }
  for (const t of sessionAddedTags.value) seen.add(t)
  return [...seen].sort((a, b) => a.localeCompare(b))
})

const tagDialogItems = computed(() =>
  allKnownTags.value.map((t) => ({ id: t, label: t })),
)

const selectedDocs = computed(() =>
  items.value.filter((d) => selectedIds.value.has(d.id)),
)

/**
 * Tristate per known tag, materialised as a Map. Re-evaluated
 * whenever the selection or the document list changes.
 */
const tagInitialStates = computed<Map<string, boolean | null>>(() => {
  const docs = selectedDocs.value
  const out = new Map<string, boolean | null>()
  for (const tag of allKnownTags.value) {
    if (docs.length === 0) {
      out.set(tag, false)
      continue
    }
    let count = 0
    for (const d of docs) {
      if (d.tags.includes(tag)) count++
    }
    if (count === 0) out.set(tag, false)
    else if (count === docs.length) out.set(tag, true)
    else out.set(tag, null)
  }
  return out
})

async function handleBatchTagsSave(payload: { adds: string[]; removes: string[] }) {
  if (selectedIds.value.size === 0) return
  savingBatchTags.value = true
  error.value = ''
  info.value = ''
  try {
    const res = await batchUpdateDocumentTags({
      document_ids: [...selectedIds.value],
      add: payload.adds,
      remove: payload.removes,
    })
    info.value = `Tags angewendet auf ${res.affected_documents} Dokument(e).`
    tagsDialogVisible.value = false
    await load()
  } catch (err: any) {
    error.value = err?.message || 'Tags konnten nicht aktualisiert werden.'
  } finally {
    savingBatchTags.value = false
  }
}

function handleBatchTagsCreate(name: string) {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed) return
  if (!sessionAddedTags.value.includes(trimmed)) {
    sessionAddedTags.value = [...sessionAddedTags.value, trimmed]
  }
}

function handleBatchVisibilityDone(payload: { affected: number; skipped: number }) {
  if (payload.skipped > 0) {
    info.value = `Sichtbarkeit für ${payload.affected} Dokument(e) geändert. ${payload.skipped} übersprungen (keine Berechtigung).`
  } else {
    info.value = `Sichtbarkeit für ${payload.affected} Dokument(e) geändert.`
  }
  load()
}

const SEARCH_MODE_STORAGE_KEY = 'documents.searchMode'
function loadStoredSearchMode(): SearchMode {
  const raw = localStorage.getItem(SEARCH_MODE_STORAGE_KEY)
  return raw === 'fts' || raw === 'semantic' || raw === 'hybrid' ? raw : 'hybrid'
}

const q = ref('')
const selectedCategory = ref<string | null>(null)
const selectedStatus = ref<DocumentStatus | null>(null)
const needsReviewOnly = ref(false)
const searchMode = ref<SearchMode>(loadStoredSearchMode())

const LOW_CONFIDENCE_THRESHOLD = 0.6
function isLowConfidence(doc: DocumentSummary): boolean {
  return (
    doc.status === 'ready' &&
    doc.classification_confidence != null &&
    doc.classification_confidence < LOW_CONFIDENCE_THRESHOLD
  )
}
watch(searchMode, (v) => localStorage.setItem(SEARCH_MODE_STORAGE_KEY, v))

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
        needs_review: needsReviewOnly.value || undefined,
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
watch([q, selectedCategory, selectedStatus, needsReviewOnly, searchMode], () => {
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

// Live-update the status badge when the backend pipeline progresses.
// For intermediate states (extracting, classifying) we only patch the
// status so the tag re-renders. When a document reaches a terminal
// state (ready / failed) the classifier has filled in category, title,
// sender, tags, etc. — fields the payload does not carry — so we
// reload the list to reflect them without a manual refresh.
useRealtimeEvent('documents', 'status.changed', (ev) => {
  const id = Number(ev.resourceId)
  if (!Number.isFinite(id)) return
  const doc = items.value.find((d) => d.id === id)
  if (!doc) return
  const payload = ev.payload as { status?: DocumentStatus; confidence?: number }
  if (!payload.status) return
  doc.status = payload.status
  if (typeof payload.confidence === 'number') {
    doc.classification_confidence = payload.confidence
  }
  if (payload.status === 'ready' || payload.status === 'failed') {
    load()
  }
})

async function loadGroups() {
  try {
    const res = await listGroups()
    groups.value = res.items
  } catch (err: any) {
    // Non-fatal — batch UI shows "no groups available" if this fails.
    console.warn('[documents] failed to load groups:', err)
  }
}

onMounted(async () => {
  await Promise.all([loadCategories(), loadGroups(), load()])
})
</script>

<template>
  <div class="documents-view">
    <div class="header">
      <h1 class="title">Dokumente</h1>
      <div class="header-actions">
        <Button
          icon="pi pi-question-circle"
          text
          rounded
          aria-label="Hilfe zum Dokumente-Modul"
          v-tooltip.bottom="'Hilfe: Dokument-Flow und Aktionen'"
          @click="router.push({ name: 'dokumente-hilfe' })"
        />
        <Button
          v-if="auth.hasPermission('documents.upload')"
          icon="pi pi-cog"
          text
          rounded
          aria-label="Standardeinstellungen für neue Dokumente"
          v-tooltip.bottom="'Standard-Gruppe für neue Dokumente'"
          @click="defaultsDialogVisible = true"
        />
        <Button
          v-if="auth.hasPermission('documents.upload')"
          label="Hochladen"
          icon="pi pi-upload"
          @click="router.push({ name: 'dokumente-upload' })"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <div v-if="selectedIds.size > 0" class="batch-bar">
      <span class="batch-count">
        <i class="pi pi-check-square" />
        {{ selectedIds.size }} ausgewählt
      </span>
      <div class="batch-actions">
        <Button
          v-if="auth.hasPermission('documents.edit')"
          label="Tags…"
          icon="pi pi-tag"
          size="small"
          @click="tagsDialogVisible = true"
        />
        <Button
          v-if="auth.hasPermission('documents.edit')"
          label="Sichtbarkeit…"
          icon="pi pi-users"
          size="small"
          @click="visibilityDialogVisible = true"
        />
        <Button
          label="Auswahl aufheben"
          icon="pi pi-times"
          size="small"
          severity="secondary"
          text
          @click="clearSelection"
        />
      </div>
    </div>

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

      <label
        class="needs-review-toggle"
        v-tooltip.bottom="'Zeigt nur Dokumente, die geprüft werden sollten: fehlgeschlagen oder mit niedriger KI-Konfidenz.'"
      >
        <Checkbox
          v-model="needsReviewOnly"
          :binary="true"
          :disabled="q.trim().length > 0"
        />
        <span>Nur zu prüfen</span>
      </label>
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
        :class="{ 'document-card--selected': isSelected(doc.id) }"
        tabindex="0"
        @click="openDocument(doc)"
        @keydown.enter="openDocument(doc)"
      >
        <div class="document-checkbox" @click.stop>
          <Checkbox
            :modelValue="isSelected(doc.id)"
            :binary="true"
            :inputId="`doc-sel-${doc.id}`"
            :aria-label="`Dokument ${doc.title || doc.original_filename} auswählen`"
            @update:modelValue="(val: boolean) => toggleSelected(doc.id, val)"
          />
        </div>
        <div class="document-icon"><i class="pi pi-file-pdf" /></div>
        <div class="document-body">
          <div class="document-title-row">
            <span class="document-title">{{ doc.title || doc.original_filename }}</span>
            <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
            <Tag
              v-if="isLowConfidence(doc)"
              severity="warn"
              icon="pi pi-exclamation-triangle"
              :value="`Prüfen · ${Math.round((doc.classification_confidence ?? 0) * 100)}%`"
              v-tooltip.bottom="'Niedrige KI-Konfidenz — Kategorie und Felder bitte prüfen.'"
            />
          </div>
          <div class="document-meta">
            <span v-if="doc.category_slug" class="document-category">
              <i class="pi pi-folder" /> {{ doc.category_slug }}
            </span>
            <span v-if="doc.sender"><i class="pi pi-user" /> {{ doc.sender }}</span>
            <span v-if="doc.doc_date"><i class="pi pi-calendar" /> {{ formatDate(doc.doc_date) }}</span>
            <span class="document-size"><i class="pi pi-database" /> {{ formatSize(doc.size_bytes) }}</span>
          </div>
          <div v-if="doc.status === 'failed' && doc.last_error" class="document-error">
            <i class="pi pi-times-circle" /> {{ doc.last_error }}
          </div>
          <div v-if="doc.tags.length > 0" class="document-tags">
            <Chip v-for="tag in doc.tags" :key="tag" :label="tag" />
          </div>
        </div>
      </div>
    </div>

    <MultiSelectDialog
      v-model:visible="tagsDialogVisible"
      title="Tags auf Auswahl anwenden"
      :items="tagDialogItems"
      :initial-states="tagInitialStates"
      :subject-count="selectedIds.size"
      :subject-label="selectedIds.size === 1 ? 'Dokument' : 'Dokumente'"
      :saving="savingBatchTags"
      allow-create
      create-label="Neuen Tag eintragen"
      create-placeholder="Tagname…"
      empty-message="Keine bekannten Tags. Lege einen neuen an."
      @save="handleBatchTagsSave"
      @create="handleBatchTagsCreate"
    />

    <DocumentBatchVisibilityDialog
      v-model:visible="visibilityDialogVisible"
      :documents="selectedDocs"
      :groups="groups"
      @done="handleBatchVisibilityDone"
    />

    <DocumentUploadDefaultsDialog
      v-model:visible="defaultsDialogVisible"
      :groups="groups"
      @saved="info = 'Standard für neue Dokumente gespeichert.'"
    />
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
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

.needs-review-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  user-select: none;
}
.needs-review-toggle span { font-size: 0.9rem; }

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
  align-items: flex-start;
}
.document-card:hover,
.document-card:focus-visible {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
.document-card--selected {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-surface-card));
}

.document-checkbox {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding-top: 0.4rem;
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.6rem 0.9rem;
  border: 1px solid var(--p-primary-color);
  border-radius: 8px;
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}

.batch-count {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}

.batch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-left: auto;
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

.document-error {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--p-red-600, #c0392b);
  background: var(--p-red-50, #fdecea);
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  word-break: break-word;
}

.document-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
</style>
