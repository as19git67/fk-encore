<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Chart from 'primevue/chart'
import SelectButton from 'primevue/selectbutton'
import ErrorBanner from '../layout/ErrorBanner.vue'
import { useMediaQuery } from '../../composables/useBreakpoint'
import { compactDateLabels, fullDateLabel } from '../../utils/financeChartDates'
import { replaceQuerySlice, updateRouteQuery } from '../../utils/routeQueryUpdate'
import {
  getPortfolioPerformance,
  type PerformanceGroup,
  type PerformancePeriod,
  type PortfolioPerformanceResponse,
} from '../../api/finance'
import { formatCurrency, formatIsoDate, formatSignedCurrency, formatSignedPercent, gainSign } from '../../utils/financeFormat'

/**
 * Performance of the portfolio or of one position over a period (#1700):
 * the time-weighted return (TWR) and the money-weighted return (XIRR),
 * each named as such with the period it covers, and the value over time
 * next to the net invested capital. Days without a valuation stay gaps in
 * the line and are listed below it.
 *
 * The period lives in the URL (`period`), so a reload shows the same.
 * Depots of different currencies come back as separate groups; each is
 * shown on its own, never added up.
 */

const props = defineProps<{
  accounts: number[]
  closed: boolean
  /** Position key: the figures of this security alone. */
  position?: string
}>()

const emit = defineEmits<{ loaded: [PortfolioPerformanceResponse | null] }>()

const route = useRoute()
const router = useRouter()

const PERIODS: Array<{ label: string; value: PerformancePeriod }> = [
  { label: '1M', value: '1M' },
  { label: 'YTD', value: 'YTD' },
  { label: '1J', value: '1Y' },
  { label: '3J', value: '3Y' },
  { label: 'Max', value: 'max' },
]
const PERIOD_NAMES: Record<PerformancePeriod, string> = {
  '1M': 'ein Monat',
  YTD: 'seit Jahresbeginn',
  '1Y': 'ein Jahr',
  '3Y': 'drei Jahre',
  max: 'gesamter Verlauf',
}

const period = computed<PerformancePeriod>({
  get: () => {
    const raw = route.query.period
    return PERIODS.find((p) => p.value === raw)?.value ?? '1Y'
  },
  set: (value) => {
    void updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, ['period'], value === '1Y' ? {} : { period: value }),
    )
  },
})

const data = ref<PortfolioPerformanceResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let request = 0

async function load() {
  const id = ++request
  loading.value = true
  error.value = null
  try {
    const res = await getPortfolioPerformance({
      accounts: props.accounts,
      closed: props.closed,
      period: period.value,
      position: props.position,
    })
    if (id !== request) return
    data.value = res
    emit('loaded', res)
  } catch (e: any) {
    if (id !== request) return
    error.value = e?.message ?? 'Performance konnte nicht geladen werden'
    emit('loaded', null)
  } finally {
    if (id === request) loading.value = false
  }
}

onMounted(load)
watch(
  () => `${props.accounts.join(',')}|${props.closed}|${props.position ?? ''}|${period.value}`,
  () => void load(),
)

const groups = computed<PerformanceGroup[]>(() => data.value?.groups ?? [])

// ── Chart ────────────────────────────────────────────────────────────
const metricOptions = [
  { label: 'Wert', value: 'value' },
  { label: 'Rendite', value: 'twr' },
]
const metric = ref<'value' | 'twr'>('value')
const isDark = useMediaQuery('(prefers-color-scheme: dark)')

function n(raw: string | null): number | null {
  if (raw === null) return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/** Whether the stretch between two points lies in a gap: drawn faint and dashed. */
function inGap(g: PerformanceGroup, a: string, b: string): boolean {
  return g.gaps.some((gap) => gap.from <= b && gap.to >= a)
}

function chartData(g: PerformanceGroup) {
  const points = g.points
  const days = points.map((p) => p.day)
  const lineColor = isDark.value ? '#fbbf24' : '#2563eb'
  const investedColor = isDark.value ? '#94a3b8' : '#64748b'
  const gapColor = isDark.value ? 'rgba(148,163,184,0.5)' : 'rgba(100,116,139,0.5)'
  const segment = {
    borderDash: (ctx: { p0DataIndex: number; p1DataIndex: number }) =>
      inGap(g, days[ctx.p0DataIndex] ?? '', days[ctx.p1DataIndex] ?? '') ? [4, 4] : undefined,
    borderColor: (ctx: { p0DataIndex: number; p1DataIndex: number }) =>
      inGap(g, days[ctx.p0DataIndex] ?? '', days[ctx.p1DataIndex] ?? '') ? gapColor : undefined,
  }
  const datasets =
    metric.value === 'value'
      ? [
          {
            label: 'Depotwert',
            data: points.map((p) => n(p.value)),
            borderColor: lineColor,
            backgroundColor: 'transparent',
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: false,
            segment,
          },
          {
            label: 'Investiertes Kapital',
            data: points.map((p) => n(p.invested)),
            borderColor: investedColor,
            backgroundColor: 'transparent',
            borderDash: [6, 4],
            stepped: true,
            pointRadius: 0,
            pointHitRadius: 8,
          },
        ]
      : [
          {
            label: 'TWR seit Beginn',
            data: points.map((p) => n(p.twr_pct)),
            borderColor: lineColor,
            backgroundColor: 'transparent',
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: false,
            segment,
          },
        ]
  return { labels: compactDateLabels(days), datasets }
}

function chartOptions(g: PerformanceGroup) {
  const tick = isDark.value ? '#94a3b8' : '#64748b'
  const grid = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: g.currency, maximumFractionDigits: 0 })
  const fmt = (v: number) => (metric.value === 'value' ? money.format(v) : formatSignedPercent(v))
  const days = g.points.map((p) => p.day)
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: true, labels: { color: tick, usePointStyle: true, boxWidth: 8 } },
      tooltip: {
        callbacks: {
          title: (ctx: Array<{ dataIndex: number }>) => fullDateLabel(days[ctx[0]?.dataIndex ?? 0] ?? ''),
          label: (ctx: { parsed: { y: number | null }; dataset: { label?: string } }) =>
            `${ctx.dataset.label ?? ''}: ${ctx.parsed.y === null ? 'keine Bewertung' : fmt(ctx.parsed.y)}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: tick, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, grid: { color: grid } },
      y: {
        ticks: { color: tick, callback: (val: number | string) => fmt(typeof val === 'number' ? val : Number(val)) },
        grid: { color: grid },
      },
    },
  }
}

function signClass(val: string | null): string {
  return `gain-${gainSign(val)}`
}

/** "02.01.2026 – 23.10.2026" */
function span(g: PerformanceGroup): string {
  return `${formatIsoDate(g.from)} – ${formatIsoDate(g.to)}`
}

/** Whether the period reaches a year: then the returns are also given per year. */
function perYear(g: PerformanceGroup): boolean {
  return g.twr_pa_pct !== null
}

function gapText(gap: { from: string; to: string }): string {
  return gap.from === gap.to ? formatIsoDate(gap.from) : `${formatIsoDate(gap.from)} – ${formatIsoDate(gap.to)}`
}
</script>

<template>
  <section class="perf" aria-labelledby="perf-heading">
    <div class="perf-head">
      <h2 id="perf-heading">Performance</h2>
      <SelectButton
        v-model="period"
        :options="PERIODS"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        size="small"
        aria-label="Zeitraum"
      />
    </div>

    <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />

    <p v-if="!error && !loading && data && groups.length === 0" class="perf-muted">
      Für diesen Zeitraum liegt keine Bewertung vor.
    </p>

    <p v-if="data?.mixed_currency" class="perf-muted">
      Die Depots führen verschiedene Währungen. Jede Währung wird für sich gerechnet, nichts wird umgerechnet oder addiert.
    </p>

    <div v-for="g in groups" :key="g.currency" class="perf-group" :aria-busy="loading">
      <h3 v-if="data?.mixed_currency" class="perf-currency">{{ g.currency }}</h3>
      <div class="perf-kpis">
        <div class="perf-kpi">
          <span class="perf-kpi-label">Zeitgewichtet (TWR)</span>
          <span class="perf-kpi-value" :class="signClass(g.twr_pct)">{{ formatSignedPercent(g.twr_pct) }}</span>
          <span class="perf-kpi-sub">
            im Zeitraum<template v-if="perYear(g)"> · {{ formatSignedPercent(g.twr_pa_pct) }} p. a.</template>
          </span>
        </div>
        <div class="perf-kpi">
          <span class="perf-kpi-label">Geldgewichtet (XIRR)</span>
          <span class="perf-kpi-value" :class="signClass(perYear(g) ? g.xirr_pct : g.mwr_pct)">
            {{ formatSignedPercent(perYear(g) ? g.xirr_pct : g.mwr_pct) }}
          </span>
          <span class="perf-kpi-sub">
            <template v-if="perYear(g)">p. a. · {{ formatSignedPercent(g.mwr_pct) }} im Zeitraum</template>
            <template v-else>im Zeitraum</template>
          </span>
        </div>
        <div class="perf-kpi">
          <span class="perf-kpi-label">Wertzuwachs</span>
          <span class="perf-kpi-value" :class="signClass(g.gain)">{{ formatSignedCurrency(g.gain, g.currency) }}</span>
          <span class="perf-kpi-sub">inkl. {{ formatCurrency(g.income, g.currency) }} Erträge</span>
        </div>
        <div class="perf-kpi">
          <span class="perf-kpi-label">Wert</span>
          <span class="perf-kpi-value">{{ formatCurrency(g.end_value, g.currency) }}</span>
          <span class="perf-kpi-sub">
            vorher {{ formatCurrency(g.start_value, g.currency) }} · Saldo Ein-/Auszahlungen {{ formatSignedCurrency(g.net_flow, g.currency) }}
          </span>
        </div>
      </div>

      <p class="perf-method">
        {{ span(g) }} ({{ PERIOD_NAMES[period] }}).
        <template v-if="g.shortened">Der Verlauf reicht nicht so weit zurück; gerechnet ab dem ersten Tag mit Bewertung.</template>
        TWR verkettet die Tagesrenditen und blendet Käufe, Verkäufe und Ausschüttungen aus — so hat sich das Wertpapier entwickelt.
        XIRR ist der Zinssatz, bei dem Anfangswert, alle Ein- und Auszahlungen und der Endwert aufgehen — so hat sich das eingesetzte Geld entwickelt.
      </p>

      <div class="perf-section-head">
        <h3 class="perf-sub-heading">Wertverlauf</h3>
        <SelectButton
          v-model="metric"
          :options="metricOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
          aria-label="Wert oder Rendite zeigen"
        />
      </div>
      <div v-if="g.points.length >= 2" class="perf-chart-wrap">
        <Chart type="line" :data="chartData(g)" :options="chartOptions(g)" class="perf-chart" />
      </div>
      <p v-else class="perf-muted">Der Verlauf erscheint, sobald mindestens zwei bewertete Tage vorliegen.</p>

      <p v-if="g.gaps.length > 0" class="perf-gaps">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        Ohne Bewertung (kein Kurs jünger als {{ data?.price_stale_days }} Tage; gestrichelt, nicht geschätzt):
        {{ g.gaps.map(gapText).join(', ') }}.
      </p>
      <p v-if="g.unvalued_flows > 0" class="perf-gaps">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        {{ g.unvalued_flows }} {{ g.unvalued_flows === 1 ? 'Buchung ließ' : 'Buchungen ließen' }} sich ohne Betrag oder Kurs nicht bewerten und fehlen in den Ein- und Auszahlungen.
      </p>
      <p v-if="Number(g.implied_inflow) !== 0" class="perf-muted">
        Stückzahlen, die ein Depotstand ohne passende Transaktion zeigt, zählen als Ein- oder Ausbuchung zum Tageskurs
        ({{ formatSignedCurrency(g.implied_inflow, g.currency) }}), nicht als Gewinn.
      </p>
    </div>
  </section>
</template>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.perf h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--p-text-color);
}
.perf-head,
.perf-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.perf-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.perf-currency,
.perf-sub-heading {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--p-text-color);
}
.perf-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2);
}
.perf-kpi {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: var(--space-2) var(--space-3);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  min-width: 0;
}
.perf-kpi-label {
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--p-text-muted-color);
}
.perf-kpi-value {
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.perf-kpi-sub {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.perf-method,
.perf-muted {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.perf-gaps {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-color);
}
.perf-gaps .pi {
  color: var(--p-yellow-500);
  margin-right: 0.25rem;
}
.perf-chart-wrap {
  height: 18rem;
  padding: var(--space-2);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}
.perf-chart {
  height: 100%;
}
.gain-pos {
  color: var(--p-green-600);
}
.gain-neg {
  color: var(--p-red-600);
}
</style>
