<script setup lang="ts">
/**
 * Weather-adjusted heating (Issue #792, report C3 / #1023).
 *
 * With a degree-day series: kWh per degree day per year — the figure that
 * describes the house rather than the winter. Without one: each month against
 * the household's own typical month, clearly labelled as an estimate.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import type { HeatingWeatherReport } from '../api/meters'
import MeterHomeLocationCard from './MeterHomeLocationCard.vue'

const router = useRouter()

const props = defineProps<{
  report: HeatingWeatherReport | null
  loading?: boolean
  /** Shows the home-location card (meters.manage). */
  canManage?: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

function fmt(value: number | null | undefined, decimals = 1) {
  if (value === null || value === undefined) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtPercent(value: number | null | undefined, withSign = false) {
  if (value === null || value === undefined) return '–'
  const sign = withSign && value > 0 ? '+' : ''
  return `${sign}${(value * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`
}

const hasData = computed(() => (props.report?.source ?? null) !== null)
const isDegreeDays = computed(() => props.report?.source === 'degree_days')

/** Newest first, last 24 months. */
const recentMonths = computed(() => [...(props.report?.buckets ?? [])].slice(-24).reverse())
const yearRows = computed(() => [...(props.report?.years ?? [])].reverse())

/** For consumption per degree day, up is the unwelcome direction. */
function riskClass(value: number | null | undefined) {
  if (value === null || value === undefined) return ''
  if (Math.abs(value) < 0.02) return ''
  return value > 0 ? 'is-worse' : 'is-better'
}
</script>

<template>
  <section v-if="loading || hasData || canManage" class="heating-card">
    <div class="heating-head">
      <div class="heating-title">
        <h2><i class="pi pi-sun" /> Heizung witterungsbereinigt</h2>
        <Button
          label="Was sind Gradtage?"
          icon="pi pi-question-circle"
          severity="secondary"
          text
          size="small"
          @click="router.push({ name: 'zaehler-hilfe-gradtage' })"
        />
      </div>
      <p v-if="isDegreeDays">
        Heizverbrauch je Gradtag ({{ report?.meterName }}). Der Wert beschreibt Haus und Heizung,
        nicht den Winter: steigt er, wird mehr Strom für dieselbe Kälte gebraucht.
        Gradtagzahlen liegen für {{ report?.degreeDayMonths }} gemessene Monate vor.
      </p>
      <p v-else-if="hasData">
        Ohne Gradtagzahlen wird jeder Monat mit dem Durchschnitt desselben Kalendermonats
        aus {{ report?.referenceYears }} Jahren verglichen ({{ report?.meterName }}). Das zeigt
        die Abweichung vom eigenen Normalwert, kann aber einen kälteren Winter nicht herausrechnen —
        dafür unten den Wohnort hinterlegen, dann werden die Gradtagzahlen automatisch geholt.
      </p>
      <p v-else>
        Sobald ein Heizungszähler (Rolle „Heizung gesamt“ oder „Wärmepumpe gesamt“) Ablesungen hat,
        zeigt dieser Report den Heizverbrauch je Gradtag. Den Wohnort dafür jetzt schon hinterlegen.
      </p>
    </div>

    <MeterHomeLocationCard v-if="canManage" :can-manage="canManage" @degree-days-changed="emit('refresh')" />

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Witterungsbereinigung…
    </div>

    <template v-else-if="report">
      <div v-if="isDegreeDays && report.latestKwhPerDegreeDay !== null" class="figures-row">
        <div class="figure-tile">
          <span class="tile-label">Aktuell</span>
          <strong class="tile-value">{{ fmt(report.latestKwhPerDegreeDay, 3) }} {{ report.unit }}/Kd</strong>
          <span class="tile-sub">letztes vollständig gemessenes Jahr</span>
        </div>
        <div class="figure-tile">
          <span class="tile-label">Vorjahr</span>
          <strong class="tile-value">{{ fmt(report.previousKwhPerDegreeDay, 3) }} {{ report.unit }}/Kd</strong>
        </div>
        <div class="figure-tile">
          <span class="tile-label">Veränderung</span>
          <strong class="tile-value" :class="riskClass(report.changePercent)">
            {{ fmtPercent(report.changePercent, true) }}
          </strong>
          <span class="tile-sub">witterungsbereinigt, Jahr gegen Vorjahr</span>
        </div>
      </div>

      <div v-if="yearRows.length > 0" class="heating-block">
        <h3>Jahre</h3>
        <DataTable :value="yearRows" size="small" class="heating-table">
          <Column field="year" header="Jahr">
            <template #body="{ data }">
              {{ data.year }}
              <span v-if="data.measuredMonths < 12" class="muted"> ({{ data.measuredMonths }} Mon.)</span>
            </template>
          </Column>
          <Column header="Heizung">
            <template #body="{ data }">{{ fmt(data.heatingKwh, 0) }} {{ report.unit }}</template>
          </Column>
          <Column v-if="isDegreeDays" header="Gradtage">
            <template #body="{ data }">{{ fmt(data.degreeDays, 0) }} Kd</template>
          </Column>
          <Column v-if="isDegreeDays" header="je Gradtag">
            <template #body="{ data }">{{ fmt(data.kwhPerDegreeDay, 3) }} {{ report.unit }}/Kd</template>
          </Column>
          <Column v-if="isDegreeDays" header="Normaljahr">
            <template #body="{ data }">{{ fmt(data.adjustedKwh, 0) }} {{ report.unit }}</template>
          </Column>
        </DataTable>
      </div>

      <div v-if="recentMonths.length > 0" class="heating-block">
        <h3>Monate</h3>
        <DataTable :value="recentMonths" size="small" class="heating-table">
          <Column field="label" header="Monat" />
          <Column header="Heizung">
            <template #body="{ data }">{{ fmt(data.heatingKwh, 0) }} {{ report.unit }}</template>
          </Column>
          <Column v-if="isDegreeDays" header="Gradtage">
            <template #body="{ data }">{{ fmt(data.degreeDays, 0) }}</template>
          </Column>
          <Column v-if="isDegreeDays" header="Normalmonat">
            <template #body="{ data }">{{ fmt(data.adjustedKwh, 0) }} {{ report.unit }}</template>
          </Column>
          <Column header="Typisch">
            <template #body="{ data }">{{ fmt(data.typicalKwh, 0) }} {{ report.unit }}</template>
          </Column>
          <Column header="Abweichung">
            <template #body="{ data }">
              <span :class="riskClass(data.deviationPercent)">{{ fmtPercent(data.deviationPercent, true) }}</span>
            </template>
          </Column>
        </DataTable>
      </div>
    </template>
  </section>
</template>

<style scoped>
.heating-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}
.heating-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.heating-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.heating-head p {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}
.heating-block {
  margin-top: 1.25rem;
}
.heating-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: var(--p-text-color);
}
.figures-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}
.figure-tile {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-hover-background);
}
.tile-label {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
.tile-value {
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-color);
}
.tile-sub {
  font-size: 0.74rem;
  color: var(--p-text-muted-color);
}
.is-worse {
  color: var(--p-tag-warn-color);
}
.is-better {
  color: var(--p-tag-success-color);
}
.muted {
  color: var(--p-text-muted-color);
}
.heating-table :deep(.p-datatable-table-container) {
  overflow-x: auto;
}
.info {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.info-compact {
  margin-top: 0.75rem;
}
</style>
