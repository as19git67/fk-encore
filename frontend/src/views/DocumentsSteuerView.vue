<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import {
  backfillDocumentTax,
  listTaxDocuments,
  listTaxYears,
  type ListTaxDocumentsResponse,
  type TaxAssignmentSource,
  type TaxSectionGroup,
  type TaxYearCount,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const years = ref<TaxYearCount[]>([])
const selectedYear = ref<number | null>(null)
const reviewNeededOnly = ref(false)
const data = ref<ListTaxDocumentsResponse | null>(null)
const loading = ref(true)
const error = ref('')
const info = ref('')
const backfilling = ref(false)

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

const totalDocsLabel = computed(() => {
  const n = data.value?.total_documents ?? 0
  if (n === 0) return ''
  return n === 1 ? '1 Dokument' : `${n} Dokumente`
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
    })
  } catch (err: any) {
    error.value = err.message || 'Steuerliste konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
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

function openDocument(docId: number) {
  router.push({ name: 'dokumente-detail', params: { id: docId } })
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

watch(selectedYear, loadData)
watch(reviewNeededOnly, loadData)

onMounted(async () => {
  await loadYears()
  await loadData()
})
</script>

<template>
  <div class="tax-view">
    <div class="header">
      <h1 class="title">Steuer</h1>
      <div class="header-actions">
        <Button
          v-if="auth.hasPermission('documents.edit')"
          icon="pi pi-sync"
          label="KI-Analyse nachholen"
          text
          :loading="backfilling"
          title="Bestehende Dokumente erneut vom Klassifier analysieren lassen, um fehlende Steuer-Daten zu ergänzen."
          @click="onBackfill"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

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

    <div v-if="totalDocsLabel" class="total-label">{{ totalDocsLabel }}</div>

    <div v-if="loading" class="info-text">
      <ProgressSpinner style="width:1.5rem;height:1.5rem" strokeWidth="4" />
      <span>Steuer-Dokumente werden geladen…</span>
    </div>

    <div v-else-if="!data || data.sections.length === 0" class="info-text">
      <template v-if="years.length === 0">
        Es wurden noch keine steuerlich relevanten Dokumente erkannt.
        <span v-if="auth.hasPermission('documents.edit')"><br>
          Falls du bereits ältere Dokumente hochgeladen hast, starte oben die
          „KI-Analyse nachholen".
        </span>
      </template>
      <template v-else>
        Für dieses Jahr wurden keine Steuer-Dokumente gefunden.
      </template>
    </div>

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
              @click="openDocument(entry.document.id)"
              @keydown.enter="openDocument(entry.document.id)"
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
</template>

<style scoped>
.tax-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  padding-inline: 0.5em;
}
@media (min-width: 800px) { .tax-view { padding-inline: 1em; } }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem 0.5rem;
}
.title { font-size: 1.5em; font-weight: 600; margin-block: 0.25em; }
.header-actions { display: flex; gap: 0.25rem; }

.year-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.year-filters-label {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  margin-right: 0.25rem;
}

.total-label {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
}

.info-text {
  text-align: center;
  margin-top: 3rem;
  color: var(--p-text-muted-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
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
