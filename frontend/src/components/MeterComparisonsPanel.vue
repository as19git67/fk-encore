<script setup lang="ts">
/**
 * Technology comparisons (Issue #792, Etappe 6d).
 *
 * These are model calculations, not measurements — only the electricity side
 * is metered. The panel therefore always shows the assumptions it used, and
 * the heat-pump comparison shows a range rather than one euro figure, because
 * without a heat meter the seasonal performance factor is an estimate.
 */
import { computed, ref } from 'vue'
import Message from 'primevue/message'
import type {
  ComparisonAssumption,
  ComparisonsReport,
  CostRange,
  ElectricityTariffUnit,
  HeatSource,
} from '../api/meters'
import { ELECTRICITY_TARIFF_UNIT_LABELS } from '../api/meters'

const props = defineProps<{
  report: ComparisonsReport | null
  loading?: boolean
}>()

const showAssumptions = ref(false)

function fmtEur(value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })} €`
}

function fmtNumber(value: number | null | undefined, decimals = 0) {
  if (value === null || value === undefined) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtRange(range: CostRange) {
  if (range.mid === null) return '–'
  if (range.low === null || range.high === null) return fmtEur(range.mid)
  return `${fmtEur(range.low)} – ${fmtEur(range.high)}`
}

function fmtAmount(assumption: ComparisonAssumption) {
  const unit = ELECTRICITY_TARIFF_UNIT_LABELS[assumption.unit as ElectricityTariffUnit] ?? ''
  const decimals = assumption.amount < 1 ? 3 : 1
  return `${fmtNumber(assumption.amount, decimals)} ${unit}`.trim()
}

function fmtMonth(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('de-DE', { month: '2-digit', year: 'numeric' })
}

/** One line per assumption kind; a series of values lists each with its start. */
interface AssumptionLine {
  kind: string
  label: string
  text: string
}

function assumptionLines(assumptions: ComparisonAssumption[]): AssumptionLine[] {
  const byKind = new Map<string, ComparisonAssumption[]>()
  for (const assumption of assumptions) {
    const list = byKind.get(assumption.kind) ?? []
    list.push(assumption)
    byKind.set(assumption.kind, list)
  }
  return [...byKind.entries()].map(([kind, entries]) => {
    const sorted = [...entries].sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    const text =
      sorted.length === 1
        ? fmtAmount(sorted[0]!)
        : sorted.map((entry) => `${fmtAmount(entry)} ab ${fmtMonth(entry.validFrom)}`).join(', ')
    return { kind, label: sorted[0]!.label, text }
  })
}

const HEAT_SOURCE_NOTES: Record<HeatSource, string | null> = {
  sub_meters: null,
  heat_pump_total:
    'Grundlage ist der Zähler „Wärmepumpe gesamt“ ohne PV-Unterzähler — der gesamte Strom wird zum Netzpreis bewertet, die Stromkosten sind daher eher zu hoch.',
  heating_only:
    'Nur der Heizungs-Unterzähler ist vorhanden; das Warmwasser fehlt in beiden Seiten des Vergleichs.',
  hot_water_only:
    'Nur der Warmwasser-Unterzähler ist vorhanden; die Heizung fehlt in beiden Seiten des Vergleichs.',
}

/** "MM.YYYY – MM.YYYY", or a single month when start and end fall in the same one. */
function fmtPeriod(start: string | null, end: string | null) {
  if (!start || !end) return null
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('de-DE', { month: '2-digit', year: 'numeric' })
  // periodEnd is exclusive (the first instant of the following period), so
  // the last covered month is the one before it.
  const lastCovered = new Date(end)
  lastCovered.setUTCDate(lastCovered.getUTCDate() - 1)
  const from = fmt(start)
  const to = fmt(lastCovered.toISOString())
  return from === to ? from : `${from} – ${to}`
}

const heating = computed(() => props.report?.heating ?? null)
const car = computed(() => props.report?.car ?? null)

const allAssumptions = computed(() =>
  assumptionLines([...(heating.value?.assumptions ?? []), ...(car.value?.assumptions ?? [])]),
)

const heatSourceNote = computed(() =>
  heating.value?.heatSource ? HEAT_SOURCE_NOTES[heating.value.heatSource] : null,
)

/** "3 Monate" / "2 Jahre" — how many periods both sides were known for. */
function comparedLabel(count: number) {
  const unit =
    props.report?.granularity === 'year'
      ? count === 1 ? 'Jahr' : 'Jahre'
      : props.report?.granularity === 'week'
        ? count === 1 ? 'Woche' : 'Wochen'
        : props.report?.granularity === 'day'
          ? count === 1 ? 'Tag' : 'Tage'
          : count === 1 ? 'Monat' : 'Monate'
  return `${count} ${unit}`
}

function fmtCo2Range(range: CostRange) {
  if (range.mid === null) return '–'
  if (range.low === null || range.high === null) return `${fmtNumber(range.mid)} kg`
  return `${fmtNumber(Math.min(range.low, range.high))} – ${fmtNumber(Math.max(range.low, range.high))} kg`
}

const nothingConfigured = computed(
  () => props.report !== null && heating.value === null && car.value === null,
)

/** Reads the sign of a saving so the wording stays truthful either way. */
function savingWord(value: number | null) {
  if (value === null) return null
  return value >= 0 ? 'günstiger' : 'teurer'
}
</script>

<template>
  <section v-if="loading || report" class="comparisons-card">
    <div class="comparisons-head">
      <h2><i class="pi pi-arrows-h" /> Vergleichsrechnungen</h2>
      <p>
        Modellrechnungen: nur die Stromseite ist gemessen, die Gegenrechnung beruht auf
        Annahmen. Der Netzanteil des Stroms zählt zum Arbeitspreis, der PV-Anteil zur
        Einspeisevergütung, die er stattdessen gebracht hätte. Nur vollständig gemessene
        Zeiträume, in denen beide Seiten bekannt sind, gehen in die Summen ein.
      </p>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Vergleiche…
    </div>

    <p v-else-if="nothingConfigured" class="comparisons-empty">
      Für die Vergleiche werden Annahmen benötigt — für die Gasheizung mindestens
      Jahresarbeitszahl und Kesselwirkungsgrad, für den Benziner Verbrauch E-Auto und
      Verbrauch Benziner. Diese lassen sich unter „Strompreise &amp; Annahmen“ anlegen.
    </p>

    <template v-else>
      <!-- Heat pump vs gas boiler -->
      <div v-if="heating" class="comparison-block">
        <h3>
          Wärmepumpe statt Gasheizung
          <span v-if="fmtPeriod(heating.periodStart, heating.periodEnd)" class="comparison-period">
            {{ fmtPeriod(heating.periodStart, heating.periodEnd) }} ·
            {{ comparedLabel(heating.comparedPeriods) }} verglichen
          </span>
        </h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Stromkosten Wärmepumpe</span>
            <strong class="tile-value">{{ fmtEur(heating.totalHeatPumpCostEur) }}</strong>
            <span class="tile-sub">{{ fmtNumber(heating.totalHeatPumpKwh) }} kWh · Netzanteil zum Arbeitspreis, PV-Anteil zur Einspeisevergütung</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Gasheizung hätte gekostet</span>
            <strong class="tile-value">{{ fmtRange(heating.totalGasCostEur) }}</strong>
            <span class="tile-sub">
              Bandbreite über JAZ
              {{ fmtNumber(heating.scopRange?.low, 1) }}–{{ fmtNumber(heating.scopRange?.high, 1) }}
            </span>
          </div>
          <div class="figure-tile is-highlight">
            <span class="tile-label">Differenz</span>
            <strong class="tile-value">{{ fmtRange(heating.totalSavingsEur) }}</strong>
            <span class="tile-sub">
              <template v-if="savingWord(heating.totalSavingsEur.mid)">
                Wärmepumpe war {{ savingWord(heating.totalSavingsEur.mid) }}
              </template>
              <template v-else>keine Preisdaten</template>
            </span>
          </div>
        </div>
        <p v-if="heatSourceNote" class="comparison-note">{{ heatSourceNote }}</p>
        <p v-if="heating.avoidedCo2Kg !== null" class="comparison-note">
          Vermiedenes CO₂ gegenüber der Gasheizung: {{ fmtCo2Range(heating.avoidedCo2Range) }}
          (Bandbreite über die JAZ; nur der Netzanteil des Wärmepumpenstroms wird als
          Emission gegengerechnet).
        </p>
      </div>

      <!-- EV vs petrol car -->
      <div v-if="car" class="comparison-block">
        <h3>
          E-Auto statt Benziner
          <span v-if="fmtPeriod(car.periodStart, car.periodEnd)" class="comparison-period">
            {{ fmtPeriod(car.periodStart, car.periodEnd) }} ·
            {{ comparedLabel(car.comparedPeriods) }} verglichen
          </span>
        </h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Ladekosten</span>
            <strong class="tile-value">{{ fmtEur(car.totalEvCostEur) }}</strong>
            <span class="tile-sub">
              {{ fmtNumber(car.totalChargedKwh) }} kWh ·
              {{ fmtNumber(car.evCentsPerKm, 1) }} ct/km
            </span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Benziner hätte gekostet</span>
            <strong class="tile-value">{{ fmtEur(car.totalPetrolCostEur) }}</strong>
            <span class="tile-sub">
              {{ fmtNumber(car.totalKilometers) }} km ·
              {{ fmtNumber(car.petrolCentsPerKm, 1) }} ct/km
            </span>
          </div>
          <div class="figure-tile is-highlight">
            <span class="tile-label">Differenz</span>
            <strong class="tile-value">{{ fmtEur(car.totalSavingsEur) }}</strong>
            <span class="tile-sub">
              <template v-if="savingWord(car.totalSavingsEur)">
                E-Auto war {{ savingWord(car.totalSavingsEur) }}
              </template>
              <template v-else>kein Benzinpreis hinterlegt</template>
            </span>
          </div>
        </div>
        <p class="comparison-note">
          <template v-if="car.chargingLoss > 0">
            Kilometer aus den Wallbox-kWh abzüglich {{ fmtNumber(car.chargingLoss * 100) }} %
            Ladeverluste.
          </template>
          <template v-else>
            Kilometer direkt aus den Wallbox-kWh — ohne hinterlegte Ladeverluste werden sie
            eher überschätzt (Annahme „Ladeverluste E-Auto“).
          </template>
        </p>
        <p v-if="car.avoidedCo2Kg !== null" class="comparison-note">
          Vermiedenes CO₂ gegenüber dem Benziner: {{ fmtNumber(car.avoidedCo2Kg) }} kg
          (nur der Netzanteil des Ladestroms wird als Emission gegengerechnet).
        </p>
      </div>

      <!-- Assumptions -->
      <div v-if="allAssumptions.length > 0" class="comparison-block">
        <button type="button" class="assumptions-toggle" @click="showAssumptions = !showAssumptions">
          <i :class="showAssumptions ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
          Verwendete Annahmen ({{ allAssumptions.length }})
        </button>
        <ul v-if="showAssumptions" class="assumptions-list">
          <li v-for="assumption in allAssumptions" :key="assumption.kind">
            {{ assumption.label }}: {{ assumption.text }}
          </li>
        </ul>
        <Message v-if="showAssumptions" severity="info" :closable="false" class="assumptions-hint">
          Die Zahlen sind nur so belastbar wie diese Annahmen. Jeder Zeitraum rechnet mit
          dem Wert, der damals galt. Ohne Wärmemengenzähler ist die Jahresarbeitszahl
          geschätzt — deshalb wird die Gasrechnung als Bandbreite statt als eine Zahl
          ausgewiesen.
        </Message>
      </div>
    </template>
  </section>
</template>

<style scoped>
.comparisons-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}

.comparisons-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.comparisons-head p {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 70ch;
}

.comparisons-empty {
  margin: 0.75rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  max-width: 80ch;
}

.comparison-block {
  margin-top: 1.25rem;
}

.comparison-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: var(--p-text-color);
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.comparison-period {
  font-size: 0.78rem;
  font-weight: normal;
  color: var(--p-text-muted-color);
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

.figure-tile.is-highlight {
  border-color: var(--p-primary-color);
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

.comparison-note {
  margin: 0.6rem 0 0;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}

.assumptions-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.85rem;
  color: var(--p-primary-color);
  cursor: pointer;
}

.assumptions-list {
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.assumptions-list li {
  margin-bottom: 0.2rem;
}

.assumptions-hint {
  margin-top: 0.75rem;
}
</style>
