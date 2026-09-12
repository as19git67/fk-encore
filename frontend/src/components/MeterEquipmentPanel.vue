<script setup lang="ts">
/**
 * Equipment condition (Issue #792, Etappe 6e).
 *
 * Early-warning figures that consumption totals hide: kWh per compressor hour
 * (heat pump efficiency), the water baseline (a rising floor means a leak),
 * yield per kWp (PV degradation) and how much of the time each pump ran.
 */
import { computed } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import type { EquipmentReport, OperatingHoursMetric } from '../api/meters'
import { METER_ROLE_LABELS } from '../api/meters'

const props = defineProps<{
  report: EquipmentReport | null
  loading?: boolean
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

const compressor = computed(() => props.report?.compressorEfficiency ?? null)
const pvYield = computed(() => props.report?.pvYield ?? null)
const waterBaselines = computed(() => props.report?.waterBaselines ?? [])
const operatingHours = computed(() => props.report?.operatingHours ?? [])

/** Rows for the runtime-share table, busiest first. */
const runtimeRows = computed(() =>
  [...operatingHours.value]
    .filter((metric) => metric.averageRuntimeShare !== null)
    .sort((a, b) => (b.averageRuntimeShare ?? 0) - (a.averageRuntimeShare ?? 0)),
)

/** Periods in which more hours were counted than there were. */
function implausiblePeriods(metric: OperatingHoursMetric) {
  return metric.buckets.filter((bucket) => bucket.implausible).map((bucket) => bucket.label)
}

const missingRoleLabels = computed(() =>
  (props.report?.missingRoles ?? []).map((role) => METER_ROLE_LABELS[role]),
)
const duplicateRoleLabels = computed(() =>
  (props.report?.duplicateRoles ?? []).map((role) => METER_ROLE_LABELS[role]),
)

/** Name of the period a key belongs to, for "in 2025" / "im 03.2026". */
function periodName(key: string | null) {
  if (!key) return ''
  if (/^\d{4}$/.test(key)) return key
  if (/^\d{4}-\d{2}$/.test(key)) return `${key.slice(5)}.${key.slice(0, 4)}`
  return key
}

const hasAnything = computed(
  () =>
    compressor.value !== null ||
    pvYield.value !== null ||
    waterBaselines.value.length > 0 ||
    operatingHours.value.length > 0,
)

/** For consumption-side figures, up is the unwelcome direction. */
function riskClass(value: number | null | undefined) {
  if (value === null || value === undefined) return ''
  return value > 0 ? 'is-worse' : 'is-better'
}
</script>

<template>
  <section v-if="loading || (report && hasAnything)" class="equipment-card">
    <div class="equipment-head">
      <h2><i class="pi pi-wrench" /> Anlagenzustand</h2>
      <p>
        Frühindikatoren, die in den Verbrauchssummen untergehen. Teilweise abgelesene
        Perioden bleiben unberücksichtigt; Vergleiche laufen immer gegen dieselbe Periode
        des Vorjahres.
      </p>
      <p v-if="duplicateRoleLabels.length > 0" class="equipment-warn">
        Mehrere Zähler tragen dieselbe Rolle ({{ duplicateRoleLabels.join(', ') }}) — verwendet
        wird jeweils nur der erste.
      </p>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Anlagenzustand…
    </div>

    <template v-else>
      <!-- Heat pump efficiency -->
      <div v-if="compressor && compressor.latestKwhPerHour !== null" class="equipment-block">
        <h3>Wärmepumpe: Strom je Verdichterstunde</h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Aktuell</span>
            <strong class="tile-value">{{ fmt(compressor.latestKwhPerHour, 2) }} kWh/h</strong>
            <span class="tile-sub">{{ periodName(compressor.latestKey) }}, letzte vollständig gemessene Periode</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Vorjahr</span>
            <strong class="tile-value">{{ fmt(compressor.previousYearKwhPerHour, 2) }} kWh/h</strong>
            <span class="tile-sub">dieselbe Periode ein Jahr früher</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Veränderung</span>
            <strong class="tile-value" :class="riskClass(compressor.changePercent)">
              {{ fmtPercent(compressor.changePercent, true) }}
            </strong>
            <span class="tile-sub">
              <template v-if="compressor.changePercent === null">noch kein Vorjahreswert</template>
              <template v-else>steigend = mehr Strom für dieselbe Laufstunde</template>
              <template v-if="compressor.slopePerYear !== null">
                · Trend {{ fmt(compressor.slopePerYear, 3) }} kWh/h je Jahr
              </template>
            </span>
          </div>
        </div>
        <p class="equipment-note">
          Perioden, in denen der Verdichter kaum lief (Sommer, nur Warmwasser), bleiben
          außen vor — dort misst der Wert Stand-by und Anläufe, nicht den Zustand der Pumpe.
        </p>
      </div>

      <!-- PV yield -->
      <div v-if="pvYield && pvYield.latestYieldPerKwp !== null" class="equipment-block">
        <h3>PV-Ertrag je kWp</h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Jahr {{ periodName(pvYield.latestKey) }}</span>
            <strong class="tile-value">{{ fmt(pvYield.latestYieldPerKwp, 0) }} kWh/kWp</strong>
            <span class="tile-sub">letztes vollständig gemessenes Kalenderjahr, {{ fmt(pvYield.capacityKwp, 1) }} kWp</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Gegenüber Vorjahr</span>
            <strong class="tile-value" :class="riskClass(-(pvYield.changeVsPreviousYearPercent ?? 0))">
              {{ fmtPercent(pvYield.changeVsPreviousYearPercent, true) }}
            </strong>
            <span class="tile-sub">
              <template v-if="pvYield.previousYearYieldPerKwp !== null">
                Vorjahr {{ fmt(pvYield.previousYearYieldPerKwp, 0) }} kWh/kWp — enthält das Wetter beider Jahre
              </template>
              <template v-else>noch kein vollständiges Vorjahr</template>
            </span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Gegenüber Median</span>
            <strong class="tile-value" :class="riskClass(-(pvYield.changeVsMedianPercent ?? 0))">
              {{ fmtPercent(pvYield.changeVsMedianPercent, true) }}
            </strong>
            <span class="tile-sub">
              <template v-if="pvYield.medianYieldPerKwp !== null">
                Median der übrigen Jahre {{ fmt(pvYield.medianYieldPerKwp, 0) }} kWh/kWp,
                bestes Jahr {{ fmt(pvYield.bestYieldPerKwp, 0) }}
              </template>
              <template v-else>erst ab zwei vollständigen Jahren</template>
            </span>
          </div>
        </div>
        <p class="equipment-note">
          Immer je Kalenderjahr, damit ein sonniger Sommer nicht gegen einen Winter steht.
          Ein deutlicher Abfall über mehrere Jahre deutet auf Verschmutzung oder Degradation;
          ein einzelnes Jahr unter dem Median ist meist nur Wetter.
        </p>
      </div>

      <!-- Water baseline -->
      <div v-if="waterBaselines.length > 0" class="equipment-block">
        <h3>Wasser: Grundlast</h3>
        <p class="equipment-note">
          Der kleinste Tagesverbrauch einer Periode. Steigt dieser Boden, während der
          Gesamtverbrauch gleich bleibt, deutet das auf einen laufenden Spülkasten oder
          ein Leck hin. Dafür müssen die Ablesungen höchstens eine Woche auseinanderliegen —
          mit einer Ablesung pro Monat ist das Minimum der Durchschnitt und sagt nichts.
        </p>
        <DataTable :value="waterBaselines" size="small" class="equipment-table">
          <Column field="name" header="Zähler" />
          <Column header="Grundlast aktuell">
            <template #body="{ data }">
              <template v-if="data.tooSparse">
                <span class="muted">zu wenige Ablesungen</span>
              </template>
              <template v-else>
                {{ fmt(data.latestMinDailyRate, 3) }} {{ data.unit }}/Tag
                <span v-if="data.latestKey" class="muted">({{ periodName(data.latestKey) }})</span>
              </template>
            </template>
          </Column>
          <Column header="Vorjahr">
            <template #body="{ data }">
              {{ fmt(data.previousYearMinDailyRate, 3) }} {{ data.unit }}/Tag
            </template>
          </Column>
          <Column header="Veränderung">
            <template #body="{ data }">
              <span :class="riskClass(data.changePercent)">
                {{ fmtPercent(data.changePercent, true) }}
              </span>
            </template>
          </Column>
          <Column header="Ablesungen">
            <template #body="{ data }">
              <template v-if="data.buckets.length > 0">
                {{ data.buckets[data.buckets.length - 1].intervals }} Intervalle,
                kürzestes {{ fmt(data.buckets[data.buckets.length - 1].shortestIntervalDays, 0) }} Tage
              </template>
              <span v-else class="muted">–</span>
            </template>
          </Column>
        </DataTable>
      </div>

      <!-- Runtime share -->
      <div v-if="runtimeRows.length > 0" class="equipment-block">
        <h3>Laufzeitanteil</h3>
        <DataTable :value="runtimeRows" size="small" class="equipment-table">
          <Column field="name" header="Aggregat" />
          <Column header="Ø Laufzeitanteil">
            <template #body="{ data }">
              {{ fmtPercent(data.averageRuntimeShare) }}
              <i
                v-if="implausiblePeriods(data).length > 0"
                class="pi pi-exclamation-triangle warning-marker"
                v-tooltip.top="`Mehr Stunden gezählt, als der Zeitraum hat — vermutlich ein Ablesefehler: ${implausiblePeriods(data).join(', ')}`"
              />
            </template>
          </Column>
          <Column header="Betriebsstunden gesamt">
            <template #body="{ data }">{{ fmt(data.totalHours, 0) }} {{ data.unit }}</template>
          </Column>
        </DataTable>
        <p class="equipment-note">Gewichtet nach Periodenlänge, nur vollständig gemessene Perioden.</p>
      </div>

      <p v-if="missingRoleLabels.length > 0" class="equipment-note">
        Für weitere Kennzahlen fehlen Zählerrollen: {{ missingRoleLabels.join(', ') }}.
      </p>
    </template>
  </section>
</template>

<style scoped>
.equipment-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}

.equipment-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.equipment-head p {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 70ch;
}

.equipment-block {
  margin-top: 1.25rem;
}

.equipment-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: var(--p-text-color);
}

.equipment-note {
  margin: 0 0 0.6rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}

.figures-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0.75rem;
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

/* Rising consumption per unit of work is the unwelcome direction. */
.is-worse {
  color: var(--p-tag-warn-color);
}

.is-better {
  color: var(--p-tag-success-color);
}

.equipment-table {
  margin-top: 0.25rem;
}

.equipment-warn {
  color: var(--p-tag-warn-color);
}

.warning-marker {
  margin-left: 0.35rem;
  font-size: 0.8rem;
  color: var(--p-tag-warn-color);
}

.muted {
  color: var(--p-text-muted-color);
}
</style>
