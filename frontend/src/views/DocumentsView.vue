<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import DocumentUploadDefaultsDialog from '../components/DocumentUploadDefaultsDialog.vue'
import DocumentFilterMenu from '../components/DocumentFilterMenu.vue'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import DocumentScanQueuePanel from '../components/DocumentScanQueuePanel.vue'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import AddToCollectionDialog from '../components/documents/AddToCollectionDialog.vue'
import { listCollections, type DocumentCollection } from '../api/collections'
import {
  listDocuments,
  listDocumentCategories,
  listDocumentTypesCatalog,
  listCorrespondents,
  listGroups,
  listSubjectPersons,
  searchDocuments,
  type CorrespondentFacet,
  type DocumentSummary,
  type DocumentCategory,
  type DocumentTypeCatalogEntry,
  type DocumentStatus,
  type GroupSummary,
  type SearchMode,
  type SubjectPerson,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useDocSelectionStore } from '../stores/documents/selection'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useSplitView } from '../composables/useSplitView'
import { resolveActiveId, stepActiveId } from '../utils/activeListItem'
import DocumentPreviewPane from '../components/documents/DocumentPreviewPane.vue'
import { useSort, type SortField } from '../composables/useSort'
import {
  collectionQueryParams,
  effectiveCollectionScope,
  useDocumentFilter,
  useDocumentFilterChips,
} from '../composables/useDocumentFilter'
import SelectionBar from '../components/layout/SelectionBar.vue'
import { useListSearch, useListToolbar, useListView } from '../composables/useListToolbar'
import { useListSelection } from '../composables/useListSelection'
import type { ToolbarItem } from '../components/ResponsiveToolbar.vue'
import { waitForPendingQueryUpdate } from '../utils/routeQueryUpdate'
import { anchorKey, focusListAnchor, saveListAnchor } from '../utils/listAnchor'
import type { ListAnchor } from '../utils/listAnchor'

const router = useRouter()
const auth = useAuthStore()
/**
 * The list scrolls inside its own column (the preview pane sits beside it),
 * so the page's offset has to be read from that element. `PageLayout` saves
 * and restores it; the view only points at it.
 */
const listColumn = ref<HTMLElement | null>(null)
/** The list's own key for the anchor and the offset — one per list, not per filter. */
const ANCHOR_KEY = 'dokumente'

const items = ref<DocumentSummary[]>([])
const categories = ref<DocumentCategory[]>([])
const documentTypes = ref<DocumentTypeCatalogEntry[]>([])
const subjectPeople = ref<SubjectPerson[]>([])
const correspondents = ref<CorrespondentFacet[]>([])

function correspondentLabel(slug: string): string {
  return correspondents.value.find((c) => c.slug === slug)?.display ?? slug
}
const groups = ref<GroupSummary[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

// ─── View mode ──────────────────────────────────────────────────────────────
type ViewMode = 'list' | 'grid'
const view = useListView({
  options: [
    { value: 'list', label: 'Liste', icon: 'pi pi-list' },
    { value: 'grid', label: 'Kacheln', icon: 'pi pi-th-large' },
  ],
  defaultValue: 'list',
  storageKey: 'documents.viewMode',
})
const viewMode = computed<ViewMode>(() => view.value.value as ViewMode)

// ─── Search ─────────────────────────────────────────────────────────────────
const SEARCH_MODE_STORAGE_KEY = 'documents.searchMode'
function loadStoredSearchMode(): SearchMode {
  const raw = localStorage.getItem(SEARCH_MODE_STORAGE_KEY)
  return raw === 'fts' || raw === 'semantic' || raw === 'hybrid' ? raw : 'hybrid'
}

const search = useListSearch({
  placeholder: 'Suche in Dokumenten…',
  storageKey: 'documents.search',
})
/** The settled search term; the list and the search endpoint both read this. */
const q = search.term
const searchMode = ref<SearchMode>(loadStoredSearchMode())
watch(searchMode, (v) => localStorage.setItem(SEARCH_MODE_STORAGE_KEY, v))

const searchModeOptions = [
  { label: 'Hybrid', value: 'hybrid' },
  { label: 'Text', value: 'fts' },
  { label: 'Bedeutung', value: 'semantic' },
]

// The term settles 300 ms after the last keystroke (and on back/forward);
// that is the moment to ask the backend again.
watch(q, () => load())

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
// The shared toolbar applies a sort immediately, so the list follows the
// applied state rather than a menu's "Anwenden".
watch(() => [sort.applied.value.field, sort.applied.value.direction].join(':'), () => load())

// ─── Filter ─────────────────────────────────────────────────────────────────
const filter = useDocumentFilter()

// Search, filter, sort and view each own their slice of the URL and write it
// through `updateRouteQuery`, which serialises the navigations — so the
// mount-time restores can no longer overwrite one another the way they did
// before the combined writer existed (#651).

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

// ─── Selection & basket (issue #736) ────────────────────────────────────────
// The list selection is purely a staging step: checkboxes collect documents,
// "In den Basket" hands them to the basket, and every batch edit
// (Tags/Kategorie/Sichtbarkeit/OCR/…) lives in the basket drawer. The list
// itself no longer edits documents.
//
// Since issue #1272 (stage 5) the picking is the app's shared one and, like
// every other list, it happens in a mode: permanently visible checkboxes made
// this the only list where every row carried selection furniture whether or
// not anyone was selecting.
const selection = useListSelection({
  loadedIds: () => items.value.map((d) => d.id),
  // Only what is loaded can be selected — "Mehr laden" first, then select.
  total: () => items.value.length,
})
const { selectMode, selectedIds } = selection
const defaultsDialogVisible = ref(false)

function isSelected(id: number) {
  return selectedIds.value.has(id)
}

function toggleSelected(id: number, checked: boolean) {
  selection.toggleId(id, checked)
}

function clearSelection() {
  selection.clear()
}

/**
 * Sammelmappen shown as their own rows above the documents.
 *
 * They are an additional layer, never a replacement: a document in a folder
 * still appears below as itself, because a folder is a bundle for handing over
 * rather than a filing location, and the same document may sit in several.
 *
 * The rows step aside while a document-facet filter (Kategorie, Absender,
 * Steuer, Dokumentart, …) is active. A folder has none of those properties, so
 * "matches if any member matches" would put a mostly unrelated folder at the
 * top of a filtered view; the notice below the list says so rather than
 * leaving the omission to be guessed.
 */
const collections = ref<DocumentCollection[]>([])

/**
 * Facets that describe a document and therefore cannot describe a folder.
 *
 * The Sammelmappen scope is deliberately not among them: it is a statement
 * *about* folders, and in its default setting the folder rows are what stands
 * in for the documents it leaves out — hiding both would leave a hole.
 */
function hasDocumentFacetFilter(): boolean {
  const f = filter.applied.value
  return Boolean(
    f.category || (f.tags && f.tags.length > 0) || f.status || f.needs_review ||
    f.unreviewed || f.sender || f.correspondent || f.dateFrom || f.dateTo ||
    f.taxRelevant !== undefined || f.subjectPersonId || f.categorySource ||
    f.documentType,
  )
}

const collectionFacetActive = computed(() => hasDocumentFacetFilter())

/**
 * The folder rows to show. When one folder is singled out, only that folder's
 * row appears — it is the heading of what the list below is showing, and the
 * other folders are not part of the question that was asked.
 */
const visibleCollections = computed(() => {
  if (collectionFacetActive.value) return []
  const pinned = filter.applied.value.collectionId
  if (pinned) return collections.value.filter((c) => c.id === pinned)
  return collections.value
})

/**
 * True while the default is leaving bundled documents out and there is
 * something to leave out. Drives the notice above the list: the omission has
 * to be visible and undoable in one click, or it is indistinguishable from
 * documents having gone missing.
 */
const bundledHidden = computed(
  () =>
    effectiveCollectionScope(filter.applied.value) === 'without' &&
    !filter.applied.value.collectionId &&
    collections.value.some((c) => c.item_count > 0),
)

/** "Auch anzeigen" from the notice — the flat list, without opening the menu. */
function showBundledDocuments() {
  filter.draft.value = { ...filter.applied.value, collectionScope: 'with', collectionId: undefined }
  filter.apply()
}

async function loadCollections() {
  try {
    collections.value = (await listCollections(q.value.trim() || undefined)).items
  } catch {
    // The folder rows are an addition to the list, not a precondition for it:
    // a failure here must not blank out the documents.
    collections.value = []
  }
}

async function openCollection(id: number) {
  // Same two steps as openDocument: remember the row so the way back lands on
  // it, and let a still-pending filter/sort URL write settle first — a write
  // that resolves after this push would overwrite the history entry the back
  // arrow returns to, dropping the filter and the position with it.
  saveListAnchor(ANCHOR_KEY, { kind: 'collection', id })
  await waitForPendingQueryUpdate(router)
  router.push({ name: 'dokumente-mappe', params: { id } })
}

/** Jump from a chip straight into the folder-members view of the list. */
function filterByCollection(id: number) {
  filter.draft.value = { ...filter.applied.value, collectionId: id, collectionScope: undefined }
  filter.apply()
}

// "In Sammelmappe" gathers the checked documents into a folder that is later
// handed over as a single PDF. Unlike the basket, membership is durable and a
// document may sit in several folders at once.
const addToCollectionOpen = ref(false)

function onAddedToCollection(payload: { title: string; count: number }) {
  info.value = `${payload.count} Dokument${payload.count === 1 ? '' : 'e'} zu „${payload.title}" hinzugefügt.`
  clearSelection()
}

// Known tags feed the filter panel's tag picker.
const allKnownTags = computed(() => {
  const seen = new Set<string>()
  for (const d of items.value) {
    for (const t of d.tags) seen.add(t)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
})

const selectedDocs = computed(() =>
  items.value.filter((d) => selectedIds.value.has(d.id)),
)

const basket = useDocSelectionStore()

/** Move the checked documents into the basket (drawer in the navbar). */
function addSelectionToBasket() {
  const docs = selectedDocs.value
  if (docs.length === 0) return
  basket.addAll(docs)
  info.value = `${docs.length} Dokument${docs.length === 1 ? '' : 'e'} in den Basket gelegt.`
  clearSelection()
}

// ─── Helpers ────────────────────────────────────────────────────────────────
/** "New" = ready, but no human has approved the AI attribution yet (#635). */
function isNew(doc: DocumentSummary): boolean {
  return doc.status === 'ready' && !doc.attributes_reviewed
}

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

/** One backend page; the API clamps `limit` to 200 per request. */
const PAGE_SIZE = 200
/** Best-N cap of the search endpoint (it has no offset paging). */
const SEARCH_LIMIT = 100

/** Total matching documents (list mode); drives "X von Y" + "Mehr laden". */
const total = ref(0)
const loadingMore = ref(false)
const isSearchActive = computed(() => q.value.trim().length > 0)

const filterChips = useDocumentFilterChips(filter, {
  documentType: documentTypeLabel,
  correspondent: correspondentLabel,
  subjectPerson: (id) => subjectPeople.value.find((p) => p.id === id)?.full_name ?? `#${id}`,
  collection: (id) => collections.value.find((c) => c.id === id)?.title ?? `#${id}`,
})

const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount: filter.activeCount,
    open: openFilterMenu,
    clearAll: () => { filter.reset(); load() },
  },
  sort,
  view,
  result: {
    loaded: () => items.value.length,
    // The search endpoint returns the best N without a total, so the count
    // says "N Treffer" there instead of "N von M".
    total: () => (isSearchActive.value ? undefined : total.value),
    loading: () => loading.value,
  },
  // Gives the toolbar its "Auswählen" toggle and the shared Esc handling.
  selection: { active: selectMode, toggle: selection.toggleMode },
})

/**
 * Batch actions on the picked documents. Everything that edits a document
 * lives in the basket, so the bar only offers the two hand-overs.
 */
const selectionActions = computed<ToolbarItem[]>(() => [
  {
    key: 'collection',
    label: 'In Sammelmappe',
    title: 'Auswahl in eine Sammelmappe legen — mehrere Dokumente als ein PDF weitergeben.',
    icon: 'pi pi-folder',
    severity: 'secondary',
    disabled: selection.selectedCount.value === 0,
    command: () => { addToCollectionOpen.value = true },
  },
])
const hasMore = computed(() => !isSearchActive.value && items.value.length < total.value)

function currentFilterParams() {
  const f = filter.applied.value
  // Single source for the filter params so search and list stay in sync —
  // searching used to drop every filter here. (#vxd1qh)
  return {
    category: f.category,
    tags: f.tags?.join(','),
    status: f.status as DocumentStatus | undefined,
    needs_review: f.needs_review,
    unreviewed: f.unreviewed,
    sender: f.sender,
    correspondent: f.correspondent,
    date_from: f.dateFrom,
    date_to: f.dateTo,
    tax_relevant: f.taxRelevant,
    subject_person_id: f.subjectPersonId,
    category_source: f.categorySource as any,
    document_type: f.documentType,
    ...collectionQueryParams(f),
  }
}

async function load() {
  loading.value = true
  error.value = ''
  void loadCollections()
  // Held so the current row can fall to whatever took its place when a reload
  // drops it — deleted, filtered away, or narrowed out by a search.
  const previousItems = items.value
  try {
    const filterParams = currentFilterParams()
    if (isSearchActive.value) {
      // Leave relevance ranking alone unless the user actively picked a
      // sort — otherwise every search would default to "Hochgeladen" and
      // lose the ranked order. An explicit choice must still apply though,
      // it used to be silently dropped in search mode (#dokumentenliste-sortierung).
      const sortOverride = sort.isDefault.value
        ? undefined
        : { sort_by: sort.applied.value.field, sort_dir: sort.applied.value.direction }
      const res = await searchDocuments(q.value.trim(), searchMode.value, SEARCH_LIMIT, filterParams, sortOverride)
      items.value = res.items
      total.value = res.items.length
    } else {
      const s = sort.applied.value
      const res = await listDocuments({
        ...filterParams,
        sort_by: s.field,
        sort_dir: s.direction,
        limit: PAGE_SIZE,
      })
      items.value = res.items
      total.value = res.total
    }
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Dokumente'
  } finally {
    loading.value = false
    syncActiveDoc(previousItems)
  }
}

/** Append the next page (list mode only — search has no offset paging). */
async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const s = sort.applied.value
    const res = await listDocuments({
      ...currentFilterParams(),
      sort_by: s.field,
      sort_dir: s.direction,
      limit: PAGE_SIZE,
      offset: items.value.length,
    })
    const known = new Set(items.value.map((d) => d.id))
    items.value = [...items.value, ...res.items.filter((d) => !known.has(d.id))]
    total.value = res.total
    // Appending never moves the current row, but the first page may have been
    // empty — then this is where it gets one.
    syncActiveDoc()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Nachladen der Dokumente'
  } finally {
    loadingMore.value = false
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

async function loadDocumentTypes() {
  try {
    const res = await listDocumentTypesCatalog()
    documentTypes.value = res.items
  } catch (err: any) {
    console.warn('[documents] failed to load document types:', err)
  }
}

/** Human label for a document-type slug (falls back to the slug). */
function documentTypeLabel(slug: string): string {
  return documentTypes.value.find((t) => t.slug === slug)?.name ?? slug
}

async function loadSubjectPeople() {
  try {
    const res = await listSubjectPersons()
    subjectPeople.value = res.items
  } catch (err: any) {
    console.warn('[documents] failed to load subject persons:', err)
  }
}

async function loadCorrespondents() {
  try {
    const res = await listCorrespondents()
    correspondents.value = res.items
  } catch (err: any) {
    console.warn('[documents] failed to load correspondents:', err)
  }
}

// ─── Split view: list left, preview right (issue #735) ──────────────────────
// Wide landscape screens read a document list by walking it, not by drilling
// into each row and coming back. The pane on the right follows one *current*
// row — a different thing from the checkbox selection above, which collects
// documents for batch actions and may hold any number of them.

const { isSplit } = useSplitView()
const activeDocId = ref<number | null>(null)

/**
 * Hold the current row steady as the list changes, and pick one when there is
 * none — the split view always has exactly one current row while the list has
 * any. Outside the split nothing is current: the pane is not rendered, and a
 * highlight without a pane is a promise the layout does not keep.
 */
function syncActiveDoc(previous: DocumentSummary[] = []) {
  if (!isSplit.value) {
    activeDocId.value = null
    return
  }
  activeDocId.value = resolveActiveId(items.value, activeDocId.value, previous)
}

watch(isSplit, () => syncActiveDoc())

/** Move the current row with the keyboard, bringing it into view. */
function moveActiveDoc(delta: number) {
  const next = stepActiveId(items.value, activeDocId.value, delta)
  if (next == null || next === activeDocId.value) return
  activeDocId.value = next
  nextTick(() => {
    document
      .querySelector<HTMLElement>(`[data-doc-id="${next}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

/**
 * ↑/↓ walk the list while the split is on. Ignored while the caret is in an
 * input and while a modifier is held, so the search field and the browser's
 * own shortcuts keep working.
 */
function onListKeydown(event: KeyboardEvent) {
  if (!isSplit.value) return
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  event.preventDefault()
  moveActiveDoc(event.key === 'ArrowDown' ? 1 : -1)
}

onMounted(() => window.addEventListener('keydown', onListKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onListKeydown))

async function openDocument(doc: DocumentSummary) {
  // In the split view the row's own click shows the document beside the list;
  // the issue asks for no drill-down there. The pane's "Öffnen" still reaches
  // the full editing view for anyone who wants it.
  if (isSplit.value) {
    activeDocId.value = doc.id
    return
  }
  saveListAnchor(ANCHOR_KEY, { kind: 'document', id: doc.id })
  // Applying a filter/sort writes the URL asynchronously (fire-and-forget,
  // see routeQueryUpdate.ts) — wait for it to land first, otherwise a
  // still-pending write can resolve after this push and silently overwrite
  // it, dropping the filter from the history entry the back arrow returns to.
  await waitForPendingQueryUpdate(router)
  router.push({ name: 'dokumente-detail', params: { id: doc.id } })
}

/**
 * Put the user back on the row they left from — a document or a Sammelmappe.
 * `PageLayout` asks once the list has loaded and scrolls and focuses whatever
 * comes back; returning null means the row is not on screen (deleted,
 * filtered away, on a page not loaded yet) and the saved offset is used.
 *
 * The flash is this list's own: it says "here you were" on a page full of
 * near-identical rows.
 */
async function resolveListAnchor(anchor: ListAnchor | null): Promise<HTMLElement | null> {
  if (!anchor) return null
  // One more tick than PageLayout waits: the rows render from `items`, which
  // the filter watcher can still be rewriting.
  await nextTick()
  const el = focusListAnchor(document, anchor)
  if (!el) return null
  const highlight =
    anchor.kind === 'collection' ? 'collection-row--highlight' : 'document-card--highlight'
  el.classList.add(highlight)
  setTimeout(() => el.classList.remove(highlight), 1500)
  return el
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
  await Promise.all([loadCategories(), loadDocumentTypes(), loadGroups(), loadSubjectPeople(), loadCorrespondents(), load()])
})
</script>

<template>
  <PageLayout
    title="Dokumente"
    scroll="self"
    width="full"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
    legacy-anchor-key="documents"
    :scroller="listColumn"
    :resolve-anchor="resolveListAnchor"
  >
    <template #actions>
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
    </template>

    <!-- Sticky part (lifted into the app stack by PageLayout): toolbar,
         active filter chips, the selection bar and the notices. -->
    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <SelectButton
            v-if="isSearchActive"
            v-model="searchMode"
            :options="searchModeOptions"
            optionLabel="label"
            optionValue="value"
            :allowEmpty="false"
            size="small"
            class="search-mode-btn"
            v-tooltip.bottom="'Suchmodus'"
            @update:model-value="load"
          />
        </template>
      </ListToolbar>
    </template>

    <template #selection>
      <!-- The shared bar; the basket hand-over is this list's own action. -->
      <SelectionBar
        v-if="selectMode"
        :selection="selection"
        :actions="selectionActions"
        noun="Dokumente"
      >
        <template #primary>
          <Button
            label="In den Basket"
            icon="pi pi-shopping-cart"
            size="small"
            :disabled="selectedIds.size === 0"
            v-tooltip.bottom="'Auswahl in den Basket legen (oben rechts) — dort werden Tags, Kategorie, Datum, Steuer, Sichtbarkeit und OCR/KI gemeinsam bearbeitet oder durchblättert.'"
            @click="addSelectionToBasket"
          />
        </template>
      </SelectionBar>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = ''" />
      <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>
      <DocumentScanQueuePanel />
    </template>

    <PageSkeleton v-if="loading && items.length === 0" variant="list" :count="8" />
    <EmptyState
      v-else-if="items.length === 0"
      icon="pi pi-file"
      :title="isSearchActive ? `Keine Treffer für „${q}“` : 'Noch keine Dokumente vorhanden'"
      :message="isSearchActive
        ? 'Andere Wörter oder ein anderer Suchmodus finden vielleicht mehr.'
        : 'Lade ein Dokument hoch oder lass den Scan-Ordner überwachen.'"
      :filtered="filter.activeCount.value > 0"
      @clear-filters="() => { filter.reset(); load() }"
    />

    <!-- List and, on a wide landscape screen, the preview beside it (#735).
         The header and toolbar above stay full width: a filter panel squeezed
         into a 600px column is worse than one that spans the page. -->
    <div class="list-region" :class="{ 'list-region--split': isSplit }">
      <div ref="listColumn" class="list-column">
    <!-- Sammelmappen: an extra layer above the documents, never a replacement -->
    <div v-if="!loading && visibleCollections.length > 0" class="collection-strip">
      <button
        v-for="c in visibleCollections"
        :key="c.id"
        :data-collection-id="c.id"
        :data-anchor="anchorKey('collection', c.id)"
        type="button"
        class="collection-row scroll-anchor"
        @click="openCollection(c.id)"
      >
        <span class="collection-icon"><i class="pi pi-folder" /></span>
        <span class="collection-body">
          <span class="collection-title">
            {{ c.title }}
            <Tag value="Sammelmappe" severity="secondary" />
            <Tag v-if="c.visibility === 'group'" value="Gruppe" icon="pi pi-users" severity="info" />
          </span>
          <span v-if="c.summary" class="collection-summary">{{ c.summary }}</span>
          <span class="collection-meta">
            <i class="pi pi-file" />
            {{ c.included_count }} von {{ c.item_count }}
            {{ c.item_count === 1 ? 'Dokument' : 'Dokumenten' }} im PDF
          </span>
        </span>
        <span class="collection-open"><i class="pi pi-angle-right" /></span>
      </button>
    </div>

    <p v-if="!loading && bundledHidden" class="collection-hidden-note">
      <i class="pi pi-info-circle" />
      Dokumente, die in einer Sammelmappe liegen, sind ausgeblendet — die Mappe steht oben für sie.
      <button type="button" class="collection-note-action" @click="showBundledDocuments">
        Auch anzeigen
      </button>
    </p>

    <p v-else-if="!loading && collectionFacetActive && collections.length > 0" class="collection-hidden-note">
      <i class="pi pi-info-circle" />
      Sammelmappen werden bei aktivem Dokumentfilter nicht gezeigt — ein Filter fragt nach
      Eigenschaften eines Dokuments, die eine Mappe nicht hat.
    </p>

    <!-- List view -->
    <div v-if="!loading && items.length > 0 && viewMode === 'list'" class="document-list">
      <div
        v-for="doc in items"
        :key="doc.id"
        :data-doc-id="doc.id"
        :data-anchor="anchorKey('document', doc.id)"
        class="document-card scroll-anchor"
        :class="{
          'document-card--selected': isSelected(doc.id),
          'document-card--active': isSplit && activeDocId === doc.id,
        }"
        :aria-current="isSplit && activeDocId === doc.id ? 'true' : undefined"
      >
        <div class="document-header">
          <div v-if="selectMode" class="document-checkbox" @click.stop>
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
          <Button
            :icon="basket.has(doc.id) ? 'pi pi-cart-minus' : 'pi pi-shopping-cart'"
            text
            rounded
            size="small"
            :severity="basket.has(doc.id) ? 'success' : 'secondary'"
            :aria-label="basket.has(doc.id) ? 'Aus dem Basket entfernen' : 'In den Basket legen'"
            v-tooltip.bottom="basket.has(doc.id) ? 'Aus dem Basket entfernen' : 'Dokument direkt in den Basket legen'"
            @click.stop="basket.toggle(doc)"
          />
          <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
          <Tag
            v-if="isNew(doc)"
            severity="info"
            icon="pi pi-sparkles"
            value="Neu"
            v-tooltip.bottom="'KI-Zuordnung noch nicht bestätigt — über den Basket oder die Detailansicht bestätigen.'"
          />
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
          <div v-if="doc.collections.length > 0" class="document-collections">
            <button
              v-for="c in doc.collections"
              :key="c.id"
              type="button"
              class="collection-chip"
              v-tooltip.bottom="'Nur die Dokumente dieser Sammelmappe zeigen'"
              @click.stop="filterByCollection(c.id)"
            >
              <i class="pi pi-folder" /> {{ c.title }}
            </button>
          </div>
          <div v-if="doc.tags.length > 0" class="document-tags">
            <Chip v-for="tag in doc.tags" :key="tag" :label="tag" />
          </div>
        </div>
      </div>
    </div>

    <!-- Grid / card view -->
    <div v-else-if="!loading && items.length > 0" class="document-grid">
      <div
        v-for="doc in items"
        :key="doc.id"
        :data-doc-id="doc.id"
        :data-anchor="anchorKey('document', doc.id)"
        class="grid-card scroll-anchor"
        :class="{
          'grid-card--selected': isSelected(doc.id),
          'grid-card--active': isSplit && activeDocId === doc.id,
        }"
        tabindex="0"
        @click="openDocument(doc)"
        @keydown.enter="openDocument(doc)"
      >
        <div v-if="selectMode" class="grid-card-checkbox" @click.stop>
          <Checkbox
            :modelValue="isSelected(doc.id)"
            :binary="true"
            :aria-label="`Dokument ${doc.title || doc.original_filename} auswählen`"
            @update:modelValue="(val: boolean) => toggleSelected(doc.id, val)"
          />
        </div>
        <Button
          class="grid-card-basket-btn"
          :icon="basket.has(doc.id) ? 'pi pi-cart-minus' : 'pi pi-shopping-cart'"
          text
          rounded
          size="small"
          :severity="basket.has(doc.id) ? 'success' : 'secondary'"
          :aria-label="basket.has(doc.id) ? 'Aus dem Basket entfernen' : 'In den Basket legen'"
          v-tooltip.bottom="basket.has(doc.id) ? 'Aus dem Basket entfernen' : 'Dokument direkt in den Basket legen'"
          @click.stop="basket.toggle(doc)"
        />
        <div class="grid-card-thumb">
          <DocumentThumbnail :id="doc.id" :alt="doc.title || doc.original_filename" />
        </div>
        <Tag
          class="grid-card-status"
          :severity="statusSeverity(doc.status)"
          :value="statusLabel(doc.status)"
        />
        <Tag v-if="isNew(doc)" class="grid-card-status" severity="info" value="Neu" />
        <div class="grid-card-title">{{ doc.title || doc.original_filename }}</div>
        <div class="grid-card-meta">
          <span v-if="doc.sender">{{ doc.sender }}</span>
          <span v-if="doc.doc_date">{{ formatDate(doc.doc_date) }}</span>
        </div>
        <div v-if="doc.category_slug" class="grid-card-category">
          <i class="pi pi-folder" /> {{ doc.category_slug }}
        </div>
        <div v-if="doc.collections.length > 0" class="grid-card-collections">
          <i class="pi pi-folder" />
          {{ doc.collections.map((c) => c.title).join(', ') }}
        </div>
        <div v-if="doc.tags.length > 0" class="grid-card-tags">
          <Chip v-for="tag in doc.tags.slice(0, 3)" :key="tag" :label="tag" />
          <span v-if="doc.tags.length > 3" class="more-tags">+{{ doc.tags.length - 3 }}</span>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="hasMore" class="load-more-row">
      <Button
        :label="`Mehr laden (${items.length} von ${total})`"
        icon="pi pi-angle-down"
        severity="secondary"
        outlined
        :loading="loadingMore"
        @click="loadMore"
      />
    </div>

      </div>

      <DocumentPreviewPane v-if="isSplit" :document-id="activeDocId" class="detail-column" />
    </div>

    <!-- Dialogs -->
    <AddToCollectionDialog
      v-model:visible="addToCollectionOpen"
      :document-ids="[...selectedIds]"
      @added="onAddedToCollection"
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
      :document-types="documentTypes"
      :known-tags="allKnownTags"
      :subject-people="subjectPeople"
      :correspondents="correspondents"
      :collections="collections"
      @apply="applyFilterMenu"
      @reset="resetFilterMenu"
    />
  </PageLayout>
</template>

<style scoped>
/* ── Split layout (issue #735) ──────────────────────────────────────────────
   Single column by default; the two-column grid only exists once the media
   query in useSplitView matches, so the stylesheet and the script cannot
   disagree about whether the pane is there. */
/* The only part of the view that scrolls. `min-height: 0` is what lets it
   shrink below its content and hand the overflow to the columns inside. */
.list-region {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.list-region--split {
  display: grid;
  grid-template-columns: minmax(500px, 600px) 1fr;
  align-items: stretch;
  gap: 1rem;
}
/* Each column scrolls on its own, so reading the preview never moves the list
   and vice versa. */
.list-column {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  /* A Sammelmappe row fills this column, so its focus ring lands on the
     column's edge — which `overflow-y: auto` clips, horizontally too, and
     the last row's ring falls off the bottom of the scrollable canvas.
     Room on every side, taken straight back off the outside. */
  padding: calc(0.75rem + var(--focus-ring-reach)) var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
}
.list-region--split .detail-column {
  min-height: 0;
  margin-block: 0.75rem;
}
.document-card--active {
  border-color: var(--p-primary-color);
  box-shadow: inset 3px 0 0 0 var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background));
}
.grid-card--active {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--p-primary-color);
}
.collection-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.collection-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--p-content-border-color);
  border-left: 3px solid var(--p-primary-color);
  border-radius: 10px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  cursor: pointer;
}
.collection-row:hover {
  background: var(--p-content-hover-background);
}
.collection-row--highlight {
  animation: collection-row-flash 1.5s ease-out;
}
@keyframes collection-row-flash {
  0% {
    background: color-mix(in srgb, var(--p-primary-color) 22%, transparent);
  }
  100% {
    background: var(--p-content-background);
  }
}
.collection-icon {
  flex: 0 0 auto;
  color: var(--p-primary-color);
  font-size: var(--text-xl);
}
.collection-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.collection-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.collection-summary {
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.collection-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.collection-meta i {
  margin-right: 3px;
}
.collection-open {
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
}
.collection-hidden-note {
  margin: 0 0 12px;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.collection-hidden-note i {
  margin-right: 4px;
}
.collection-note-action {
  border: 0;
  padding: 0;
  margin-left: 6px;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.document-collections {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}
.collection-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  cursor: pointer;
}
.collection-chip:hover {
  color: var(--p-primary-color);
  border-color: var(--p-primary-color);
}
.grid-card-collections {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid-card-collections i {
  margin-right: 3px;
}
/* Page frame, title, sticky subheader: all PageLayout now (issue #1272).
   Only the list region below keeps its own scrolling columns. */

.search-mode-btn { flex-shrink: 0; }

/* ── Pagination ────────────────────────────────────────────────── */
.load-more-row {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0 1rem;
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
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
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
  font-size: var(--text-5xl);
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
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
.document-meta span { display: inline-flex; align-items: center; gap: 0.25rem; }

.tax-badge { color: var(--p-primary-color); font-weight: 500; }

.document-error {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--text-base);
  color: var(--p-red-600);
  /* A translucent red tint instead of red-50: the fixed light tint would stay
     a bright patch on a dark page, the tint takes the page's own surface. */
  background: color-mix(in srgb, var(--p-red-500) 12%, transparent);
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
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.grid-card--selected {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background));
}

.grid-card-checkbox {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
}

.grid-card-basket-btn {
  position: absolute;
  top: 0.25rem;
  left: 0.25rem;
  z-index: 1;
  background: color-mix(in srgb, var(--p-content-background) 75%, transparent);
}

.grid-card-thumb {
  margin-bottom: 0.1rem;
}

.grid-card-status {
  align-self: flex-start;
}

.grid-card-title {
  font-weight: 600;
  font-size: var(--text-base);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-card-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
}

.grid-card-category {
  font-size: var(--text-md);
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
.grid-card-tags :deep(.p-chip) { font-size: var(--text-sm); }
.more-tags {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  align-self: center;
}

/* ── Mobile adjustments ────────────────────────────────────────── */
@media (max-width: 600px) {
  .document-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.5rem;
  }
}
</style>
