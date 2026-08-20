<script setup lang="ts">
/**
 * Consumption trend tiles (Issue #792, Etappe 6b).
 *
 * Each tile answers one question: is this category using more or less than
 * before? The figure shown is the rolling 12-month sum, not a single month —
 * that is what makes heating in January comparable to heating in July.
 */
import { computed } from 'vue'
import Chart from 'primevue/chart'
import type { ConsumptionTrend, TrendDirection } from '../api/meters'

const props = defineProps<{
  trends: ConsumptionTrend[]
  loading?: boolean
}>()

const emit = defineEmits<{ (e: 'select', trend: ConsumptionTrend): void }>()

function fmt(value: number | null, decimals: number) {
  if (value === null) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtSigned(value: number | null, decimals: number) {
  if (value === null) return '–'
  const sign = value > 0 ? '+' : ''
  return `${sign}${fmt(value, decimals)}`
}

function fmtPercent(value: number | null) {
  if (value === null) return null
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toLocaleString('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })} %`
}

const directionIcon: Record<TrendDirection, string> = {
  rising: 'pi pi-arrow-up-right',
  falling: 'pi pi-arrow-down-right',
  stable: 'pi pi-arrows-h',
  unknown: 'pi pi-question',
}

const directionText: Record<TrendDirection, string> = {
  rising: 'steigend',
  falling: 'fallend',
  stable: 'gleichbleibend',
  unknown: 'noch keine Aussage',
}

function periodLabel(trend: ConsumptionTrend) {
  if (!trend.rangeEnd) return `${trend.monthsAvailable} Monate erfasst`
  // rangeEnd is exclusive — step back a day to name the last month included.
  const end = new Date(trend.rangeEnd)
  end.setUTCDate(end.getUTCDate() - 1)
  const label = `${String(end.getUTCMonth() + 1).padStart(2, '0')}.${end.getUTCFullYear()}`
  return `12 Monate bis ${label}`
}

/**
 * Chart.js paints on a canvas, where CSS custom properties do not resolve, so
 * the theme colour has to be read out before it is handed to the chart.
 */
function primaryColor() {
  if (typeof window === 'undefined') return '#3b82f6'
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--p-primary-color')
    .trim()
  return value || '#3b82f6'
}

/** Sparklines over the rolling series — the seasonally neutral view. */
const sparklines = computed(() => {
  const color = primaryColor()
  const result: Record<string, object> = {}
  for (const trend of props.trends) {
    const points = trend.points.filter((point) => point.rolling12 !== null)
    if (points.length < 2) continue
    result[trend.key] = {
      labels: points.map((point) => point.label),
      datasets: [
        {
          data: points.map((point) => point.rolling12),
          borderColor: color,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    }
  }
  return result
})

const sparklineOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  scales: { x: { display: false }, y: { display: false } },
  elements: { line: { borderJoinStyle: 'round' as const } },
}

const hasTrends = computed(() => props.trends.length > 0)
</script>

<template>
  <section class="trend-dashboard">
    <div class="trend-head">
      <div>
        <h3>Verbrauchstrend</h3>
        <p class="trend-sub">
          Rollierende 12-Monats-Summe gegen die 12 Monate davor — dadurch fällt die
          Jahreszeit heraus. Teilweise abgelesene Monate bleiben unberücksichtigt.
        </p>
      </div>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Trends…
    </div>

    <p v-else-if="!hasTrends" class="trend-empty">
      Noch keine auswertbaren Ablesungen vorhanden.
    </p>

    <div v-else class="trend-grid">
      <button
        v-for="trend in trends"
        :key="trend.key"
        type="button"
        class="trend-tile"
        :class="`is-${trend.direction}`"
        @click="emit('select', trend)"
      >
        <span class="trend-label">{{ trend.label }}</span>

        <span class="trend-value">
          <strong>{{ fmt(trend.current12, trend.decimals) }}</strong>
          <span class="trend-unit">{{ trend.unit }}</span>
        </span>

        <span class="trend-change" :class="`is-${trend.direction}`">
          <i :class="directionIcon[trend.direction]" />
          <template v-if="trend.changeAbsolute !== null">
            {{ fmtSigned(trend.changeAbsolute, trend.decimals) }} {{ trend.unit }}
            <span v-if="fmtPercent(trend.changePercent)" class="trend-percent">
              ({{ fmtPercent(trend.changePercent) }})
            </span>
          </template>
          <template v-else>{{ directionText[trend.direction] }}</template>
        </span>

        <span class="trend-spark">
          <Chart
            v-if="sparklines[trend.key]"
            type="line"
            :data="sparklines[trend.key]"
            :options="sparklineOptions"
            class="spark-chart"
          />
        </span>

        <span class="trend-foot">
          {{ periodLabel(trend) }}
          <template v-if="trend.slopePerYear !== null">
            · {{ fmtSigned(trend.slopePerYear, trend.decimals) }} {{ trend.unit }}/Jahr
          </template>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.trend-dashboard {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}

.trend-head h3 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
}

.trend-sub {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 60ch;
}

.trend-empty {
  margin: 0.75rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.trend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.trend-tile {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-hover-background);
  text-align: left;
  font: inherit;
  color: var(--p-text-color);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.trend-tile:hover,
.trend-tile:focus-visible {
  border-color: var(--p-primary-color);
}

.trend-label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  line-height: 1.25;
}

.trend-value {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
}

.trend-value strong {
  font-size: 1.35rem;
  font-variant-numeric: tabular-nums;
}

.trend-unit {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.trend-change {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  padding: 0.1rem 0.45rem;
  border-radius: var(--p-tag-border-radius);
  align-self: flex-start;
}

/* More consumption than before is the unwelcome direction, less is welcome. */
.trend-change.is-rising {
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
}

.trend-change.is-falling {
  background: var(--p-tag-success-background);
  color: var(--p-tag-success-color);
}

.trend-change.is-stable,
.trend-change.is-unknown {
  background: var(--p-tag-info-background);
  color: var(--p-tag-info-color);
}

.trend-percent {
  opacity: 0.85;
}

.trend-spark {
  height: 42px;
  margin-top: 0.15rem;
}

.spark-chart {
  height: 42px;
}

.trend-foot {
  font-size: 0.74rem;
  color: var(--p-text-muted-color);
}
</style>
