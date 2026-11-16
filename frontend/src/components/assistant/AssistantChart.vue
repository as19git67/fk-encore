<script setup lang="ts">
/**
 * A chart beside an answer (documentation/plans/assistent-diagramme.md).
 *
 * Draws the block's `chart` exactly as the server derived it from the tool's
 * rows: the model never writes chart data, and the rows under the chart stay
 * the table view of the same numbers.
 */
import { computed } from 'vue'
import Chart from 'primevue/chart'
import type { BlockChart } from '../../api/assistant'
import { useBelow, useMediaQuery } from '../../composables/useBreakpoint'

const props = defineProps<{ chart: BlockChart; label: string }>()

const isDark = useMediaQuery('(prefers-color-scheme: dark)')
const narrow = useBelow('sm')

/**
 * The eight categorical slots of the data-viz reference palette, in fixed
 * order, a light and a dark step each. A pie has at most eight slices
 * (`MAX_SLICES` on the server), so no colour is ever cycled.
 */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
/** „Übrige“ is not an entity of its own: grey, not a ninth hue. */
const REST_LIGHT = '#a3a29c'
const REST_DARK = '#6b6a64'

const palette = computed(() => (isDark.value ? SERIES_DARK : SERIES_LIGHT))

const formatter = computed(() => {
  const c = props.chart
  if (c.format === 'money') {
    try {
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency: c.unit || 'EUR' })
    } catch {
      return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }
  }
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 })
})

/** The axis reads whole units: „12.000 €“, not „12.000,00 €“. */
const axisFormatter = computed(() => {
  const c = props.chart
  try {
    return c.format === 'money'
      ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: c.unit || 'EUR', maximumFractionDigits: 0 })
      : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 })
  } catch {
    return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 })
  }
})

function fmt(v: number | null | undefined, axis = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  const s = (axis && Math.abs(v) >= 10 ? axisFormatter.value : formatter.value).format(v)
  return props.chart.format === 'number' && props.chart.unit ? `${s} ${props.chart.unit}` : s
}

const data = computed(() => {
  const c = props.chart
  const colors = palette.value
  if (c.type === 'pie') {
    const values = c.series[0]?.values ?? []
    const rest = isDark.value ? REST_DARK : REST_LIGHT
    return {
      labels: c.labels,
      datasets: [{
        label: c.series[0]?.name ?? '',
        data: values,
        backgroundColor: c.labels.map((l, i) => (l === 'Übrige' ? rest : colors[i % colors.length])),
        // The surface gap between slices.
        borderColor: isDark.value ? '#1a1a19' : '#ffffff',
        borderWidth: 2,
      }],
    }
  }
  return {
    labels: c.labels,
    datasets: c.series.map((s, i) => {
      const color = colors[i % colors.length]
      return c.type === 'bar'
        ? { label: s.name, data: s.values, backgroundColor: color, borderRadius: 4, maxBarThickness: 32 }
        : {
            label: s.name,
            data: s.values,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 2,
            // The second line (invested capital) is the reference, not the subject.
            borderDash: i > 0 ? [6, 4] : undefined,
            tension: 0.2,
            pointRadius: c.labels.length > 24 ? 0 : 3,
            pointHitRadius: 8,
            spanGaps: false,
          }
    }),
  }
})

const options = computed(() => {
  const c = props.chart
  const tick = isDark.value ? '#c3c2b7' : '#52514e'
  const grid = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const showLegend = c.type === 'pie' || c.series.length > 1
  const tooltip = {
    callbacks: {
      label: (ctx: { dataset: { label?: string }; label?: string; parsed: number | { y: number } }) => {
        const v = typeof ctx.parsed === 'number' ? ctx.parsed : ctx.parsed.y
        const name = c.type === 'pie' ? ctx.label : ctx.dataset.label
        return `${name ?? ''}: ${fmt(v)}`
      },
    },
  }
  if (c.type === 'pie') {
    return {
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'right' as const, labels: { color: tick, boxWidth: 12 } }, tooltip },
    }
  }
  return {
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: { legend: { display: showLegend, labels: { color: tick, boxWidth: 12 } }, tooltip },
    scales: {
      x: { ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: narrow.value ? 3 : c.type === 'line' ? 5 : 8 }, grid: { display: false } },
      y: {
        beginAtZero: c.type === 'bar',
        ticks: { color: tick, maxTicksLimit: 5, callback: (v: number | string) => fmt(Number(v), true) },
        grid: { color: grid },
      },
    },
  }
})
</script>

<template>
  <figure class="assistant-chart">
    <div class="chart-box" :class="{ 'chart-box--pie': chart.type === 'pie' }">
      <Chart :type="chart.type" :data="data" :options="options" :aria-label="label" role="img" class="chart" />
    </div>
    <figcaption v-if="chart.caption" class="chart-caption">{{ chart.caption }}</figcaption>
  </figure>
</template>

<style scoped>
.assistant-chart {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--p-content-border-color);
}

.chart-box {
  position: relative;
  height: 12rem;
}

.chart-box--pie {
  height: 11rem;
}

.chart {
  height: 100%;
}

.chart-caption {
  margin-top: var(--space-1);
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}
</style>
