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

function fmtAssumption(assumption: ComparisonAssumption) {
  const unit = ELECTRICITY_TARIFF_UNIT_LABELS[assumption.unit as ElectricityTariffUnit] ?? ''
  const decimals = assumption.amount < 1 ? 3 : 1
  return `${assumption.label}: ${fmtNumber(assumption.amount, decimals)} ${unit}`.trim()
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

const allAssumptions = computed(() => {
  const seen = new Map<string, ComparisonAssumption>()
  for (const assumption of [
    ...(heating.value?.assumptions ?? []),
    ...(car.value?.assumptions ?? []),
  ]) {
    seen.set(assumption.kind, assumption)
  }
  return [...seen.values()]
})

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
        Annahmen.
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
            {{ fmtPeriod(heating.periodStart, heating.periodEnd) }}
          </span>
        </h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Tatsächliche Stromkosten</span>
            <strong class="tile-value">{{ fmtEur(heating.totalHeatPumpCostEur) }}</strong>
            <span class="tile-sub">Heizung + Warmwasser</span>
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
        <p v-if="heating.avoidedCo2Kg !== null" class="comparison-note">
          Vermiedenes CO₂ gegenüber der Gasheizung:
          {{ fmtNumber(heating.avoidedCo2Kg) }} kg (Netzanteil der Wärmepumpe gegengerechnet).
        </p>
      </div>

      <!-- EV vs petrol car -->
      <div v-if="car" class="comparison-block">
        <h3>
          E-Auto statt Benziner
          <span v-if="fmtPeriod(car.periodStart, car.periodEnd)" class="comparison-period">
            {{ fmtPeriod(car.periodStart, car.periodEnd) }}
          </span>
        </h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Ladekosten</span>
            <strong class="tile-value">{{ fmtEur(car.totalEvCostWithOpportunityEur) }}</strong>
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
        <p v-if="car.totalLostFeedInEur" class="comparison-note">
          Enthält {{ fmtEur(car.totalEvCostEur) }} gemessene Stromkosten
          plus {{ fmtEur(car.totalLostFeedInEur) }} entgangene Einspeisevergütung: der
          PV-Anteil des Ladestroms hätte alternativ eingespeist werden können.
        </p>
        <p v-if="car.avoidedCo2Kg !== null" class="comparison-note">
          Vermiedenes CO₂ gegenüber dem Benziner: {{ fmtNumber(car.avoidedCo2Kg) }} kg
          (Netzanteil des Ladestroms gegengerechnet).
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
            {{ fmtAssumption(assumption) }}
          </li>
        </ul>
        <Message v-if="showAssumptions" severity="info" :closable="false" class="assumptions-hint">
          Die Zahlen sind nur so belastbar wie diese Annahmen. Ohne Wärmemengenzähler ist
          die Jahresarbeitszahl geschätzt — deshalb wird die Gasrechnung als Bandbreite
          statt als eine Zahl ausgewiesen.
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
