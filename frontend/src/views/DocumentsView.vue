<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Chip from 'primevue/chip'
import MultiSelectDialog from '../components/MultiSelectDialog.vue'
import DocumentBatchVisibilityDialog from '../components/DocumentBatchVisibilityDialog.vue'
import DocumentBatchReprocessDialog from '../components/DocumentBatchReprocessDialog.vue'
import DocumentUploadDefaultsDialog from '../components/DocumentUploadDefaultsDialog.vue'
import DocumentFilterMenu from '../components/DocumentFilterMenu.vue'
import DocumentScanQueuePanel from '../components/DocumentScanQueuePanel.vue'
import SortMenu from '../components/SortMenu.vue'
import VirtualDocumentList from '../components/VirtualDocumentList.vue'
import VirtualDocumentGrid from '../components/VirtualDocumentGrid.vue'
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
import { useDocumentFilter } from '../composables/useDocumentFilter'

let lastOpenedDocId: number | null = null

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const { restore: restoreScroll } = useScrollRestore('documents-list')
const scrollElement = ref<Window | null>(null)

const items = ref<DocumentSummary[]>([])
const categories = ref<DocumentCategory[]>([])
const subjectPeople = ref<SubjectPerson[]>([])
const groups = ref<GroupSummary[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

type ViewMode = 'list' | 'grid'
const VIEW_MODE_KEY = 'documents.viewMode'
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'list')
watch(viewMode, (v) => localStorage.setItem(VIEW_MODE_KEY, v))

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

function triggerSearch() {
  syncQueryParams()
  void load()
}

function handleSearchKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') triggerSearch()
}

function clearSearch() {
  q.value = ''
  triggerSearch()
}

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
  void load()
}
function resetSortMenu() {
  sort.reset()
  sortMenuVisible.value = false
  void load()
}

const filter = useDocumentFilter({ preserveKeys: ['q', 'sortBy', 'sortDir'] })
syncQueryParams()

const filterMenuVisible = ref(false)
function openFilterMenu() {
  filter.openEdit()
  filterMenuVisible.value = true
}
function applyFilterMenu() {
  filter.apply()
  filterMenuVisible.value = false
  void load()
}
function resetFilterMenu() {
  filter.reset()
  filterMenuVisible.value = false
  void load()
}

const selectedIds = ref<Set<number>>(new Set())
const tagsDialogVisible = ref(false)
const visibilityDialogVisible = ref(false)
const reprocessDialogVisible = ref(false)
const defaultsDialogVisible = ref(false)
const savingBatchTags = ref(false)

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
  for (const d of items.value) for (const t of d.tags) seen.add(t)
  for (const t of sessionAddedTags.value) seen.add(t)
  return [...seen].sort((a, b) => a.localeCompare(b))
})
const tagDialogItems = computed(() => allKnownTags.value.map((t) => ({ id: t, label: t })))
const selectedDocs = computed(() => items.value.filter((d) => selectedIds.value.has(d.id)))
const tagInitialStates = computed<Map<string, boolean | null>>(() => {
  const docs = selectedDocs.value
  const out = new Map<string, boolean | null>()
  for (const tag of allKnownTags.value) {
    if (docs.length === 0) {
      out.set(tag, false)
      continue
    }
    let count = 0
    for (const d of docs) if (d.tags.includes(tag)) count++
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
  if (!sessionAddedTags.value.includes(trimmed)) sessionAddedTags.value = [...sessionAddedTags.value, trimmed]
}

function handleBatchVisibilityDone(payload: { affected: number; skipped: number }) {
  info.value = payload.skipped > 0
    ? `Sichtbarkeit für ${payload.affected} Dokument(e) geändert. ${payload.skipped} übersprungen (keine Berechtigung).`
    : `Sichtbarkeit für ${payload.affected} Dokument(e) geändert.`
  void load()
}

function handleBatchReprocessDone(payload: { affected: number }) {
  info.value = `OCR & KI für ${payload.affected} Dokument(e) neu gestartet.`
  clearSelection()
  void load()
}

const LOW_CONFIDENCE_THRESHOLD = 0.6
function isLowConfidence(doc: DocumentSummary): boolean {
  return doc.status === 'ready'
    && doc.classification_confidence != null
    && doc.classification_confidence < LOW_CONFIDENCE_THRESHOLD
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'encrypted': return 'warn'
    case 'pending': return 'secondary'
    case 'extracting':
    case 'classifying': return 'info'
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

function syncQueryParams() {
  const query: Record<string, string> = {}
  if (q.value.trim()) query.q = q.value.trim()
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
  router.replace({ query })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const isSearch = q.value.trim().length > 0
    if (isSearch) {
      const res = await searchDocuments(q.value.trim(), searchMode.value, 100)
      items.value = res.items
    } else {
      const f = filter.applied.value
      const s = sort.applied.value
      const res = await listDocuments({
        category: f.category,
        tags: f.tags?.join(','),
        status: f.status as DocumentStatus | undefined,
        needs_review: f.needs_review,
        sender: f.sender,
        date_from: f.dateFrom,
        date_to: f.dateTo,
        tax_relevant: f.taxRelevant,
        subject_person_id: f.subjectPersonId,
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
  try { categories.value = (await listDocumentCategories()).items }
  catch (err: any) { console.warn('[documents] failed to load categories:', err) }
}
async function loadSubjectPeople() {
  try { subjectPeople.value = (await listSubjectPersons()).items }
  catch (err: any) { console.warn('[documents] failed to load subject persons:', err) }
}
async function loadGroups() {
  try { groups.value = (await listGroups()).items }
  catch (err: any) { console.warn('[documents] failed to load groups:', err) }
}

function openDocument(doc: DocumentSummary) {
  lastOpenedDocId = doc.id
  router.push({ name: 'dokumente-detail', params: { id: doc.id } })
}

async function restoreScrollToLastOpened() {
  const id = lastOpenedDocId
  lastOpenedDocId = null
  if (id == null) return
  await nextTick()
  await nextTick()
  const el = document.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  el.classList.add('document-card--highlight')
  setTimeout(() => el.classList.remove('document-card--highlight'), 1500)
}

useRealtimeEvent('documents', 'status.changed', (ev) => {
  const id = Number(ev.resourceId)
  if (!Number.isFinite(id)) return
  const doc = items.value.find((d) => d.id === id)
  if (!doc) return
  const payload = ev.payload as { status?: DocumentStatus; confidence?: number }
  if (!payload.status) return
  doc.status = payload.status
  if (typeof payload.confidence === 'number') doc.classification_confidence = payload.confidence
  if (payload.status === 'ready' || payload.status === 'failed') void load()
})

watch(() => filter.applied.value, () => { void load() })

onMounted(async () => {
  scrollElement.value = window
  await Promise.all([loadCategories(), loadGroups(), loadSubjectPeople(), load()])
  if (lastOpenedDocId != null) await restoreScrollToLastOpened()
  else restoreScroll()
})
</script>

<template>
  <div class="documents-view">
    <div class="header">
      <h1 class="title">Dokumente</h1>
      <div class="header-actions">
        <Button icon="pi pi-question-circle" text rounded aria-label="Hilfe zum Dokumente-Modul" v-tooltip.bottom="'Hilfe: Dokument-Flow und Aktionen'" @click="router.push({ name: 'dokumente-hilfe' })" />
        <Button v-if="auth.hasPermission('documents.upload')" icon="pi pi-cog" text rounded aria-label="Standardeinstellungen für neue Dokumente" v-tooltip.bottom="'Standard-Gruppe für neue Dokumente'" @click="defaultsDialogVisible = true" />
        <Button v-if="auth.hasPermission('documents.upload')" label="Hochladen" icon="pi pi-upload" @click="router.push({ name: 'dokumente-upload' })" />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>
    <DocumentScanQueuePanel />

    <div v-if="selectedIds.size > 0" class="batch-bar">
      <span class="batch-count"><i class="pi pi-check-square" /> {{ selectedIds.size }} ausgewählt</span>
      <div class="batch-actions">
        <Button v-if="auth.hasPermission('documents.edit')" label="Tags…" icon="pi pi-tag" size="small" @click="tagsDialogVisible = true" />
        <Button v-if="auth.hasPermission('documents.edit')" label="Sichtbarkeit…" icon="pi pi-users" size="small" @click="visibilityDialogVisible = true" />
        <Button v-if="auth.hasPermission('documents.edit')" label="OCR & KI neu…" icon="pi pi-refresh" size="small" severity="secondary" v-tooltip.bottom="'Text-Extraktion (OCR) und KI-Analyse für die Auswahl erneut starten'" @click="reprocessDialogVisible = true" />
        <Button label="Auswahl aufheben" icon="pi pi-times" size="small" severity="secondary" text @click="clearSelection" />
      </div>
    </div>

    <div class="toolbar">
      <div class="search-row">
        <span class="p-input-icon-left search-wrapper">
          <i class="pi pi-search" />
          <InputText v-model="q" placeholder="Suche in Dokumenten…" class="search-input" @keydown="handleSearchKeydown" />
        </span>
        <Button icon="pi pi-search" aria-label="Suche starten" :disabled="q.trim().length === 0" @click="triggerSearch" />
        <Button v-if="q.trim().length > 0" icon="pi pi-times" text rounded severity="secondary" aria-label="Suche löschen" @click="clearSearch" />
      </div>
      <div class="toolbar-controls">
        <SelectButton v-if="q.trim().length > 0" v-model="searchMode" :options="searchModeOptions" optionLabel="label" optionValue="value" :allowEmpty="false" class="search-mode-btn" v-tooltip.bottom="'Suchmodus'" @update:model-value="triggerSearch" />
        <Button :icon="filter.activeCount.value > 0 ? 'pi pi-filter-fill' : 'pi pi-filter'" text rounded aria-label="Filter" v-tooltip.bottom="filter.activeCount.value > 0 ? `${filter.activeCount.value} Filter aktiv` : 'Filter'" :badge="filter.activeCount.value > 0 ? String(filter.activeCount.value) : undefined" badge-severity="info" @click="openFilterMenu" />
        <Button icon="pi pi-sort-amount-down" text rounded aria-label="Sortierung" v-tooltip.bottom="sort.isDefault.value ? 'Sortierung' : `Sortiert: ${sort.fieldLabel.value}`" :severity="sort.isDefault.value ? 'secondary' : undefined" @click="openSortMenu" />
        <div class="view-toggle">
          <Button icon="pi pi-list" :text="viewMode !== 'list'" :outlined="viewMode === 'list'" size="small" :severity="viewMode === 'list' ? undefined : 'secondary'" aria-label="Listenansicht" v-tooltip.bottom="'Liste'" @click="viewMode = 'list'" />
          <Button icon="pi pi-th-large" :text="viewMode !== 'grid'" :outlined="viewMode === 'grid'" size="small" :severity="viewMode === 'grid' ? undefined : 'secondary'" aria-label="Kachelansicht" v-tooltip.bottom="'Kacheln'" @click="viewMode = 'grid'" />
        </div>
      </div>
    </div>

    <div v-if="filter.activeCount.value > 0" class="filter-chips">
      <Chip v-if="filter.applied.value.category" :label="`Kategorie: ${filter.applied.value.category}`" removable @remove="filter.removeKey(['category'])" />
      <Chip v-if="filter.applied.value.status" :label="`Status: ${filter.applied.value.status}`" removable @remove="filter.removeKey(['status'])" />
      <Chip v-for="tag in (filter.applied.value.tags ?? [])" :key="'tag-' + tag" :label="`Tag: ${tag}`" removable @remove="filter.removeTag(tag)" />
      <Chip v-if="filter.applied.value.sender" :label="`Absender: ${filter.applied.value.sender}`" removable @remove="filter.removeKey(['sender'])" />
      <Chip v-if="filter.applied.value.dateFrom || filter.applied.value.dateTo" :label="`Datum: ${filter.applied.value.dateFrom ?? '…'} – ${filter.applied.value.dateTo ?? '…'}`" removable @remove="filter.removeKey(['dateFrom', 'dateTo'])" />
      <Chip v-if="filter.applied.value.taxRelevant !== undefined" :label="`Steuerrelevant: ${filter.applied.value.taxRelevant ? 'Ja' : 'Nein'}`" removable @remove="filter.removeKey(['taxRelevant'])" />
      <Chip v-if="filter.applied.value.needs_review" label="Nur zu prüfen" removable @remove="filter.removeKey(['needs_review'])" />
      <Button label="Alle Filter löschen" text size="small" severity="secondary" @click="() => { filter.reset(); load() }" />
    </div>

    <div v-if="loading" class="info-text"><i class="pi pi-spin pi-spinner" /> Dokumente werden geladen…</div>
    <div v-else-if="items.length === 0" class="info-text">
      <template v-if="q.trim().length > 0">Keine Treffer für „{{ q }}".</template>
      <template v-else>Noch keine Dokumente vorhanden.</template>
    </div>
    <VirtualDocumentList
      v-else-if="viewMode === 'list'"
      :items="items"
      :selected-ids="selectedIds"
      :scroll-element="scrollElement"
      :is-low-confidence="isLowConfidence"
      :status-severity="statusSeverity"
      :status-label="statusLabel"
      :format-date="formatDate"
      :format-size="formatSize"
      @open="openDocument"
      @toggle-selected="toggleSelected"
    />
    <VirtualDocumentGrid
      v-else
      :items="items"
      :selected-ids="selectedIds"
      :scroll-element="scrollElement"
      :status-severity="statusSeverity"
      :status-label="statusLabel"
      :format-date="formatDate"
      @open="openDocument"
      @toggle-selected="toggleSelected"
    />

    <MultiSelectDialog v-model:visible="tagsDialogVisible" title="Tags auf Auswahl anwenden" :items="tagDialogItems" :initial-states="tagInitialStates" :subject-count="selectedIds.size" :subject-label="selectedIds.size === 1 ? 'Dokument' : 'Dokumente'" :saving="savingBatchTags" allow-create create-label="Neuen Tag eintragen" create-placeholder="Tagname…" empty-message="Keine bekannten Tags. Lege einen neuen an." @save="handleBatchTagsSave" @create="handleBatchTagsCreate" />
    <DocumentBatchVisibilityDialog v-model:visible="visibilityDialogVisible" :documents="selectedDocs" :groups="groups" @done="handleBatchVisibilityDone" />
    <DocumentBatchReprocessDialog v-model:visible="reprocessDialogVisible" :document-ids="[...selectedIds]" @done="handleBatchReprocessDone" />
    <DocumentUploadDefaultsDialog v-model:visible="defaultsDialogVisible" :groups="groups" @saved="info = 'Standard für neue Dokumente gespeichert.'" />
    <DocumentFilterMenu v-model:visible="filterMenuVisible" v-model:draft="filter.draft.value" :categories="categories" :known-tags="allKnownTags" :subject-people="subjectPeople" @apply="applyFilterMenu" @reset="resetFilterMenu" />
    <SortMenu v-model:visible="sortMenuVisible" v-model:draft="sort.draft.value" :fields="sortFields" @apply="applySortMenu" @reset="resetSortMenu" />
  </div>
</template>

<style scoped>
.documents-view { display: flex; flex-direction: column; gap: .75rem; width: 100%; padding-inline: .5em; }
@media (min-width: 800px) { .documents-view { padding-inline: 1em; } }
.title { font-size: 1.5em; font-weight: 600; margin-block: .25em; }
.header { display: flex; justify-content: space-between; align-items: center; margin-block: .25rem 0; }
.header-actions { display: flex; align-items: center; gap: .25rem; }
.toolbar { display: flex; flex-direction: column; gap: .5rem; position: sticky; top: var(--menubar-height, 3.5rem); z-index: 900; background: var(--p-content-background); margin-inline: -.5em; padding: .4rem .5em; border-bottom: 1px solid var(--p-content-border-color); }
@media (min-width: 800px) { .toolbar { margin-inline: -1em; padding-inline: 1em; } }
.search-row { display: flex; gap: .4rem; align-items: center; }
.search-wrapper { flex: 1; min-width: 180px; position: relative; }
.search-wrapper i { position: absolute; left: .75rem; top: 50%; transform: translateY(-50%); color: var(--p-text-muted-color); pointer-events: none; }
.search-input { width: 100%; padding-left: 2rem; }
.toolbar-controls { display: flex; align-items: center; gap: .25rem; flex-wrap: wrap; }
.search-mode-btn { flex-shrink: 0; }
.view-toggle { display: inline-flex; margin-left: auto; gap: 0; }
.filter-chips { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
.batch-bar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: .6rem .9rem; border: 1px solid var(--p-primary-color); border-radius: 8px; background: color-mix(in srgb, var(--p-primary-color) 8%, transparent); }
.batch-count { display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; }
.batch-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-left: auto; }
.info-text { text-align: center; margin-top: 4rem; color: var(--p-text-muted-color); }
</style>
