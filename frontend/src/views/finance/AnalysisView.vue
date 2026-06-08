<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import RadioButton from 'primevue/radiobutton'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import AutoComplete from 'primevue/autocomplete'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Chart from 'primevue/chart'
import Dialog from 'primevue/dialog'
import Tag from 'primevue/tag'
import ProgressSpinner from 'primevue/progressspinner'
import { toLocalIsoDate, parseLocalDate } from '../../utils/dateFormat'
import {
  analysisAggregate,
  analysisQuery,
  analysisTransactions,
  analysisPeriodTransactions,
  listSavedAnalyses,
  saveAnalysis,
  deleteSavedAnalysis,
  updateSavedAnalysis,
  markSavedAnalysesSeen,
  type AnalysisAst,
  type AnalysisResult,
  type AnalysisTransaction,
  type RelativeTimespan,
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

// --- Tag groups (replaces flat tags + op) ---
interface EditableTagGroup {
  tags: string[]
  op: 'AND' | 'OR'
}
const tagGroups = ref<EditableTagGroup[]>([{ tags: [], op: 'AND' }])
const groupOp = ref<'AND' | 'OR'>('AND')

function addGroup() {
  tagGroups.value.push({ tags: [], op: 'OR' })
}

function removeGroup(index: number) {
  tagGroups.value.splice(index, 1)
  if (tagGroups.value.length === 0) tagGroups.value.push({ tags: [], op: 'AND' })
}

function toggleGroupOp(index: number) {
  const g = tagGroups.value[index]
  if (g) g.op = g.op === 'AND' ? 'OR' : 'AND'
}

// --- Kind / Interval ---
const editableKind = ref<'ongoing' | 'event'>('ongoing')
const editableInterval = ref<'month' | 'year'>('month')
const showMonthly = computed(() => editableKind.value !== 'event')

// --- Timespan (manual relative) ---
const timespanMode = ref<string>('custom')
const relativeN = ref(6)
const fromDate = ref<Date | null>(null)
const toDate = ref<Date | null>(null)

const timespanOptions = [
  { label: 'Benutzerdefiniert', value: 'custom' },
  { label: 'Dieser Monat', value: 'this_month' },
  { label: 'Letzter Monat', value: 'last_month' },
  { label: 'Dieses Jahr', value: 'this_year' },
  { label: 'Letztes Jahr', value: 'last_year' },
  { label: 'Letzte N Monate', value: 'last_n_months' },
  { label: 'Letzte N Jahre', value: 'last_n_years' },
]

function resolveRelativeLocal(rt: RelativeTimespan): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (yr: number, mo: number, day: number) => `${yr}-${pad(mo)}-${pad(day)}`
  const lastDay = (yr: number, mo: number) => new Date(yr, mo, 0).getDate()
  switch (rt.type) {
    case 'this_year': return { from: iso(y, 1, 1), to: iso(y, 12, 31) }
    case 'last_year': return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) }
    case 'last_n_years': { const n = rt.n ?? 1; return { from: iso(y - n, 1, 1), to: iso(y, 12, 31) } }
    case 'last_n_months': {
      const n = rt.n ?? 1
      const d = new Date(y, m - n, 1)
      return { from: iso(d.getFullYear(), d.getMonth() + 1, 1), to: iso(y, m + 1, lastDay(y, m + 1)) }
    }
    case 'this_month': return { from: iso(y, m + 1, 1), to: iso(y, m + 1, lastDay(y, m + 1)) }
    case 'last_month': {
      const d = new Date(y, m - 1, 1)
      const mo = d.getMonth() + 1
      const yr = d.getFullYear()
      return { from: iso(yr, mo, 1), to: iso(yr, mo, lastDay(yr, mo)) }
    }
    default: return { from: iso(y, 1, 1), to: iso(y, 12, 31) }
  }
}

function buildRelativeTimespan(): RelativeTimespan | undefined {
  if (timespanMode.value === 'custom') return undefined
  const t = timespanMode.value as RelativeTimespan['type']
  if (t === 'last_n_months' || t === 'last_n_years') {
    return { type: t, n: relativeN.value }
  }
  return { type: t }
}

const activeRelativeTimespan = computed(() => buildRelativeTimespan())

const resolvedTimespanText = computed(() => {
  const rt = activeRelativeTimespan.value
  if (!rt) return ''
  const { from, to } = resolveRelativeLocal(rt)
  return `${parseLocalDate(from).toLocaleDateString('de-DE')} – ${parseLocalDate(to).toLocaleDateString('de-DE')}`
})

const activeRelativeLabel = computed(() => {
  const rt = activeRelativeTimespan.value
  return rt ? relativeTimespanLabel(rt) : ''
})

function onTimespanModeChange() {
  if (timespanMode.value !== 'custom') {
    const rt = buildRelativeTimespan()
    if (rt) {
      const { from, to } = resolveRelativeLocal(rt)
      fromDate.value = parseLocalDate(from)
      toDate.value = parseLocalDate(to)
    }
  }
}

watch(timespanMode, onTimespanModeChange)
watch(relativeN, () => {
  if (timespanMode.value === 'last_n_months' || timespanMode.value === 'last_n_years') {
    onTimespanModeChange()
  }
})

function relativeTimespanLabel(rt: RelativeTimespan): string {
  switch (rt.type) {
    case 'this_year': return 'Dieses Jahr'
    case 'last_year': return 'Letztes Jahr'
    case 'this_month': return 'Dieser Monat'
    case 'last_month': return 'Letzter Monat'
    case 'last_n_years': return `Letzte ${rt.n} Jahre`
    case 'last_n_months': return `Letzte ${rt.n} Monate`
    default: return String(rt.type)
  }
}

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
    await updateSavedAnalysis({ id: item.id, summary: resp.total }).catch(() => {})
    const idx = savedItems.value.findIndex((s) => s.id === item.id)
    if (idx >= 0) {
      savedItems.value[idx] = Object.assign({}, savedItems.value[idx], { summary: resp.total })
    }
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

function buildAstFromEditor(): AnalysisAst {
  const ast: AnalysisAst = {
    tags: [],
    op: 'AND',
    kind: editableKind.value,
  }
  if (editableKind.value === 'ongoing' && editableInterval.value) {
    ast.interval = editableInterval.value
  }

  // Tag groups
  const nonEmpty = tagGroups.value.filter((g) => g.tags.length > 0)
  const firstGroup = nonEmpty[0]
  if (nonEmpty.length === 1 && firstGroup) {
    ast.tags = [...firstGroup.tags]
    ast.op = firstGroup.op
  } else if (nonEmpty.length > 1) {
    ast.tagGroups = nonEmpty.map((g) => ({ tags: [...g.tags], op: g.op }))
    ast.groupOp = groupOp.value
    ast.tags = nonEmpty.flatMap((g) => g.tags)
    ast.op = groupOp.value
  }

  // Timespan
  const rt = buildRelativeTimespan()
  if (rt) {
    ast.relativeTimespan = rt
  } else {
    const from = toIso(fromDate.value)
    const to = toIso(toDate.value)
    if (from && to) ast.timespan = { from, to }
  }

  return ast
}

async function reaggregate() {
  aggregating.value = true
  error.value = null
  try {
    const ast = buildAstFromEditor()
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
  editableKind.value = r.ast.kind ?? 'ongoing'
  editableInterval.value = r.ast.interval ?? 'month'

  // Tag groups
  if (r.ast.tagGroups && r.ast.tagGroups.length > 0) {
    tagGroups.value = r.ast.tagGroups.map((g) => ({ tags: [...g.tags], op: g.op }))
    groupOp.value = r.ast.groupOp ?? 'AND'
  } else {
    tagGroups.value = [{ tags: [...r.ast.tags], op: r.ast.op }]
    groupOp.value = 'AND'
  }

  // Timespan
  if (r.ast.relativeTimespan) {
    timespanMode.value = r.ast.relativeTimespan.type
    if (r.ast.relativeTimespan.n) relativeN.value = r.ast.relativeTimespan.n
  } else {
    timespanMode.value = 'custom'
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

// --- Drill-down: transactions behind a single period row ---
const periodDetailVisible = ref(false)
const periodDetailLabel = ref('')
const periodDetailLoading = ref(false)
const periodDetailError = ref<string | null>(null)
const periodDetailRows = ref<AnalysisTransaction[]>([])

async function openPeriodDetails(period: string) {
  if (!result.value) return
  periodDetailLabel.value = period
  periodDetailVisible.value = true
  periodDetailLoading.value = true
  periodDetailError.value = null
  periodDetailRows.value = []
  try {
    const resp = await analysisPeriodTransactions({ ast: result.value.ast, period })
    periodDetailRows.value = resp.transactions
  } catch (err) {
    periodDetailError.value = err instanceof Error ? err.message : String(err)
  } finally {
    periodDetailLoading.value = false
  }
}

function onPeriodRowClick(event: { data: { period: string } }) {
  openPeriodDetails(event.data.period)
}

const periodLabel = computed(() => {
  return editableInterval.value === 'year' ? 'Jahresverlauf' : 'Monatsverlauf'
})

const chartData = computed(() => {
  if (!result.value) return null
  return {
    labels: result.value.byPeriod.map((p) => p.period),
    datasets: [
      {
        label: 'Summe',
        data: result.value.byPeriod.map((p) => Number(p.sum)),
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

      <!-- Tag groups -->
      <div class="tag-groups">
        <div v-for="(group, gi) in tagGroups" :key="gi" class="tag-group-row">
          <div v-if="gi > 0" class="group-connector">
            <span class="connector-op">{{ groupOp }}</span>
          </div>
          <div class="tag-group-content">
            <AutoComplete
              v-model="group.tags"
              :suggestions="tagSuggestions"
              @complete="searchTags"
              multiple
              typeahead
              class="flex-1"
              :placeholder="gi === 0 ? 'Tags auswählen…' : 'Weitere Tags…'"
            />
            <Button
              v-if="group.tags.length > 1"
              :label="group.op"
              size="small"
              :outlined="true"
              :severity="group.op === 'OR' ? 'warn' : 'info'"
              class="group-op-btn"
              @click="toggleGroupOp(gi)"
            />
            <Button
              v-if="tagGroups.length > 1"
              icon="pi pi-times"
              text
              rounded
              size="small"
              severity="secondary"
              @click="removeGroup(gi)"
            />
          </div>
        </div>
        <div class="tag-group-actions">
          <Button label="+ Gruppe" text size="small" icon="pi pi-plus" @click="addGroup" />
          <div v-if="tagGroups.length > 1" class="group-op-toggle">
            <span class="group-op-label">Verknüpfung:</span>
            <div class="op-options">
              <div class="op-option">
                <RadioButton v-model="groupOp" inputId="gop-and" value="AND" />
                <label for="gop-and">AND</label>
              </div>
              <div class="op-option">
                <RadioButton v-model="groupOp" inputId="gop-or" value="OR" />
                <label for="gop-or">OR</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="ast-row">
        <span class="ast-label">Art</span>
        <div class="op-options">
          <div class="op-option">
            <RadioButton v-model="editableKind" inputId="kind-ongoing" value="ongoing" />
            <label for="kind-ongoing">Fortlaufend</label>
          </div>
          <div class="op-option">
            <RadioButton v-model="editableKind" inputId="kind-event" value="event" />
            <label for="kind-event">Ereignis</label>
          </div>
        </div>
      </div>

      <div v-if="editableKind === 'ongoing'" class="ast-row">
        <span class="ast-label">Intervall</span>
        <div class="op-options">
          <div class="op-option">
            <RadioButton v-model="editableInterval" inputId="interval-month" value="month" />
            <label for="interval-month">Monatlich</label>
          </div>
          <div class="op-option">
            <RadioButton v-model="editableInterval" inputId="interval-year" value="year" />
            <label for="interval-year">Jährlich</label>
          </div>
        </div>
      </div>

      <div class="ast-row">
        <span class="ast-label">Zeitraum</span>
        <Select
          v-model="timespanMode"
          :options="timespanOptions"
          optionLabel="label"
          optionValue="value"
          class="timespan-select"
        />
      </div>
      <div v-if="timespanMode === 'last_n_months' || timespanMode === 'last_n_years'" class="ast-row">
        <span class="ast-label"></span>
        <InputNumber v-model="relativeN" :min="1" :max="120" showButtons class="n-input" />
        <span class="relative-hint">{{ timespanMode === 'last_n_months' ? 'Monate' : 'Jahre' }}</span>
      </div>
      <div v-if="timespanMode === 'custom'" class="ast-row">
        <span class="ast-label"></span>
        <DatePicker v-model="fromDate" date-format="yy-mm-dd" placeholder="Von" show-button-bar />
        <DatePicker v-model="toDate" date-format="yy-mm-dd" placeholder="Bis" show-button-bar />
      </div>
      <div v-else class="ast-row">
        <span class="ast-label"></span>
        <Tag
          :value="activeRelativeLabel"
          icon="pi pi-sync"
          severity="info"
        />
        <span class="relative-hint">{{ resolvedTimespanText }}</span>
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
        <h3 class="subhead">{{ periodLabel }}</h3>
        <div v-if="chartData && result.byPeriod.length > 0" class="chart-wrap">
          <Chart type="bar" :data="chartData" :options="chartOptions" />
        </div>
        <p v-else class="hint">Keine Buchungen im gewählten Zeitraum.</p>
        <DataTable
          v-if="result.byPeriod.length > 0"
          :value="result.byPeriod"
          stripedRows
          rowHover
          class="clickable-rows"
          @row-click="onPeriodRowClick"
        >
          <Column field="period" header="Zeitraum" />
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

    <!-- Period drill-down dialog -->
    <Dialog
      v-model:visible="periodDetailVisible"
      modal
      dismissableMask
      :header="`Buchungen · ${periodDetailLabel}`"
      :style="{ width: '46rem', maxWidth: '95vw' }"
    >
      <div v-if="periodDetailLoading" class="detail-loading">
        <ProgressSpinner style="width: 2.5rem; height: 2.5rem" />
      </div>
      <Message v-else-if="periodDetailError" severity="error">{{ periodDetailError }}</Message>
      <p v-else-if="periodDetailRows.length === 0" class="hint">Keine Buchungen.</p>
      <DataTable v-else :value="periodDetailRows" stripedRows scrollable scrollHeight="60vh">
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
.relative-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  font-style: italic;
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

/* --- Tag groups --- */
.tag-groups {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tag-group-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tag-group-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.group-connector {
  display: flex;
  justify-content: center;
  padding: 0.125rem 0;
}
.connector-op {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--p-primary-color);
  letter-spacing: 0.05em;
}
.group-op-btn {
  min-width: 3.5rem;
  font-size: 0.75rem;
}
.tag-group-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 0.25rem;
}
.group-op-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.group-op-label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.timespan-select {
  min-width: 14rem;
}
.n-input {
  max-width: 8rem;
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
