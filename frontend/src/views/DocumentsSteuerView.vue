<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListToolbar } from '../composables/useListToolbar'
import type { FilterChip } from '../components/layout/listToolbar'
import {
  backfillDocumentTax,
  listSubjectPersons,
  listTaxDocuments,
  listTaxYears,
  type ListTaxDocumentsResponse,
  type SubjectPerson,
  type TaxAssignmentSource,
  type TaxSectionGroup,
  type TaxYearCount,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useScrollRestore } from '../composables/useScrollRestore'
import { replaceQuerySlice, updateRouteQuery, waitForPendingQueryUpdate } from '../utils/routeQueryUpdate'
import {
  consumeTaxListFocus,
  focusTaxListItem,
  rememberTaxListFocus,
  taxEntryKey,
} from '../utils/taxListFocus'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
// Returning from a document must land back where the user left, not at the
// top of the list. The row anchor does the precise work; the raw offset is
// the fallback for when that row is gone (re-classified, filtered away).
const { restore: restoreScroll } = useScrollRestore('documents-tax-list')

// Persisted in the URL (year/review) so the back arrow from the document
// detail view restores the same filter instead of resetting to the newest
// year with no review filter.
const STEUER_QUERY_KEYS = ['year', 'review', 'person'] as const

function initialYearFromQuery(): number | null {
  const raw = route.query.year
  const n = typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

const years = ref<TaxYearCount[]>([])
const selectedYear = ref<number | null>(initialYearFromQuery())
const reviewNeededOnly = ref(route.query.review === '1')
// Steuerakte scope: null = the caller's own tax return, a subject-person id =
// that person's own Steuerakte (an adult child filing their own return).
const taxReturnPersonId = ref<number | null>(
  route.query.person != null && route.query.person !== ''
    ? Number(route.query.person) || null
    : null,
)
const subjectPersons = ref<SubjectPerson[]>([])
const ownReturnPersons = computed(() =>
  subjectPersons.value.filter((p) => p.own_tax_return_from_tax_year !== null),
)
const data = ref<ListTaxDocumentsResponse | null>(null)
const loading = ref(true)
const error = ref('')
const info = ref('')
const backfilling = ref(false)

function syncQueryParams() {
  const query: Record<string, string> = {}
  if (selectedYear.value != null) query.year = String(selectedYear.value)
  if (reviewNeededOnly.value) query.review = '1'
  if (taxReturnPersonId.value != null) query.person = String(taxReturnPersonId.value)
  return updateRouteQuery(router, (current) =>
    replaceQuerySlice(current, STEUER_QUERY_KEYS, query),
  )
}

const GROUP_LABELS: Record<TaxSectionGroup, string> = {
  einkuenfte: 'Einkünfte',
  abzuege: 'Abzüge',
  bescheid: 'Bescheide',
  rahmen: 'Stammdaten',
}

// Walk sections in order and build (group, sections[]) tuples so the
// template can render a group header above the first section of each
// group without duplicating headers.
const grouped = computed(() => {
  if (!data.value) return []
  const buckets: Array<{ group: TaxSectionGroup; label: string; sections: typeof data.value.sections }> = []
  let current: (typeof buckets)[number] | null = null
  for (const section of data.value.sections) {
    if (!current || current.group !== section.group) {
      current = { group: section.group, label: GROUP_LABELS[section.group], sections: [] }
      buckets.push(current)
    }
    current.sections.push(section)
  }
  return buckets
})

// ─── Toolbar (issue #1272, stage 3) ─────────────────────────────────────────
// The filter rows stay where they are, always visible; the toolbar adds the
// shared chips and the result count around them. It renders no filter button
// here, because there is no menu to open.

const personLabel = (id: number) =>
  subjectPersons.value.find((p) => p.id === id)?.full_name ?? `#${id}`

const filterChips = computed<FilterChip[]>(() => {
  const out: FilterChip[] = []
  if (selectedYear.value != null) {
    out.push({
      key: 'year',
      label: `Steuerjahr: ${selectedYear.value}`,
      remove: () => { selectedYear.value = null },
    })
  }
  if (reviewNeededOnly.value) {
    out.push({
      key: 'review',
      label: 'Status: Nur zu prüfen',
      remove: () => { reviewNeededOnly.value = false },
    })
  }
  if (taxReturnPersonId.value != null) {
    out.push({
      key: 'person',
      label: `Steuerakte: ${personLabel(taxReturnPersonId.value)}`,
      remove: () => { taxReturnPersonId.value = null },
    })
  }
  return out
})

const activeFilterCount = computed(() => filterChips.value.length)

function clearFilters() {
  selectedYear.value = null
  reviewNeededOnly.value = false
  taxReturnPersonId.value = null
}

const toolbar = useListToolbar({
  filter: {
    chips: filterChips,
    activeCount: activeFilterCount,
    clearAll: clearFilters,
  },
  result: {
    // The tax list arrives whole — no paging, so loaded is the total.
    loaded: () => data.value?.total_documents ?? 0,
    loading: () => loading.value,
  },
})

/** The two wordings the empty list has: nothing recognised yet, or nothing for this filter. */
const emptyMessage = computed(() => {
  if (years.value.length > 0) return 'Für dieses Jahr wurden keine Steuer-Dokumente gefunden.'
  const base = 'Es wurden noch keine steuerlich relevanten Dokumente erkannt.'
  return auth.hasPermission('documents.edit')
    ? `${base} Falls du bereits ältere Dokumente hochgeladen hast, starte oben die „KI-Analyse nachholen“.`
    : base
})

async function loadYears() {
  try {
    const res = await listTaxYears()
    years.value = res.years
    // Pre-select the newest year if none picked yet.
    const first = res.years[0]
    if (selectedYear.value === null && first) {
      selectedYear.value = first.year
    }
  } catch (err: any) {
    error.value = err.message || 'Steuerjahre konnten nicht geladen werden'
  }
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    data.value = await listTaxDocuments({
      ...(selectedYear.value != null ? { year: selectedYear.value } : {}),
      ...(reviewNeededOnly.value ? { review_needed: true } : {}),
      ...(taxReturnPersonId.value != null
        ? { tax_return_person: taxReturnPersonId.value }
        : {}),
    })
  } catch (err: any) {
    error.value = err.message || 'Steuerliste konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

/** Retry for the error banner: the year list may have failed too. */
async function reload() {
  error.value = ''
  await loadYears()
  await loadData()
}

async function onBackfill() {
  if (backfilling.value) return
  backfilling.value = true
  info.value = ''
  error.value = ''
  try {
    const res = await backfillDocumentTax()
    info.value =
      res.queued === 0
        ? 'Alle bestehenden Dokumente wurden bereits analysiert.'
        : `${res.queued} Dokument(e) zur erneuten KI-Analyse eingereiht. Die Tabelle aktualisiert sich in Kürze.`
    // Re-pull years (new years might appear when documents finish).
    setTimeout(() => {
      loadYears()
      loadData()
    }, 2000)
  } catch (err: any) {
    error.value = err.message || 'Backfill fehlgeschlagen'
  } finally {
    backfilling.value = false
  }
}

async function openDocument(sectionSlug: string, docId: number) {
  rememberTaxListFocus(sectionSlug, docId)
  // Wait for any pending filter write so the back arrow's history entry
  // captures the current year/review filter instead of a stale query.
  await waitForPendingQueryUpdate(router)
  router.push({ name: 'dokumente-detail', params: { id: docId } })
}

/**
 * Put the user back on the row they opened the document from. Returns false
 * when that row is not on screen, and the caller falls back to the offset.
 */
async function restoreFocusToLastOpened(): Promise<boolean> {
  const focus = consumeTaxListFocus()
  if (!focus) return false
  await nextTick()
  await nextTick()
  const el = focusTaxListItem(document, focus)
  if (!el) return false
  el.classList.add('document-card--highlight')
  setTimeout(() => el.classList.remove('document-card--highlight'), 1500)
  return true
}

function confidencePercent(c: number | null): string {
  if (c == null) return ''
  return `${Math.round(c * 100)}%`
}

function sourceBadge(src: TaxAssignmentSource): { label: string; severity: 'success' | 'info' } {
  return src === 'user'
    ? { label: 'Manuell', severity: 'success' }
    : { label: 'KI', severity: 'info' }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

// One watcher over all three so clearing several at once (the toolbar's
// "Alle entfernen") reloads once instead of three times.
watch([selectedYear, reviewNeededOnly, taxReturnPersonId], () => {
  syncQueryParams()
  loadData()
})

onMounted(async () => {
  await loadYears()
  // Advisory: the Steuerakte switcher is a convenience, a failure here must
  // not keep the tax list itself from rendering.
  try {
    subjectPersons.value = (await listSubjectPersons()).items
  } catch {
    subjectPersons.value = []
  }
  await loadData()
  // Returning from detail: centre, highlight and restore actual keyboard
  // focus. Only use the generic scroll offset when there is no row anchor.
  if (!(await restoreFocusToLastOpened())) restoreScroll()
})
</script>

<template>
  <PageLayout title="Steuer" width="wide" scroll="page" :ready="!loading">
    <template #actions>
      <Button
        v-if="auth.hasPermission('documents.edit')"
        icon="pi pi-sync"
        label="KI-Analyse nachholen"
        text
        :loading="backfilling"
        title="Bestehende Dokumente erneut vom Klassifier analysieren lassen, um fehlende Steuer-Daten zu ergänzen."
        @click="onBackfill"
      />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="reload" @close="error = ''" />
      <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <div class="steuer-filters">
            <div v-if="years.length > 0" class="year-filters">
              <span class="year-filters-label">Steuerjahr:</span>
              <Button
                :label="`Alle${years.length > 1 ? ` (${years.reduce((s, y) => s + y.count, 0)})` : ''}`"
                size="small"
                :severity="selectedYear === null ? 'primary' : 'secondary'"
                :outlined="selectedYear !== null"
                @click="selectedYear = null"
              />
              <Button
                v-for="y in years"
                :key="y.year"
                :label="`${y.year} (${y.count})`"
                size="small"
                :severity="selectedYear === y.year ? 'primary' : 'secondary'"
                :outlined="selectedYear !== y.year"
                @click="selectedYear = y.year"
              />
              <Button
                label="Nur zu prüfen"
                icon="pi pi-question-circle"
                size="small"
                severity="warn"
                :outlined="!reviewNeededOnly"
                title="Nur Dokumente einer Bezugsperson mit absetzbarer Position, bei denen noch offen ist, ob du die Ausgabe getragen hast."
                @click="reviewNeededOnly = !reviewNeededOnly"
              />
            </div>

            <div v-if="ownReturnPersons.length > 0" class="year-filters">
              <span class="year-filters-label">Steuerakte:</span>
              <Button
                label="Meine Erklärung"
                size="small"
                :severity="taxReturnPersonId === null ? 'primary' : 'secondary'"
                :outlined="taxReturnPersonId !== null"
                @click="taxReturnPersonId = null"
              />
              <Button
                v-for="p in ownReturnPersons"
                :key="p.id"
                :label="p.full_name"
                size="small"
                :severity="taxReturnPersonId === p.id ? 'primary' : 'secondary'"
                :outlined="taxReturnPersonId !== p.id"
                :title="`Eigene Steuererklärung ab Steuerjahr ${p.own_tax_return_from_tax_year}`"
                @click="taxReturnPersonId = p.id"
              />
            </div>
          </div>
        </template>
      </ListToolbar>
    </template>

    <div class="content">
    <PageSkeleton v-if="loading && !data" variant="list" :count="6" />

    <EmptyState
      v-else-if="!data || data.sections.length === 0"
      icon="pi pi-percentage"
      title="Keine Steuer-Dokumente"
      :message="emptyMessage"
      :filtered="activeFilterCount > 0"
      @clear-filters="clearFilters"
    />

    <div v-else class="groups">
      <section v-for="group in grouped" :key="group.group" class="group">
        <h2 class="group-heading">{{ group.label }}</h2>
        <section v-for="sec in group.sections" :key="sec.slug" class="section">
          <h3 class="section-heading">
            <span>{{ sec.name }}</span>
            <span class="section-count">
              {{ sec.documents.length === 1 ? '1 Beleg' : `${sec.documents.length} Belege` }}
            </span>
          </h3>
          <div class="document-list">
            <div
              v-for="entry in sec.documents"
              :key="`${sec.slug}:${entry.document.id}`"
              class="document-card"
              tabindex="0"
              :data-doc-id="entry.document.id"
              :data-tax-entry="taxEntryKey(sec.slug, entry.document.id)"
              @click="openDocument(sec.slug, entry.document.id)"
              @keydown.enter="openDocument(sec.slug, entry.document.id)"
            >
              <div class="document-icon"><i class="pi pi-file-pdf" /></div>
              <div class="document-body">
                <div class="document-title-row">
                  <span class="document-title">
                    {{ entry.document.title || entry.document.original_filename }}
                  </span>
                  <Tag
                    :severity="sourceBadge(entry.source).severity"
                    :value="sourceBadge(entry.source).label"
                  />
                  <span
                    v-if="entry.source === 'ai' && entry.confidence != null"
                    class="confidence"
                  >
                    {{ confidencePercent(entry.confidence) }}
                  </span>
                </div>
                <div class="document-meta">
                  <span v-if="entry.document.sender"><i class="pi pi-user" /> {{ entry.document.sender }}</span>
                  <span v-if="entry.document.doc_date">
                    <i class="pi pi-calendar" /> {{ formatDate(entry.document.doc_date) }}
                  </span>
                  <span v-if="entry.document.tax_year" class="doc-year">
                    <i class="pi pi-tag" /> Steuerjahr {{ entry.document.tax_year }}
                  </span>
                </div>
                <div v-if="entry.document.tags.length > 0" class="document-tags">
                  <Chip v-for="tag in entry.document.tags" :key="tag" :label="tag" />
                </div>
              </div>
            </div>
          </div>
        </section>
      </section>
    </div>
    </div>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* The filter rows fill the toolbar's action area instead of being pushed
   to its right edge, so they keep reading as two left-aligned rows. */
.steuer-filters {
  display: flex;
  flex: 1 1 100%;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.year-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: center;
}
.year-filters-label {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  margin-right: 0.25rem;
}

.groups { display: flex; flex-direction: column; gap: 2rem; }

.group { display: flex; flex-direction: column; gap: 1rem; }
.group-heading {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
  padding-bottom: 0.25rem;
  border-bottom: 2px solid var(--p-primary-color);
  color: var(--p-primary-color);
}

.section { display: flex; flex-direction: column; gap: 0.5rem; }
.section-heading {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  color: var(--p-text-color);
}
.section-count {
  font-size: 0.8rem;
  font-weight: 400;
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

.document-card--highlight {
  animation: card-flash 1.5s ease-out;
}
@keyframes card-flash {
  0%   { box-shadow: 0 0 0 3px var(--p-primary-color); }
  100% { box-shadow: none; }
}

.document-icon {
  font-size: 2rem;
  color: var(--p-primary-color);
  flex-shrink: 0;
}

.document-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.4rem; }

.document-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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
.confidence {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.document-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.document-meta span { display: inline-flex; align-items: center; gap: 0.25rem; }
.doc-year { color: var(--p-primary-color); }

.document-tags { display: flex; flex-wrap: wrap; gap: 0.25rem; }
</style>
