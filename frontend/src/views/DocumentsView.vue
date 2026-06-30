<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import MultiSelectDialog from '../components/MultiSelectDialog.vue'
import DocumentBatchVisibilityDialog from '../components/DocumentBatchVisibilityDialog.vue'
import DocumentBatchReprocessDialog from '../components/DocumentBatchReprocessDialog.vue'
import DocumentUploadDefaultsDialog from '../components/DocumentUploadDefaultsDialog.vue'
import DocumentFilterMenu from '../components/DocumentFilterMenu.vue'
import DocumentScanQueuePanel from '../components/DocumentScanQueuePanel.vue'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import SortMenu from '../components/SortMenu.vue'
import {
  listDocuments,
  listDocumentCategories,
  listGroups,
  listSubjectPersons,
  searchDocuments,
  batchUpdateDocumentTags,
  type DocumentSummary,
  type DocumentCategory,
  type DocumentStatus,
  type GroupSummary,
  type SearchMode,
  type SubjectPerson,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useScrollRestore } from '../composables/useScrollRestore'
import { useSort, type SortField } from '../composables/useSort'
import { DOCUMENT_FILTER_QUERY_KEYS, useDocumentFilter } from '../composables/useDocumentFilter'
import { replaceQuerySlice, updateRouteQuery } from '../utils/routeQueryUpdate'
import {
  consumeDocumentListFocus,
  focusDocumentListItem,
  rememberDocumentListFocus,
} from '../utils/documentListFocus'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const { restore: restoreScroll } = useScrollRestore('documents-list')

const items = ref<DocumentSummary[]>([])
const categories = ref<DocumentCategory[]>([])
const subjectPeople = ref<SubjectPerson[]>([])
const groups = ref<GroupSummary[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

// ─── View mode ──────────────────────────────────────────────────────────────
type ViewMode = 'list' | 'grid'
const VIEW_MODE_KEY = 'documents.viewMode'
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'list')
watch(viewMode, (v) => localStorage.setItem(VIEW_MODE_KEY, v))

// ─── Search ─────────────────────────────────────────────────────────────────
const SEARCH_MODE_STORAGE_KEY = 'documents.searchMode'
function loadStoredSearchMode(): SearchMode {
  const raw = localStorage.getItem(SEARCH_MODE_STORAGE_KEY)
  return raw === 'fts' || raw === 'semantic' || raw === 'hybrid' ? raw : 'hybrid'
}

const q = ref(typeof route.query.q === 'string' ? route.query.q : '')
const searchMode = ref<SearchMode>(loadStoredSearchMode())
watch(searchMode, (v) => localStorage.setItem(SEARCH_MODE_STORAGE_KEY, v))

const searchModeOptions = [
  { label: 'Hybrid', value: 'hybrid' },
  { label: 'Text', value: 'fts' },
  { label: 'Bedeutung', value: 'semantic' },
]

async function triggerSearch() {
  await syncQueryParams()
  load()
}

function handleSearchKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') triggerSearch()
}

function clearSearch() {
  q.value = ''
  triggerSearch()
}

// ─── Sort ───────────────────────────────────────────────────────────────────
const sortFields: SortField[] = [
  { value: 'uploaded_at', label: 'Hochgeladen' },
  { value: 'doc_date', label: 'Dokumentdatum' },
  { value: 'title', label: 'Titel' },
  { value: 'sender', label: 'Absender' },
  { value: 'size_bytes', label: 'Dateigröße' },
]

const sort = useSort({
  fields: sortFields,
  defaultState: { field: 'uploaded_at', direction: 'desc' },
  storageKey: 'documents.sort',
})
const sortMenuVisible = ref(false)

function openSortMenu() {
  sort.openEdit()
  sortMenuVisible.value = true
}
function applySortMenu() {
  sort.apply()
  sortMenuVisible.value = false
  load()
}
function resetSortMenu() {
  sort.reset()
  sortMenuVisible.value = false
  load()
}

// ─── Filter ─────────────────────────────────────────────────────────────────
const filter = useDocumentFilter()

// `useSort` and `useDocumentFilter` each restore from localStorage and write
// their slice of the URL on mount. Written separately they race: the filter's
// write lands last and drops `?sortBy/?sortDir`, after which the sort watcher
// resets to the default — so returning from another view (e.g. Kategorie-
// Vorschläge) lost the sorting while the filter survived. Writing the *combined*
// query once here makes it the final navigation, so both are preserved. (#651)
syncQueryParams()

const filterMenuVisible = ref(false)

function openFilterMenu() {
  filter.openEdit()
  filterMenuVisible.value = true
}
function applyFilterMenu() {
  filter.apply()
  filterMenuVisible.value = false
  load()
}
function resetFilterMenu() {
  filter.reset()
  filterMenuVisible.value = false
  load()
}

// ─── Selection & batch ─────────────────────────────────────────────────────
const selectedIds = ref<Set<number>>(new Set())
const tagsDialogVisible = ref(false)
const visibilityDialogVisible = ref(false)
const reprocessDialogVisible = ref(false)
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

function handleBatchReprocessDone(payload: { affected: number }) {
  info.value = `OCR & KI für ${payload.affected} Dokument(e) neu gestartet.`
  clearSelection()
  load()
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const LOW_CONFIDENCE_THRESHOLD = 0.6
function isLowConfidence(doc: DocumentSummary): boolean {
  return (
    doc.status === 'ready' &&
    doc.classification_confidence != null &&
    doc.classification_confidence < LOW_CONFIDENCE_THRESHOLD
  )
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'encrypted': return 'warn'
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
    case 'encrypted': return 'Passwortgeschützt'
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

// ─── Data loading ───────────────────────────────────────────────────────────

function syncQueryParams() {
  const query: Record<string, string> = {}
  if (q.value.trim()) query.q = q.value.trim()
  // Merge filter and sort into query
  const fq = filter.applied.value
  if (fq.category) query.category = fq.category
  if (fq.tags && fq.tags.length > 0) query.tags = fq.tags.join(',')
  if (fq.status) query.status = fq.status
  if (fq.needs_review) query.review = '1'
  if (fq.sender) query.sender = fq.sender
  if (fq.dateFrom) query.dateFrom = fq.dateFrom
  if (fq.dateTo) query.dateTo = fq.dateTo
  if (fq.taxRelevant !== undefined) query.taxRelevant = String(fq.taxRelevant)
  if (fq.subjectPersonId) query.subjectPerson = String(fq.subjectPersonId)
  const s = sort.applied.value
  if (s.field !== 'uploaded_at' || s.direction !== 'desc') {
    query.sortBy = s.field
    query.sortDir = s.direction
  }
  return updateRouteQuery(router, (current) =>
    replaceQuerySlice(
      current,
      ['q', 'sortBy', 'sortDir', ...DOCUMENT_FILTER_QUERY_KEYS],
      query,
    ),
  )
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const f = filter.applied.value
    // Single source for the filter params so search and list stay in sync —
    // searching used to drop every filter here. (#vxd1qh)
    const filterParams = {
      category: f.category,
      tags: f.tags?.join(','),
      status: f.status as DocumentStatus | undefined,
      needs_review: f.needs_review,
      sender: f.sender,
      date_from: f.dateFrom,
      date_to: f.dateTo,
      tax_relevant: f.taxRelevant,
      subject_person_id: f.subjectPersonId,
    }
    const isSearch = q.value.trim().length > 0
    if (isSearch) {
      const res = await searchDocuments(q.value.trim(), searchMode.value, 100, filterParams)
      items.value = res.items
    } else {
      const s = sort.applied.value
      const res = await listDocuments({
        ...filterParams,
        sort_by: s.field,
        sort_dir: s.direction,
        limit: 200,
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
    console.warn('[documents] failed to load categories:', err)
  }
}

async function loadSubjectPeople() {
  try {
    const res = await listSubjectPersons()
    subjectPeople.value = res.items
  } catch (err: any) {
    console.warn('[documents] failed to load subject persons:', err)
  }
}

function openDocument(doc: DocumentSummary) {
  rememberDocumentListFocus(doc.id)
  router.push({ name: 'dokumente-detail', params: { id: doc.id } })
}

async function restoreFocusToLastOpened(): Promise<boolean> {
  const id = consumeDocumentListFocus()
  if (id == null) return false
  await nextTick()
  await nextTick()
  const el = focusDocumentListItem(document, id)
  if (!el) return false
  el.classList.add('document-card--highlight')
  setTimeout(() => el.classList.remove('document-card--highlight'), 1500)
  return true
}

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
    console.warn('[documents] failed to load groups:', err)
  }
}

// ─── Filter change watcher (when URL changes externally) ────────────────────
watch(
  () => filter.applied.value,
  () => load(),
)

onMounted(async () => {
  await Promise.all([loadCategories(), loadGroups(), loadSubjectPeople(), load()])
  // Returning from detail: center, highlight and restore actual keyboard
  // focus. Only use the generic scroll offset when there is no item anchor.
  if (!(await restoreFocusToLastOpened())) restoreScroll()
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

    <!-- Scan queue status panel -->
    <DocumentScanQueuePanel />

    <!-- Batch actions bar -->
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
          v-if="auth.hasPermission('documents.edit')"
          label="OCR & KI neu…"
          icon="pi pi-refresh"
          size="small"
          severity="secondary"
          v-tooltip.bottom="'Text-Extraktion (OCR) und KI-Analyse für die Auswahl erneut starten'"
          @click="reprocessDialogVisible = true"
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

    <!-- Toolbar: search + filter/sort/view controls -->
    <div class="toolbar">
      <div class="search-row">
        <span class="p-input-icon-left search-wrapper">
          <i class="pi pi-search" />
          <InputText
            v-model="q"
            placeholder="Suche in Dokumenten…"
            class="search-input"
            @keydown="handleSearchKeydown"
          />
        </span>
        <Button
          icon="pi pi-search"
          aria-label="Suche starten"
          :disabled="q.trim().length === 0"
          @click="triggerSearch"
        />
        <Button
          v-if="q.trim().length > 0"
          icon="pi pi-times"
          text
          rounded
          severity="secondary"
          aria-label="Suche löschen"
          @click="clearSearch"
        />
      </div>

      <div class="toolbar-controls">
        <SelectButton
          v-if="q.trim().length > 0"
          v-model="searchMode"
          :options="searchModeOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
          class="search-mode-btn"
          v-tooltip.bottom="'Suchmodus'"
          @update:model-value="triggerSearch"
        />

        <Button
          :icon="filter.activeCount.value > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'"
          text
          rounded
          aria-label="Filter"
          v-tooltip.bottom="filter.activeCount.value > 0 ? `${filter.activeCount.value} Filter aktiv` : 'Filter'"
          :badge="filter.activeCount.value > 0 ? String(filter.activeCount.value) : undefined"
          badge-severity="info"
          :severity="filter.activeCount.value > 0 ? undefined : 'secondary'"
          @click="openFilterMenu"
        />

        <Button
          :icon="sort.isDefault.value ? 'pi pi-sort-amount-down' : 'pi pi-sort-amount-down'"
          text
          rounded
          aria-label="Sortierung"
          v-tooltip.bottom="sort.isDefault.value ? 'Sortierung' : `Sortiert: ${sort.fieldLabel.value}`"
          :severity="sort.isDefault.value ? 'secondary' : undefined"
          @click="openSortMenu"
        />

        <div class="view-toggle">
          <Button
            icon="pi pi-list"
            :text="viewMode !== 'list'"
            :outlined="viewMode === 'list'"
            size="small"
            :severity="viewMode === 'list' ? undefined : 'secondary'"
            aria-label="Listenansicht"
            v-tooltip.bottom="'Liste'"
            @click="viewMode = 'list'"
          />
          <Button
            icon="pi pi-th-large"
            :text="viewMode !== 'grid'"
            :outlined="viewMode === 'grid'"
            size="small"
            :severity="viewMode === 'grid' ? undefined : 'secondary'"
            aria-label="Kachelansicht"
            v-tooltip.bottom="'Kacheln'"
            @click="viewMode = 'grid'"
          />
        </div>
      </div>
    </div>

    <!-- Active filter chips -->
    <div v-if="filter.activeCount.value > 0" class="filter-chips">
      <Chip
        v-if="filter.applied.value.category"
        :label="`Kategorie: ${filter.applied.value.category}`"
        removable
        @remove="filter.removeKey(['category'])"
      />
      <Chip
        v-if="filter.applied.value.status"
        :label="`Status: ${filter.applied.value.status}`"
        removable
        @remove="filter.removeKey(['status'])"
      />
      <Chip
        v-for="tag in (filter.applied.value.tags ?? [])"
        :key="'tag-' + tag"
        :label="`Tag: ${tag}`"
        removable
        @remove="filter.removeTag(tag)"
      />
      <Chip
        v-if="filter.applied.value.sender"
        :label="`Absender: ${filter.applied.value.sender}`"
        removable
        @remove="filter.removeKey(['sender'])"
      />
      <Chip
        v-if="filter.applied.value.dateFrom || filter.applied.value.dateTo"
        :label="`Datum: ${filter.applied.value.dateFrom ?? '…'} – ${filter.applied.value.dateTo ?? '…'}`"
        removable
        @remove="filter.removeKey(['dateFrom', 'dateTo'])"
      />
      <Chip
        v-if="filter.applied.value.taxRelevant !== undefined"
        :label="`Steuerrelevant: ${filter.applied.value.taxRelevant ? 'Ja' : 'Nein'}`"
        removable
        @remove="filter.removeKey(['taxRelevant'])"
      />
      <Chip
        v-if="filter.applied.value.needs_review"
        label="Nur zu prüfen"
        removable
        @remove="filter.removeKey(['needs_review'])"
      />
      <Button
        label="Alle Filter löschen"
        text
        size="small"
        severity="secondary"
        @click="() => { filter.reset(); load() }"
      />
    </div>

    <!-- Loading / empty state -->
    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Dokumente werden geladen…
    </div>
    <div v-else-if="items.length === 0" class="info-text">
      <template v-if="q.trim().length > 0">Keine Treffer für „{{ q }}".</template>
      <template v-else>Noch keine Dokumente vorhanden.</template>
    </div>

    <!-- List view -->
    <div v-else-if="viewMode === 'list'" class="document-list">
      <div
        v-for="doc in items"
        :key="doc.id"
        :data-doc-id="doc.id"
        class="document-card"
        :class="{ 'document-card--selected': isSelected(doc.id) }"
      >
        <div class="document-header">
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
          <button
            type="button"
            class="document-title"
            v-tooltip.bottom="'Dokument öffnen'"
            @click="openDocument(doc)"
          >
            {{ doc.title || doc.original_filename }}
          </button>
          <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
          <Tag
            v-if="isLowConfidence(doc)"
            severity="warn"
            icon="pi pi-exclamation-triangle"
            :value="`Prüfen · ${Math.round((doc.classification_confidence ?? 0) * 100)}%`"
            v-tooltip.bottom="'Niedrige KI-Konfidenz — Kategorie und Felder bitte prüfen.'"
          />
        </div>
        <div class="document-details">
          <div class="document-meta">
            <span v-if="doc.category_slug" class="document-category">
              <i class="pi pi-folder" /> {{ doc.category_slug }}
            </span>
            <span v-if="doc.sender"><i class="pi pi-user" /> {{ doc.sender }}</span>
            <span v-if="doc.doc_date"><i class="pi pi-calendar" /> {{ formatDate(doc.doc_date) }}</span>
            <span class="document-size"><i class="pi pi-database" /> {{ formatSize(doc.size_bytes) }}</span>
            <span v-if="doc.tax_relevant" class="tax-badge"><i class="pi pi-calculator" /> Steuer</span>
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

    <!-- Grid / card view -->
    <div v-else class="document-grid">
      <div
        v-for="doc in items"
        :key="doc.id"
        :data-doc-id="doc.id"
        class="grid-card"
        :class="{ 'grid-card--selected': isSelected(doc.id) }"
        tabindex="0"
        @click="openDocument(doc)"
        @keydown.enter="openDocument(doc)"
      >
        <div class="grid-card-checkbox" @click.stop>
          <Checkbox
            :modelValue="isSelected(doc.id)"
            :binary="true"
            :aria-label="`Dokument ${doc.title || doc.original_filename} auswählen`"
            @update:modelValue="(val: boolean) => toggleSelected(doc.id, val)"
          />
        </div>
        <div class="grid-card-thumb">
          <DocumentThumbnail :id="doc.id" :alt="doc.title || doc.original_filename" />
        </div>
        <Tag
          class="grid-card-status"
          :severity="statusSeverity(doc.status)"
          :value="statusLabel(doc.status)"
        />
        <div class="grid-card-title">{{ doc.title || doc.original_filename }}</div>
        <div class="grid-card-meta">
          <span v-if="doc.sender">{{ doc.sender }}</span>
          <span v-if="doc.doc_date">{{ formatDate(doc.doc_date) }}</span>
        </div>
        <div v-if="doc.category_slug" class="grid-card-category">
          <i class="pi pi-folder" /> {{ doc.category_slug }}
        </div>
        <div v-if="doc.tags.length > 0" class="grid-card-tags">
          <Chip v-for="tag in doc.tags.slice(0, 3)" :key="tag" :label="tag" />
          <span v-if="doc.tags.length > 3" class="more-tags">+{{ doc.tags.length - 3 }}</span>
        </div>
      </div>
    </div>

    <!-- Dialogs -->
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

    <DocumentBatchReprocessDialog
      v-model:visible="reprocessDialogVisible"
      :document-ids="[...selectedIds]"
      @done="handleBatchReprocessDone"
    />

    <DocumentUploadDefaultsDialog
      v-model:visible="defaultsDialogVisible"
      :groups="groups"
      @saved="info = 'Standard für neue Dokumente gespeichert.'"
    />

    <DocumentFilterMenu
      v-model:visible="filterMenuVisible"
      v-model:draft="filter.draft.value"
      :categories="categories"
      :known-tags="allKnownTags"
      :subject-people="subjectPeople"
      @apply="applyFilterMenu"
      @reset="resetFilterMenu"
    />

    <SortMenu
      v-model:visible="sortMenuVisible"
      v-model:draft="sort.draft.value"
      :fields="sortFields"
      @apply="applySortMenu"
      @reset="resetSortMenu"
    />
  </div>
</template>

<style scoped>
.documents-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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
  margin-block: 0.25rem 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

/* ── Toolbar ────────────────────────────────────────────────────── */
/* Sticks below the app navbar so the search/filter/sort controls stay
   reachable while the list scrolls. The negative inline margin + matching
   padding bleed the background across the container's inline padding so list
   rows scroll cleanly underneath. (#651) */
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  position: sticky;
  top: var(--menubar-height, 3.5rem);
  z-index: 900;
  background: var(--p-content-background);
  margin-inline: -0.5em;
  padding: 0.4rem 0.5em;
  border-bottom: 1px solid var(--p-content-border-color);
}

@media (min-width: 800px) {
  .toolbar {
    margin-inline: -1em;
    padding-inline: 1em;
  }
}

.search-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.search-wrapper {
  flex: 1;
  min-width: 180px;
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

.toolbar-controls {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.search-mode-btn { flex-shrink: 0; }

.view-toggle {
  display: inline-flex;
  margin-left: auto;
  gap: 0;
}

/* ── Filter chips ──────────────────────────────────────────────── */
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}

/* ── Batch bar ─────────────────────────────────────────────────── */
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

/* ── Loading / empty ───────────────────────────────────────────── */
.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

/* ── List view ─────────────────────────────────────────────────── */
.document-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.document-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  transition: box-shadow 0.1s;
}
.document-card:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}
.document-card--selected {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background));
}
.document-card--highlight {
  animation: card-flash 1.5s ease-out;
}
@keyframes card-flash {
  0%   { box-shadow: 0 0 0 3px var(--p-primary-color); }
  100% { box-shadow: none; }
}

.document-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.document-checkbox {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.document-icon {
  font-size: 2rem;
  line-height: 1;
  color: var(--p-primary-color);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.document-details {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.document-title {
  appearance: none;
  background: none;
  border: none;
  margin: 0;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.document-title:hover,
.document-title:focus-visible {
  text-decoration: underline;
  color: var(--p-primary-color);
}

.document-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.document-meta span { display: inline-flex; align-items: center; gap: 0.25rem; }

.tax-badge { color: var(--p-primary-color); font-weight: 500; }

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

/* ── Grid / card view ──────────────────────────────────────────── */
.document-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.75rem;
}

.grid-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.1s;
  position: relative;
}
.grid-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}
.grid-card:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
.grid-card--selected {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background));
}

.grid-card-checkbox {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
}

.grid-card-thumb {
  margin-bottom: 0.1rem;
}

.grid-card-status {
  align-self: flex-start;
}

.grid-card-title {
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-card-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.grid-card-category {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.grid-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
  margin-top: auto;
}
.grid-card-tags :deep(.p-chip) { font-size: 0.75rem; }
.more-tags {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  align-self: center;
}

/* ── Mobile adjustments ────────────────────────────────────────── */
@media (max-width: 600px) {
  .document-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.5rem;
  }
  .toolbar-controls {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
