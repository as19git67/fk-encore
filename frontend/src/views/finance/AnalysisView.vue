<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import RadioButton from 'primevue/radiobutton'
import AutoComplete from 'primevue/autocomplete'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Chart from 'primevue/chart'
import Dialog from 'primevue/dialog'
import ProgressSpinner from 'primevue/progressspinner'
import { toLocalIsoDate, parseLocalDate } from '../../utils/dateFormat'
import {
  analysisAggregate,
  analysisQuery,
  analysisTransactions,
  listSavedAnalyses,
  saveAnalysis,
  deleteSavedAnalysis,
  updateSavedAnalysis,
  markSavedAnalysesSeen,
  type AnalysisAst,
  type AnalysisResult,
  type AnalysisTransaction,
  type SavedAnalysisItem,
} from '../../api/finance'
import { useTagsStore } from '../../stores/finance/tags'

const tagsStore = useTagsStore()

const darkMQ = window.matchMedia('(prefers-color-scheme: dark)')
const isDark = ref(darkMQ.matches)
function onDarkChange(e: MediaQueryListEvent) {
  isDark.value = e.matches
}

const question = ref('')
const parsing = ref(false)
const aggregating = ref(false)
const error = ref<string | null>(null)
const result = ref<AnalysisResult | null>(null)

const tagSuggestions = ref<string[]>([])

const astEditable = ref<AnalysisAst>({ tags: [], op: 'AND', kind: 'ongoing' })
const fromDate = ref<Date | null>(null)
const toDate = ref<Date | null>(null)

const showMonthly = computed(() => astEditable.value.kind !== 'event')

// --- Saved analyses (Rückblicke) ---
const savedItems = ref<SavedAnalysisItem[]>([])
const savedLoading = ref(false)
const savedHasMore = ref(false)
const savedFilter = ref<'all' | 'user' | 'ai'>('all')
const saveName = ref('')
const saveDialogVisible = ref(false)
const saving = ref(false)
const activeItemId = ref<number | null>(null)

onMounted(async () => {
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  darkMQ.addEventListener('change', onDarkChange)
  await loadSaved()
})

onUnmounted(() => {
  darkMQ.removeEventListener('change', onDarkChange)
})

async function loadSaved() {
  savedLoading.value = true
  try {
    const resp = await listSavedAnalyses({ limit: 20, source: savedFilter.value })
    savedItems.value = resp.items
    savedHasMore.value = resp.hasMore
  } catch {
    // silent
  } finally {
    savedLoading.value = false
  }
}

async function loadMore() {
  if (!savedHasMore.value || savedItems.value.length === 0) return
  const lastItem = savedItems.value[savedItems.value.length - 1] as SavedAnalysisItem | undefined
  if (!lastItem) return
  savedLoading.value = true
  try {
    const resp = await listSavedAnalyses({
      limit: 20,
      before: lastItem.createdAt,
      source: savedFilter.value,
    })
    savedItems.value = [...savedItems.value, ...resp.items]
    savedHasMore.value = resp.hasMore
  } catch {
    // silent
  } finally {
    savedLoading.value = false
  }
}

function openSaveDialog() {
  saveName.value = question.value.trim() || ''
  saveDialogVisible.value = true
}

async function doSave() {
  if (!saveName.value.trim() || !result.value) return
  saving.value = true
  try {
    const item = await saveAnalysis({
      name: saveName.value.trim(),
      question: question.value.trim() || undefined,
      ast: result.value.ast,
      summary: result.value.total,
    })
    savedItems.value = [item, ...savedItems.value]
    activeItemId.value = item.id
    saveDialogVisible.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function runSavedItem(item: SavedAnalysisItem) {
  activeItemId.value = item.id
  aggregating.value = true
  error.value = null
  try {
    const resp = await analysisAggregate({ ast: item.ast })
    applyResult(resp)
    question.value = item.question || item.name
    // Update the cached summary
    await updateSavedAnalysis({ id: item.id, summary: resp.total }).catch(() => {})
    const idx = savedItems.value.findIndex((s) => s.id === item.id)
    if (idx >= 0) {
      savedItems.value[idx] = Object.assign({}, savedItems.value[idx], { summary: resp.total })
    }
    // Mark AI items as seen
    if (item.source === 'ai' && !item.seenAt) {
      await markSavedAnalysesSeen([item.id]).catch(() => {})
      if (idx >= 0) {
        savedItems.value[idx] = Object.assign({}, savedItems.value[idx], { seenAt: new Date().toISOString() })
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    aggregating.value = false
  }
}

async function removeSavedItem(item: SavedAnalysisItem) {
  try {
    await deleteSavedAnalysis(item.id)
    savedItems.value = savedItems.value.filter((s) => s.id !== item.id)
    if (activeItemId.value === item.id) activeItemId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function searchTags(event: { query: string }) {
  const q = event.query.toLowerCase()
  tagSuggestions.value = tagsStore.items
    .filter((t) => t.name.toLowerCase().includes(q))
    .map((t) => t.name)
}

function toIso(d: Date | null): string | undefined {
  return d ? toLocalIsoDate(d) : undefined
}

function fromIso(s: string | undefined): Date | null {
  return s ? parseLocalDate(s) : null
}

async function submitQuestion() {
  if (!question.value.trim()) return
  parsing.value = true
  error.value = null
  result.value = null
  activeItemId.value = null
  try {
    const resp = await analysisQuery({ question: question.value.trim() })
    applyResult(resp)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    parsing.value = false
  }
}

async function reaggregate() {
  aggregating.value = true
  error.value = null
  try {
    const ast: AnalysisAst = {
      tags: [...astEditable.value.tags],
      op: astEditable.value.op,
      kind: astEditable.value.kind,
    }
    const from = toIso(fromDate.value)
    const to = toIso(toDate.value)
    if (from && to) ast.timespan = { from, to }
    const resp = await analysisAggregate({ ast })
    applyResult(resp)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    aggregating.value = false
  }
}

function applyResult(r: AnalysisResult) {
  result.value = r
  astEditable.value = {
    tags: [...r.ast.tags],
    op: r.ast.op,
    kind: r.ast.kind ?? 'ongoing',
  }
  fromDate.value = fromIso(r.ast.timespan?.from)
  toDate.value = fromIso(r.ast.timespan?.to)
}

function formatCurrency(sum: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(sum))
}

function formatDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString('de-DE')
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Heute'
  if (diffDays === 1) return 'Gestern'
  if (diffDays < 7) return `Vor ${diffDays} Tagen`
  return d.toLocaleDateString('de-DE')
}

// --- Drill-down: transactions behind a single tag of the breakdown ---
const detailVisible = ref(false)
const detailTag = ref('')
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const detailRows = ref<AnalysisTransaction[]>([])

async function openTagDetails(tag: string) {
  if (!result.value) return
  detailTag.value = tag
  detailVisible.value = true
  detailLoading.value = true
  detailError.value = null
  detailRows.value = []
  try {
    const resp = await analysisTransactions({ ast: result.value.ast, tag })
    detailRows.value = resp.transactions
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err)
  } finally {
    detailLoading.value = false
  }
}

function onTagRowClick(event: { data: { tag: string } }) {
  openTagDetails(event.data.tag)
}

const chartData = computed(() => {
  if (!result.value) return null
  return {
    labels: result.value.byMonth.map((m) => m.month),
    datasets: [
      {
        label: 'Summe',
        data: result.value.byMonth.map((m) => Number(m.sum)),
        backgroundColor: isDark.value ? 'rgba(251, 191, 36, 0.7)' : 'rgba(59, 130, 246, 0.6)',
      },
    ],
  }
})

const chartOptions = computed(() => {
  const tickColor = isDark.value ? '#94a3b8' : '#64748b'
  const gridColor = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor }, grid: { color: gridColor } },
      y: { ticks: { color: tickColor }, grid: { color: gridColor } },
    },
  }
})

const tagChartData = computed(() => {
  if (!result.value || result.value.byTag.length === 0) return null
  return {
    labels: result.value.byTag.map((t) => t.tag),
    datasets: [
      {
        label: 'Summe',
        data: result.value.byTag.map((t) => Number(t.sum)),
        backgroundColor: isDark.value ? 'rgba(52, 211, 153, 0.7)' : 'rgba(16, 185, 129, 0.6)',
      },
    ],
  }
})

const tagChartOptions = computed(() => {
  const tickColor = isDark.value ? '#94a3b8' : '#64748b'
  const gridColor = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  return {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor }, grid: { color: gridColor } },
      y: {
        ticks: { color: tickColor, autoSkip: false },
        grid: { color: gridColor },
      },
    },
  }
})
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Analyse</h1>
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>

    <!-- Saved Analyses / Finanz-Rückblicke -->
    <section class="card">
      <div class="saved-header">
        <h2>Finanz-Rückblicke</h2>
        <div class="saved-filter">
          <Button
            :outlined="savedFilter !== 'all'"
            size="small"
            label="Alle"
            @click="savedFilter = 'all'; loadSaved()"
          />
          <Button
            :outlined="savedFilter !== 'user'"
            size="small"
            label="Eigene"
            @click="savedFilter = 'user'; loadSaved()"
          />
          <Button
            :outlined="savedFilter !== 'ai'"
            size="small"
            label="KI"
            @click="savedFilter = 'ai'; loadSaved()"
          />
        </div>
      </div>

      <div v-if="savedLoading && savedItems.length === 0" class="saved-loading">
        <ProgressSpinner style="width: 2rem; height: 2rem" />
      </div>
      <p v-else-if="savedItems.length === 0" class="hint">
        Noch keine gespeicherten Analysen. Stelle eine Frage und speichere das Ergebnis.
      </p>
      <div v-else class="saved-grid">
        <div
          v-for="item in savedItems"
          :key="item.id"
          class="saved-card"
          :class="{
            active: activeItemId === item.id,
            unseen: item.source === 'ai' && !item.seenAt,
          }"
          @click="runSavedItem(item)"
        >
          <div class="saved-card-header">
            <span class="saved-card-name">{{ item.name }}</span>
            <span class="saved-card-badge" v-if="item.source === 'ai'">KI</span>
          </div>
          <div class="saved-card-meta">
            <span v-if="item.summary" class="saved-card-sum">
              {{ formatCurrency(item.summary.sum) }}
            </span>
            <span v-if="item.summary" class="saved-card-count">
              {{ item.summary.count }} Buchungen
            </span>
          </div>
          <div class="saved-card-footer">
            <span class="saved-card-date">{{ formatRelativeDate(item.createdAt) }}</span>
            <Button
              icon="pi pi-trash"
              text
              rounded
              size="small"
              severity="danger"
              class="saved-card-delete"
              @click.stop="removeSavedItem(item)"
            />
          </div>
        </div>
      </div>
      <div v-if="savedHasMore" class="saved-more">
        <Button label="Ältere laden" text size="small" :loading="savedLoading" @click="loadMore" />
      </div>
    </section>

    <section class="card">
      <label>
        <span>Frage</span>
        <div class="question-row">
          <InputText
            v-model="question"
            placeholder="z. B. Was habe ich im Italien-Urlaub 2024 ausgegeben?"
            class="flex-1"
            @keydown.enter="submitQuestion"
          />
          <Button
            icon="pi pi-search"
            :loading="parsing"
            :disabled="!question.trim()"
            @click="submitQuestion"
          />
        </div>
      </label>
    </section>

    <section v-if="result" class="card">
      <div class="result-header">
        <h2>Erkannt</h2>
        <Button
          icon="pi pi-bookmark"
          label="Speichern"
          text
          size="small"
          @click="openSaveDialog"
        />
      </div>

      <div class="ast-row">
        <span class="ast-label">Tags</span>
        <AutoComplete
          v-model="astEditable.tags"
          :suggestions="tagSuggestions"
          @complete="searchTags"
          multiple
          typeahead
          class="flex-1"
        />
      </div>

      <div class="ast-row">
        <span class="ast-label">Operator</span>
        <div class="op-options">
          <div class="op-option">
            <RadioButton v-model="astEditable.op" inputId="op-and" value="AND" />
            <label for="op-and">AND</label>
          </div>
          <div class="op-option">
            <RadioButton v-model="astEditable.op" inputId="op-or" value="OR" />
            <label for="op-or">OR</label>
          </div>
        </div>
      </div>

      <div class="ast-row">
        <span class="ast-label">Art</span>
        <div class="op-options">
          <div class="op-option">
            <RadioButton v-model="astEditable.kind" inputId="kind-ongoing" value="ongoing" />
            <label for="kind-ongoing">Fortlaufend</label>
          </div>
          <div class="op-option">
            <RadioButton v-model="astEditable.kind" inputId="kind-event" value="event" />
            <label for="kind-event">Ereignis</label>
          </div>
        </div>
      </div>

      <div class="ast-row">
        <span class="ast-label">Zeitraum</span>
        <DatePicker v-model="fromDate" date-format="yy-mm-dd" placeholder="Von" show-button-bar />
        <DatePicker v-model="toDate" date-format="yy-mm-dd" placeholder="Bis" show-button-bar />
      </div>

      <div class="actions">
        <Button label="Aktualisieren" :loading="aggregating" @click="reaggregate" />
      </div>
    </section>

    <section v-if="result" class="card">
      <h2>Ergebnis</h2>
      <div class="summary">
        <div class="stat">
          <span class="label">Summe</span>
          <span class="value">{{ formatCurrency(result.total.sum) }}</span>
        </div>
        <div class="stat">
          <span class="label">Anzahl</span>
          <span class="value">{{ result.total.count }}</span>
        </div>
        <div class="stat">
          <span class="label">Durchschnitt</span>
          <span class="value">{{ formatCurrency(result.total.avg) }}</span>
        </div>
      </div>

      <template v-if="showMonthly">
        <h3 class="subhead">Monatsverlauf</h3>
        <div v-if="chartData && result.byMonth.length > 0" class="chart-wrap">
          <Chart type="bar" :data="chartData" :options="chartOptions" />
        </div>
        <p v-else class="hint">Keine Buchungen im gewählten Zeitraum.</p>
      </template>
    </section>

    <section v-if="result && result.byTag.length > 0" class="card">
      <h2>Aufschlüsselung nach Tag</h2>
      <div
        v-if="tagChartData"
        class="chart-wrap"
        :style="{ height: `${Math.max(8, result.byTag.length * 2)}rem` }"
      >
        <Chart type="bar" :data="tagChartData" :options="tagChartOptions" />
      </div>
      <DataTable
        :value="result.byTag"
        stripedRows
        rowHover
        class="clickable-rows"
        @row-click="onTagRowClick"
      >
        <Column field="tag" header="Tag" />
        <Column
          header="Summe"
          headerStyle="text-align:right"
          bodyStyle="text-align:right"
        >
          <template #body="{ data }">
            <span class="num">{{ formatCurrency(data.sum) }}</span>
          </template>
        </Column>
        <Column
          field="count"
          header="Anzahl"
          headerStyle="text-align:right"
          bodyStyle="text-align:right"
        >
          <template #body="{ data }">
            <span class="num">{{ data.count }}</span>
          </template>
        </Column>
      </DataTable>
    </section>

    <section v-if="result && result.topCounterparties.length > 0" class="card">
      <h2>Top Gegenseiten</h2>
      <DataTable :value="result.topCounterparties" stripedRows>
        <Column field="name" header="Gegenseite" />
        <Column header="Summe">
          <template #body="{ data }">{{ formatCurrency(data.sum) }}</template>
        </Column>
        <Column field="count" header="Anzahl" />
      </DataTable>
    </section>

    <!-- Tag drill-down dialog -->
    <Dialog
      v-model:visible="detailVisible"
      modal
      dismissableMask
      :header="`Buchungen · ${detailTag}`"
      :style="{ width: '46rem', maxWidth: '95vw' }"
    >
      <div v-if="detailLoading" class="detail-loading">
        <ProgressSpinner style="width: 2.5rem; height: 2.5rem" />
      </div>
      <Message v-else-if="detailError" severity="error">{{ detailError }}</Message>
      <p v-else-if="detailRows.length === 0" class="hint">Keine Buchungen.</p>
      <DataTable v-else :value="detailRows" stripedRows scrollable scrollHeight="60vh">
        <Column header="Datum">
          <template #body="{ data }">
            <span class="num">{{ formatDate(data.bookingDate) }}</span>
          </template>
        </Column>
        <Column field="counterparty" header="Gegenseite">
          <template #body="{ data }">{{ data.counterparty || '—' }}</template>
        </Column>
        <Column field="purpose" header="Verwendung">
          <template #body="{ data }">
            <span class="purpose">{{ data.purpose || '—' }}</span>
          </template>
        </Column>
        <Column
          header="Betrag"
          headerStyle="text-align:right"
          bodyStyle="text-align:right"
        >
          <template #body="{ data }">
            <span class="num">{{ formatCurrency(data.amount) }}</span>
          </template>
        </Column>
      </DataTable>
    </Dialog>

    <!-- Save dialog -->
    <Dialog
      v-model:visible="saveDialogVisible"
      modal
      header="Analyse speichern"
      :style="{ width: '24rem', maxWidth: '90vw' }"
    >
      <div class="save-dialog-body">
        <label>
          <span>Name</span>
          <InputText
            v-model="saveName"
            placeholder="z. B. Italien-Urlaub 2024"
            class="full-width"
            @keydown.enter="doSave"
          />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="saveDialogVisible = false" />
        <Button label="Speichern" :loading="saving" :disabled="!saveName.trim()" @click="doSave" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 64rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .card {
    padding: 0.75rem;
  }
}
.page-header h1 {
  margin: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.card h2 {
  margin: 0;
  font-size: 1rem;
}
.subhead {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.card label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.question-row {
  display: flex;
  gap: 0.5rem;
}
.flex-1 {
  flex: 1;
}
.ast-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.ast-label {
  min-width: 6rem;
  color: var(--p-text-muted-color);
}
.op-options {
  display: flex;
  gap: 1rem;
}
.op-option {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.summary {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.stat .label {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.stat .value {
  font-size: 1.25rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.chart-wrap {
  height: 16rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
}
.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.clickable-rows :deep(tbody tr) {
  cursor: pointer;
}
.detail-loading {
  display: flex;
  justify-content: center;
  padding: 1.5rem;
}
.purpose {
  display: block;
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- Saved analyses / Rückblicke --- */
.saved-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.saved-filter {
  display: flex;
  gap: 0.25rem;
}
.saved-loading {
  display: flex;
  justify-content: center;
  padding: 1rem;
}
.saved-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.75rem;
}
.saved-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.75rem;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.saved-card:hover {
  border-color: var(--p-primary-color);
}
.saved-card.active {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 1px var(--p-primary-color);
}
.saved-card.unseen {
  border-left: 3px solid var(--p-primary-color);
}
.saved-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.saved-card-name {
  font-weight: 600;
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.saved-card-badge {
  font-size: 0.625rem;
  text-transform: uppercase;
  font-weight: 700;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}
.saved-card-meta {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-variant-numeric: tabular-nums;
}
.saved-card-sum {
  font-size: 1rem;
  font-weight: 600;
}
.saved-card-count {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.saved-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.saved-card-date {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.saved-card-delete {
  opacity: 0;
  transition: opacity 0.15s;
}
.saved-card:hover .saved-card-delete {
  opacity: 1;
}
.saved-more {
  display: flex;
  justify-content: center;
}

/* Result header with save button */
.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Save dialog */
.save-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.save-dialog-body label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.full-width {
  width: 100%;
}
</style>
