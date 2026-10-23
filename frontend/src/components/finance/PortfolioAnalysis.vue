<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Chart from 'primevue/chart'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import ErrorBanner from '../layout/ErrorBanner.vue'
import ScrollX from '../layout/ScrollX.vue'
import { useMediaQuery } from '../../composables/useBreakpoint'
import {
  getPortfolioAnalysis,
  savePortfolioSettings,
  type AllocationSlice,
  type PortfolioAnalysisGroup,
  type PortfolioAnalysisResponse,
} from '../../api/finance'
import {
  formatCurrency,
  formatIsoDate,
  formatPercent,
  SAVINGS_PLAN_INTERVAL_LABELS,
} from '../../utils/financeFormat'

/**
 * Allocation, income over time and savings plans of the depots in scope
 * (#1700). Depots of different currencies come as separate groups and are
 * never added up; the view by currency is the one place they meet, and it
 * stays nominal.
 *
 * The threshold above which a position is flagged is the user's setting,
 * edited right here and kept on the server.
 */

const props = defineProps<{
  accounts: number[]
  closed: boolean
}>()

const router = useRouter()

const data = ref<PortfolioAnalysisResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let request = 0

async function load() {
  const id = ++request
  loading.value = true
  error.value = null
  try {
    const res = await getPortfolioAnalysis({ accounts: props.accounts, closed: props.closed })
    if (id !== request) return
    data.value = res
    threshold.value = res.concentration_threshold_pct
  } catch (e: any) {
    if (id !== request) return
    error.value = e?.message ?? 'Analyse konnte nicht geladen werden'
  } finally {
    if (id === request) loading.value = false
  }
}

onMounted(load)
watch(() => `${props.accounts.join(',')}|${props.closed}`, () => void load())

const groups = computed<PortfolioAnalysisGroup[]>(() => data.value?.groups ?? [])
const mixed = computed(() => data.value?.mixed_currency === true)

// ── Allocation ───────────────────────────────────────────────────────
const VIEWS = [
  { label: 'Wertpapier', value: 'security' },
  { label: 'Art', value: 'type' },
  { label: 'Währung', value: 'currency' },
] as const
const view = ref<'security' | 'type' | 'currency'>('security')

function slicesOf(g: PortfolioAnalysisGroup): AllocationSlice[] {
  return view.value === 'type' ? g.by_type : g.by_security
}

/** Value per currency of the position: with one currency a share, with several only the sums. */
const currencySlices = computed(() => {
  const rows = data.value?.by_currency ?? []
  const total = rows.reduce((s, r) => s + Number(r.value), 0)
  return rows.map((r) => ({
    ...r,
    weight_pct: rows.length === 1 && total > 0 ? ((Number(r.value) / total) * 100).toFixed(2) : null,
  }))
})

const threshold = ref<number | null>(null)
const savingThreshold = ref(false)
const thresholdError = ref<string | null>(null)

async function saveThreshold() {
  const value = threshold.value
  if (value === null || value === data.value?.concentration_threshold_pct) return
  savingThreshold.value = true
  thresholdError.value = null
  try {
    await savePortfolioSettings({ concentration_threshold_pct: value })
    await load()
  } catch (e: any) {
    thresholdError.value = e?.message ?? 'Schwelle konnte nicht gespeichert werden'
  } finally {
    savingThreshold.value = false
  }
}

function openPosition(key: string) {
  void router.push({
    name: 'finance-portfolio-position',
    params: { key },
    query: {
      ...(props.accounts.length > 0 ? { accounts: props.accounts.join(',') } : {}),
      ...(props.closed ? { closedDepots: '1' } : {}),
    },
  })
}

// ── Income ───────────────────────────────────────────────────────────
const incomeViews = [
  { label: 'Monate', value: 'month' },
  { label: 'Jahre', value: 'year' },
]
const incomeView = ref<'month' | 'year'>('month')
/** The bar chart shows at most this many months; the years cover the rest. */
const MONTHS_SHOWN = 36
const isDark = useMediaQuery('(prefers-color-scheme: dark)')

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

function incomeChart(g: PortfolioAnalysisGroup) {
  const rows =
    incomeView.value === 'month'
      ? g.income.months.slice(-MONTHS_SHOWN).map((m) => ({
          label: `${MONTH_NAMES[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(2, 4)}`,
          value: Number(m.income),
        }))
      : g.income.years.map((y) => ({ label: String(y.year), value: Number(y.income) }))
  const pos = isDark.value ? '#4ade80' : '#16a34a'
  const neg = isDark.value ? '#f87171' : '#dc2626'
  return {
    labels: rows.map((r) => r.label),
    datasets: [
      {
        label: 'Erträge netto',
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r) => (r.value < 0 ? neg : pos)),
        borderRadius: 3,
      },
    ],
  }
}

function incomeOptions(g: PortfolioAnalysisGroup) {
  const tick = isDark.value ? '#94a3b8' : '#64748b'
  const grid = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: g.currency })
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx: { parsed: { y: number } }) => money.format(ctx.parsed.y) } },
    },
    scales: {
      x: { ticks: { color: tick, maxRotation: 0, autoSkip: true, autoSkipPadding: 8 }, grid: { display: false } },
      y: {
        ticks: { color: tick, callback: (v: number | string) => money.format(typeof v === 'number' ? v : Number(v)) },
        grid: { color: grid },
      },
    },
  }
}

// ── Savings plans ────────────────────────────────────────────────────
const plans = computed(() => data.value?.savings_plans ?? [])

const hasAnything = computed(
  () => groups.value.length > 0 || plans.value.length > 0,
)
</script>

<template>
  <div class="pa">
    <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />

    <template v-if="data && hasAnything">
      <!-- ── Allocation ────────────────────────────────────────────── -->
      <section class="pa-section" aria-labelledby="pa-allocation-heading">
        <div class="pa-head">
          <h2 id="pa-allocation-heading">Allokation</h2>
          <SelectButton
            v-model="view"
            :options="[...VIEWS]"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            aria-label="Aufteilen nach"
          />
        </div>

        <template v-if="view === 'currency'">
          <p v-if="currencySlices.length > 1" class="pa-muted">
            Mehrere Währungen: die Werte stehen je Währung für sich, umgerechnet oder addiert wird nichts.
          </p>
          <ul class="pa-bars" aria-label="Nach Währung">
            <li v-for="c in currencySlices" :key="c.currency" class="pa-bar-row">
              <span class="pa-bar-label">{{ c.currency }}</span>
              <span class="pa-bar-track" aria-hidden="true">
                <span class="pa-bar-fill" :style="{ width: `${c.weight_pct ?? 100}%` }" />
              </span>
              <span class="pa-bar-pct">{{ c.weight_pct === null ? '' : formatPercent(c.weight_pct) }}</span>
              <span class="pa-bar-value">{{ formatCurrency(c.value, c.currency) }}</span>
            </li>
          </ul>
        </template>

        <template v-else>
          <div v-for="g in groups" :key="g.currency" class="pa-group">
            <h3 v-if="mixed" class="pa-sub">{{ g.currency }} · {{ formatCurrency(g.market_value, g.currency) }}</h3>
            <Message v-if="g.concentrated.length > 0" severity="warn" :closable="false">
              {{ g.concentrated.map((s) => `${s.label} (${formatPercent(s.weight_pct)})`).join(', ') }}
              {{ g.concentrated.length === 1 ? 'liegt' : 'liegen' }} über {{ formatPercent(data.concentration_threshold_pct, 0) }} des Depotwerts.
            </Message>
            <ul class="pa-bars" :aria-label="view === 'type' ? 'Nach Art' : 'Nach Wertpapier'">
              <li v-for="s in slicesOf(g)" :key="s.key" class="pa-bar-row">
                <button
                  v-if="view === 'security'"
                  type="button"
                  class="pa-bar-label pa-link"
                  :class="{ 'pa-concentrated': g.concentrated.some((c) => c.key === s.key) }"
                  @click="openPosition(s.key)"
                >{{ s.label }}</button>
                <span v-else class="pa-bar-label">
                  {{ s.label }} <span class="pa-muted-inline">· {{ s.positions }}</span>
                </span>
                <span class="pa-bar-track" aria-hidden="true">
                  <span
                    class="pa-bar-fill"
                    :class="{ 'pa-bar-warn': view === 'security' && g.concentrated.some((c) => c.key === s.key) }"
                    :style="{ width: `${Number(s.weight_pct)}%` }"
                  />
                </span>
                <span class="pa-bar-pct">{{ formatPercent(s.weight_pct) }}</span>
                <span class="pa-bar-value">{{ formatCurrency(s.value, g.currency) }}</span>
              </li>
            </ul>
            <p v-if="g.unvalued_positions > 0" class="pa-muted">
              {{ g.unvalued_positions }} offene Position{{ g.unvalued_positions === 1 ? '' : 'en' }} ohne Kurs fehlen in der Aufteilung.
            </p>
          </div>
          <p v-if="view === 'type'" class="pa-muted">Die Art nennt der Kursanbieter; „Unbekannt“, solange er das Papier nicht kennt.</p>
        </template>

        <div class="pa-threshold">
          <label for="pa-threshold-input">Hinweis, wenn eine Position mehr als</label>
          <InputNumber
            v-model="threshold"
            input-id="pa-threshold-input"
            :min="1"
            :max="100"
            suffix=" %"
            :disabled="savingThreshold"
            size="small"
            class="pa-threshold-input"
            @blur="saveThreshold"
            @keydown.enter="saveThreshold"
          />
          <span>des Depotwerts ausmacht.</span>
          <span v-if="thresholdError" class="pa-error">{{ thresholdError }}</span>
        </div>
      </section>

      <!-- ── Income ────────────────────────────────────────────────── -->
      <section
        v-if="groups.some((g) => g.income.months.length > 0)"
        class="pa-section"
        aria-labelledby="pa-income-heading"
      >
        <div class="pa-head">
          <h2 id="pa-income-heading">Erträge</h2>
          <SelectButton
            v-model="incomeView"
            :options="incomeViews"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            aria-label="Erträge je Monat oder Jahr"
          />
        </div>
        <div v-for="g in groups.filter((x) => x.income.months.length > 0)" :key="g.currency" class="pa-group">
          <h3 v-if="mixed" class="pa-sub">{{ g.currency }}</h3>
          <div class="pa-kpis">
            <div class="pa-kpi">
              <span class="pa-kpi-label">Letzte 12 Monate</span>
              <span class="pa-kpi-value">{{ formatCurrency(g.income.ttm, g.currency) }}</span>
              <span class="pa-kpi-sub">seit {{ formatIsoDate(g.income.ttm_from) }}, netto</span>
            </div>
            <div class="pa-kpi">
              <span class="pa-kpi-label">Ausschüttungs&shy;rendite</span>
              <span class="pa-kpi-value">{{ formatPercent(g.income.current_yield_pct, 2) }}</span>
              <span class="pa-kpi-sub">auf den heutigen Wert</span>
            </div>
            <div class="pa-kpi">
              <span class="pa-kpi-label">Rendite auf Einstand</span>
              <span class="pa-kpi-value">{{ formatPercent(g.income.yield_on_cost_pct, 2) }}</span>
              <span class="pa-kpi-sub">
                {{ g.income.yield_on_cost_pct === null ? 'Einstand nicht für jede Position bekannt' : 'auf das, was die Positionen gekostet haben' }}
              </span>
            </div>
          </div>
          <div class="pa-chart-wrap">
            <Chart type="bar" :data="incomeChart(g)" :options="incomeOptions(g)" class="pa-chart" />
          </div>
          <p class="pa-muted">
            Dividenden und Ausschüttungen netto nach Steuern; Steuern auf thesaurierte Erträge mindern sie.
            <template v-if="incomeView === 'month' && g.income.months.length > MONTHS_SHOWN">Gezeigt sind die letzten {{ MONTHS_SHOWN }} Monate.</template>
          </p>
        </div>
      </section>

      <!-- ── Savings plans ─────────────────────────────────────────── -->
      <section v-if="plans.length > 0" class="pa-section" aria-labelledby="pa-plans-heading">
        <h2 id="pa-plans-heading">Sparpläne</h2>
        <ScrollX>
          <table class="pa-table">
            <thead>
              <tr>
                <th>Wertpapier</th>
                <th>Depot</th>
                <th>Rhythmus</th>
                <th class="pa-num">Rate</th>
                <th class="pa-num">Ausführungen</th>
                <th>Zeitraum</th>
                <th>Nächste</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in plans"
                :key="`${p.account_id}|${p.key}|${p.first}`"
                class="pa-row"
                :class="{ 'pa-row-inactive': !p.active }"
                tabindex="0"
                role="link"
                :aria-label="`${p.name ?? p.key} öffnen`"
                @click="openPosition(p.key)"
                @keydown.enter.prevent="openPosition(p.key)"
                @keydown.space.prevent="openPosition(p.key)"
              >
                <td>{{ p.name ?? p.key }}</td>
                <td>{{ p.account_label }}</td>
                <td>{{ SAVINGS_PLAN_INTERVAL_LABELS[p.interval] ?? p.interval }}</td>
                <td class="pa-num">{{ formatCurrency(p.amount, p.currency) }}</td>
                <td class="pa-num">{{ p.executions }}</td>
                <td>{{ formatIsoDate(p.first) }} – {{ formatIsoDate(p.last) }}</td>
                <td>{{ p.active ? formatIsoDate(p.next) : 'ruht' }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
        <p class="pa-muted">
          Erkannt an mindestens drei Käufen desselben Papiers im selben Depot in festem Rhythmus und mit gleichbleibender Rate (±15 %).
          „Ruht“: die nächste Ausführung ist länger als einen halben Rhythmus überfällig.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.pa {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pa-section,
.pa-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pa-section h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--p-text-color);
}
.pa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.pa-sub {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}
.pa-muted {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pa-muted-inline {
  color: var(--p-text-muted-color);
}
.pa-bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.pa-bar-row {
  display: grid;
  grid-template-columns: minmax(8rem, 16rem) 1fr 4.5rem 8rem;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.pa-bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.pa-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--p-text-color);
  cursor: pointer;
}
.pa-link:hover {
  color: var(--p-primary-color);
}
.pa-link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pa-concentrated {
  font-weight: 600;
}
.pa-bar-track {
  height: 0.6rem;
  border-radius: 0.3rem;
  background: var(--p-content-hover-background);
  overflow: hidden;
}
.pa-bar-fill {
  display: block;
  height: 100%;
  border-radius: 0.3rem;
  background: var(--p-primary-color);
}
.pa-bar-warn {
  background: var(--p-yellow-500);
}
.pa-bar-pct,
.pa-bar-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pa-threshold {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pa-threshold-input :deep(input) {
  width: 5rem;
}
.pa-error {
  color: var(--p-red-600);
}
.pa-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2);
}
.pa-kpi {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: var(--space-2) var(--space-3);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  min-width: 0;
}
.pa-kpi-label {
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--p-text-muted-color);
  overflow-wrap: anywhere;
}
.pa-kpi-value {
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.pa-kpi-sub {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pa-chart-wrap {
  height: 14rem;
  padding: var(--space-2);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}
.pa-chart {
  height: 100%;
}
.pa-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
}
.pa-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.4rem 0.6rem;
  border-bottom: 2px solid var(--p-content-border-color);
  white-space: nowrap;
}
.pa-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.pa-num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.pa-row {
  cursor: pointer;
}
.pa-row:hover {
  background: var(--p-content-hover-background);
}
.pa-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.pa-row-inactive td {
  color: var(--p-text-muted-color);
}
@media (max-width: 639px) {
  .pa-bar-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'label pct'
      'track value';
    row-gap: 0.15rem;
  }
  .pa-bar-label {
    grid-area: label;
  }
  .pa-bar-pct {
    grid-area: pct;
  }
  .pa-bar-track {
    grid-area: track;
    align-self: center;
  }
  .pa-bar-value {
    grid-area: value;
  }
}
</style>
