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
import { toLocalIsoDate, parseLocalDate } from '../../utils/dateFormat'
import {
  analysisAggregate,
  analysisQuery,
  type AnalysisAst,
  type AnalysisResult,
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

// Monthly bars only make sense for ongoing/recurring spending. For a
// bounded event (a single trip) they add no insight, so we hide them —
// driven by the AI-detected `kind`, which the user can still override.
const showMonthly = computed(() => astEditable.value.kind !== 'event')

onMounted(async () => {
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  darkMQ.addEventListener('change', onDarkChange)
})

onUnmounted(() => {
  darkMQ.removeEventListener('change', onDarkChange)
})

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
      y: { ticks: { color: tickColor }, grid: { color: gridColor } },
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
      <h2>Erkannt</h2>

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
      <p class="hint">
        Jede gefilterte Buchung zählt in jeden Tag, den sie trägt. Tags aus dem Filter
        sind ausgeblendet.
      </p>
      <div
        v-if="tagChartData"
        class="chart-wrap"
        :style="{ height: `${Math.max(8, result.byTag.length * 2)}rem` }"
      >
        <Chart type="bar" :data="tagChartData" :options="tagChartOptions" />
      </div>
      <DataTable :value="result.byTag" stripedRows>
        <Column field="tag" header="Tag" />
        <Column header="Summe">
          <template #body="{ data }">{{ formatCurrency(data.sum) }}</template>
        </Column>
        <Column field="count" header="Anzahl" />
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
</style>
