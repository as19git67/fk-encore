<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Chart from 'primevue/chart'
import type { ChartData, ChartOptions, Plugin } from 'chart.js'
import type { ForecastPerson, ForecastSimulation } from '../../../api/finance'
import { POT_LABELS, cssVar, deflate, formatEur, potColors, seriesColor, withAlpha } from './forecastModel'

/**
 * The three charts that share one year axis (#1337): wealth per pot,
 * cash flow per source, and the scenario comparison. Milestones are
 * vertical lines and bridge phases shaded bands, drawn by a small plugin
 * so no annotation library is needed.
 */

const props = defineProps<{
  result: ForecastSimulation
  persons: ForecastPerson[]
  comparisons: Array<{ scenarioId: number; name: string; result: ForecastSimulation }>
  /** Show today's purchasing power instead of nominal amounts. */
  real: boolean
  inflationRate: number
  minLiquidWealth: number
  selectedYear: number | null
}>()

const emit = defineEmits<{ (e: 'select-year', year: number): void }>()

const darkMQ = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const isDark = ref(darkMQ?.matches ?? false)
const onScheme = (e: MediaQueryListEvent) => (isDark.value = e.matches)
onMounted(() => darkMQ?.addEventListener('change', onScheme))
onBeforeUnmount(() => darkMQ?.removeEventListener('change', onScheme))

const labels = computed(() => props.result.years.map((y) => String(y.year)))

/** Second label row: the ages of all persons. */
const ageRow = computed(() =>
  props.result.years.map((y) => props.persons.map((p) => y.ages[String(p.id)]).filter((a) => a != null).join(' / ')),
)

const value = (v: number, year: number) => (props.real ? deflate(v, year, props.result.startYear, props.inflationRate) : v)

const textColor = computed(() => (isDark.value ? '#94a3b8' : '#64748b'))
const gridColor = computed(() => (isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'))

// ---- wealth per pot --------------------------------------------------------

const wealthData = computed<ChartData<'line'>>(() => {
  const colors = potColors()
  const pots = props.result.pots.filter((p) => props.result.years.some((y) => (y.pots[p] ?? 0) > 1))
  return {
    labels: labels.value,
    datasets: pots.map((pot) => ({
      label: POT_LABELS[pot],
      data: props.result.years.map((y) => value(y.pots[pot] ?? 0, y.year)),
      borderColor: colors[pot],
      backgroundColor: withAlpha(colors[pot], 0.55),
      fill: true,
      stack: 'pots',
      pointRadius: 0,
      pointHitRadius: 12,
      tension: 0.2,
      borderWidth: 1.5,
    })),
  }
})

// ---- cash flow -------------------------------------------------------------

const cashflowData = computed<ChartData<'bar'>>(() => {
  const incomeSources = props.result.sources.filter((s) => props.result.years.some((y) => (y.income[s.key] ?? 0) !== 0))
  const datasets: ChartData<'bar'>['datasets'] = incomeSources.map((s, i) => ({
    label: s.label,
    data: props.result.years.map((y) => value(y.income[s.key] ?? 0, y.year)),
    backgroundColor: withAlpha(seriesColor(i), 0.75),
    borderColor: seriesColor(i),
    borderWidth: 1,
    stack: 'income',
  }))
  const hiKeys = props.result.sources.filter((s) => s.kind === 'health_insurance').map((s) => s.key)
  const expenseLine = {
    type: 'line' as const,
    label: 'Ausgaben gesamt',
    data: props.result.years.map((y) => value(y.totalExpenses, y.year)),
    borderColor: cssVar('--p-red-500', '#ef4444'),
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: 2,
    tension: 0.2,
    order: -1,
  }
  const hiLine = {
    type: 'line' as const,
    label: 'davon Krankenversicherung',
    data: props.result.years.map((y) => value(hiKeys.reduce((s, k) => s + (y.expenses[k] ?? 0), 0), y.year)),
    borderColor: cssVar('--p-orange-500', '#f97316'),
    backgroundColor: 'transparent',
    borderDash: [4, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.2,
    order: -1,
  }
  // Mixed charts: the line datasets are typed as bar datasets by Chart.js' generics.
  datasets.push(expenseLine as unknown as ChartData<'bar'>['datasets'][number])
  if (hiKeys.length) datasets.push(hiLine as unknown as ChartData<'bar'>['datasets'][number])
  return { labels: labels.value, datasets }
})

// ---- comparison ------------------------------------------------------------

const comparisonData = computed<ChartData<'line'>>(() => {
  const all = [{ scenarioId: 0, name: 'Aktuell', result: props.result }, ...props.comparisons]
  const years = props.result.years.map((y) => y.year)
  return {
    labels: labels.value,
    datasets: all.map((c, i) => ({
      label: c.name,
      data: years.map((year) => {
        const row = c.result.years.find((y) => y.year === year)
        return row ? (props.real ? deflate(row.wealthEnd, year, c.result.startYear, props.inflationRate) : row.wealthEnd) : null
      }),
      borderColor: i === 0 ? cssVar('--p-primary-color', '#3b82f6') : seriesColor(i + 2),
      backgroundColor: 'transparent',
      borderWidth: i === 0 ? 2.5 : 1.5,
      pointRadius: 0,
      pointHitRadius: 12,
      tension: 0.2,
    })),
  }
})

// ---- plugin: milestones, bridges, minimum, selected year -------------------

function markerPlugin(showMinimum: boolean): Plugin {
  const result = props.result
  const persons = props.persons
  const selected = props.selectedYear
  const minLiquid = props.minLiquidWealth
  const muted = textColor.value
  return {
    id: 'forecast-markers',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart
      const x = scales.x
      if (!x || !chartArea) return
      const idx = (year: number) => result.years.findIndex((y) => y.year === year)
      ctx.save()
      // Bridge phases (household) as bands.
      for (const b of result.bridges) {
        if (b.personId !== null) continue
        const i0 = idx(b.fromYear)
        const i1 = idx(b.toYear)
        if (i0 < 0 || i1 < 0) continue
        const x0 = x.getPixelForValue(i0) - (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2
        const x1 = x.getPixelForValue(i1) + (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2
        ctx.fillStyle = b.covered ? 'rgba(245, 158, 11, 0.10)' : 'rgba(239, 68, 68, 0.12)'
        ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top)
      }
      // Selected year.
      if (selected != null) {
        const i = idx(selected)
        if (i >= 0) {
          const w = x.getPixelForValue(1) - x.getPixelForValue(0)
          ctx.fillStyle = 'rgba(59, 130, 246, 0.10)'
          ctx.fillRect(x.getPixelForValue(i) - w / 2, chartArea.top, w, chartArea.bottom - chartArea.top)
        }
      }
      ctx.restore()
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart
      const x = scales.x
      const y = scales.y
      if (!x || !chartArea) return
      ctx.save()
      // Minimum liquid wealth.
      if (y && minLiquid > 0 && showMinimum) {
        const py = y.getPixelForValue(minLiquid)
        if (py >= chartArea.top && py <= chartArea.bottom) {
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
          ctx.setLineDash([6, 4])
          ctx.beginPath()
          ctx.moveTo(chartArea.left, py)
          ctx.lineTo(chartArea.right, py)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
      // Milestones.
      ctx.font = '10px sans-serif'
      ctx.fillStyle = muted
      ctx.strokeStyle = muted
      ctx.setLineDash([2, 3])
      let slot = 0
      for (const m of [...result.milestones].sort((a, b) => a.year - b.year)) {
        const i = result.years.findIndex((yy) => yy.year === m.year)
        if (i < 0) continue
        const px = x.getPixelForValue(i)
        ctx.beginPath()
        ctx.moveTo(px, chartArea.top)
        ctx.lineTo(px, chartArea.bottom)
        ctx.stroke()
        const p = persons.find((pp) => pp.id === m.personId)
        const text = `${persons.length > 1 && p ? p.label + ': ' : ''}${m.label}`
        ctx.textAlign = 'left'
        ctx.fillText(text, px + 3, chartArea.top + 10 + (slot % 4) * 11)
        slot++
      }
      ctx.restore()
    },
  }
}

// ---- options -----------------------------------------------------------------

function baseOptions(kind: 'wealth' | 'cashflow' | 'compare'): ChartOptions<'line'> | ChartOptions<'bar'> {
  const money = (v: number | string) => formatEur(Number(v))
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: false,
    onClick: (_evt, _els, chart) => {
      const points = chart.getElementsAtEventForMode(_evt as unknown as Event, 'index', { intersect: false }, false)
      const first = points[0]
      const row = first ? props.result.years[first.index] : undefined
      if (row) emit('select-year', row.year)
    },
    plugins: {
      legend: { position: 'bottom', labels: { color: textColor.value, boxWidth: 12, padding: 12 } },
      tooltip: {
        callbacks: {
          title: (items: Array<{ dataIndex: number }>) => {
            const i = items[0]?.dataIndex ?? 0
            return `${labels.value[i] ?? ''} · Alter ${ageRow.value[i] ?? ''}`
          },
          label: (item: { dataset: { label?: string }; parsed: { y: number | null } }) =>
            `${item.dataset.label ?? ''}: ${money(item.parsed.y ?? 0)}`,
        },
      },
    },
    scales: {
      x: {
        stacked: kind !== 'compare',
        ticks: {
          color: textColor.value,
          maxRotation: 0,
          autoSkip: true,
          callback: (_v, i) => {
            const year = labels.value[i] ?? ''
            const ages = ageRow.value[i]
            return ages ? [year, ages] : year
          },
        },
        grid: { color: gridColor.value },
      },
      y: {
        stacked: kind !== 'compare',
        ticks: { color: textColor.value, callback: (v) => money(v) },
        grid: { color: gridColor.value },
      },
    },
  }
}

const wealthOptions = computed(() => baseOptions('wealth') as ChartOptions<'line'>)
const cashflowOptions = computed(() => baseOptions('cashflow') as ChartOptions<'bar'>)
const compareOptions = computed(() => baseOptions('compare') as ChartOptions<'line'>)
const plugins = computed(() => [markerPlugin(false)])
const wealthPlugins = computed(() => [markerPlugin(true)])
</script>

<template>
  <div class="charts">
    <section class="chart-card">
      <h2 class="chart-card__title">Vermögen über die Zeit</h2>
      <p class="chart-card__hint">
        Gestapelt nach Topf. Schraffierte Bänder sind Überbrückungsphasen, gestrichelte Linien Zeitpunkte. Ein Klick auf ein Jahr zeigt dessen Zahlen.
      </p>
      <div class="chart-card__canvas chart-card__canvas--tall">
        <Chart type="line" :data="wealthData" :options="wealthOptions" :plugins="wealthPlugins" />
      </div>
    </section>

    <section class="chart-card">
      <h2 class="chart-card__title">Geldfluss pro Jahr</h2>
      <p class="chart-card__hint">Einnahmen nach Quelle als Balken, Ausgaben als Linie. Wo die Linie über den Balken liegt, zehrt das Jahr am Vermögen.</p>
      <div class="chart-card__canvas">
        <Chart type="bar" :data="cashflowData" :options="cashflowOptions" :plugins="plugins" />
      </div>
    </section>

    <section v-if="comparisons.length" class="chart-card">
      <h2 class="chart-card__title">Szenarien im Vergleich</h2>
      <div class="chart-card__canvas">
        <Chart type="line" :data="comparisonData" :options="compareOptions" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.charts {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.chart-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: var(--space-3) var(--space-4);
  min-width: 0;
}
.chart-card__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xl);
}
.chart-card__hint {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.chart-card__canvas {
  position: relative;
  height: 260px;
  min-width: 0;
}
.chart-card__canvas--tall {
  height: 340px;
}
.chart-card__canvas :deep(.p-chart) {
  height: 100%;
}
</style>
