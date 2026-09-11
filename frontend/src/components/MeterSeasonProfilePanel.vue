<script setup lang="ts">
/**
 * Seasonal profile of autarky and self-consumption rate (Issue #792, report
 * A3 / #1022): a heatmap year × month per ratio. Shows at a glance in which
 * months the PV system carries the household and whether that improves over
 * the years.
 */
import { computed } from 'vue'
import type { SeasonProfileMetric, SeasonProfileReport } from '../api/meters'

const props = defineProps<{
  report: SeasonProfileReport | null
  loading?: boolean
}>()

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const metrics = computed(() =>
  (props.report?.metrics ?? []).filter((metric) => metric.years.length > 0),
)

function fmtPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  return `${Math.round(value * 100)} %`
}

/**
 * Cell colour: the primary colour at an alpha that follows the value. The
 * ratios are 0..1, so the scale is fixed rather than min/max — a household
 * whose autarky never exceeds 40 % should still look pale, not saturated.
 */
function cellStyle(value: number | null) {
  if (value === null) return {}
  const alpha = 0.08 + Math.max(0, Math.min(1, value)) * 0.72
  return { background: `color-mix(in srgb, var(--p-primary-color) ${Math.round(alpha * 100)}%, transparent)` }
}

function cellClass(value: number | null) {
  if (value === null) return 'cell cell--empty'
  return value >= 0.55 ? 'cell cell--strong' : 'cell'
}

function bestMonth(metric: SeasonProfileMetric): string | null {
  let bestIndex = -1
  let bestValue = -Infinity
  metric.monthAverages.forEach((value, index) => {
    if (value !== null && value > bestValue) {
      bestValue = value
      bestIndex = index
    }
  })
  return bestIndex === -1 ? null : MONTHS[bestIndex] ?? null
}
</script>

<template>
  <section v-if="loading || metrics.length > 0" class="season-card">
    <div class="season-head">
      <h2><i class="pi pi-th-large" /> Saisonprofil</h2>
      <p>
        Autarkie und Eigenverbrauchsquote je Monat und Jahr. Dunklere Felder = höherer Wert;
        leere Felder sind nicht vollständig gemessen.
      </p>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Saisonprofil…
    </div>

    <template v-else>
      <div v-for="metric in metrics" :key="metric.key" class="season-block">
        <h3>
          {{ metric.label }}
          <span v-if="bestMonth(metric)" class="season-sub">stärkster Monat im Schnitt: {{ bestMonth(metric) }}</span>
        </h3>
        <div class="heatmap-scroll">
          <table class="heatmap">
            <thead>
              <tr>
                <th class="row-head">Jahr</th>
                <th v-for="name in MONTHS" :key="name">{{ name }}</th>
                <th class="avg-head">Ø</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in metric.years" :key="row.year">
                <th class="row-head">{{ row.year }}</th>
                <td
                  v-for="(value, index) in row.months"
                  :key="index"
                  :class="cellClass(value)"
                  :style="cellStyle(value)"
                  :title="value === null ? 'nicht vollständig gemessen' : `${MONTHS[index]} ${row.year}: ${fmtPercent(value)}`"
                >
                  {{ value === null ? '' : Math.round(value * 100) }}
                </td>
                <td class="avg-cell">{{ fmtPercent(row.average) }}</td>
              </tr>
              <tr class="avg-row">
                <th class="row-head">Ø</th>
                <td v-for="(value, index) in metric.monthAverages" :key="index" :class="cellClass(value)" :style="cellStyle(value)">
                  {{ value === null ? '' : Math.round(value * 100) }}
                </td>
                <td class="avg-cell" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.season-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}
.season-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.season-head p {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 70ch;
}
.season-block {
  margin-top: 1.25rem;
}
.season-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: var(--p-text-color);
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.season-sub {
  font-size: 0.78rem;
  font-weight: normal;
  color: var(--p-text-muted-color);
}
.heatmap-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.heatmap {
  border-collapse: separate;
  border-spacing: 3px;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  min-width: 36rem;
}
.heatmap th {
  font-weight: 600;
  color: var(--p-text-muted-color);
  padding: 0.15rem 0.2rem;
  text-align: center;
}
.heatmap .row-head {
  text-align: left;
  color: var(--p-text-color);
  padding-right: 0.5rem;
}
.cell {
  width: 2.4rem;
  height: 1.9rem;
  text-align: center;
  border-radius: 4px;
  color: var(--p-text-color);
}
.cell--strong {
  color: var(--p-primary-contrast-color);
}
.cell--empty {
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
}
.avg-cell,
.avg-head {
  text-align: right;
  padding-left: 0.5rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
.avg-row td {
  border-top: 1px solid var(--p-content-border-color);
}
.info {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.info-compact {
  margin-top: 0.75rem;
}
</style>
