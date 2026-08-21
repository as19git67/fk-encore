<script setup lang="ts">
/**
 * PV economics and cost per application (Issue #792, Etappe 6c).
 *
 * Two blocks: what the PV system has saved and when it pays for itself, and
 * what each application (heating, hot water, wallbox, household) actually
 * costs. Self-consumed kWh are valued at the assumed self-consumption price,
 * kWh from the grid at the price in force at the time.
 */
import { computed } from 'vue'
import Chart from 'primevue/chart'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import type { ApplicationCost, EconomicsReport } from '../api/meters'

const props = defineProps<{
  report: EconomicsReport | null
  loading?: boolean
}>()

function fmtEur(value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`
}

function fmtNumber(value: number | null | undefined, decimals = 1) {
  if (value === null || value === undefined) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtKwh(value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })} kWh`
}

function fmtDate(iso: string | null) {
  if (!iso) return '–'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '–'
  return date.toLocaleDateString('de-DE', { month: '2-digit', year: 'numeric' })
}

function fmtYears(value: number) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

const amortization = computed(() => props.report?.pv.amortization ?? null)

/** Share of the investment already earned back, 0..1. */
const payoffProgress = computed(() => {
  const data = amortization.value
  if (!data?.investmentTotalEur) return null
  return Math.min(1, Math.max(0, data.cumulativePvBenefitEur / data.investmentTotalEur))
})

function primaryColor() {
  if (typeof window === 'undefined') return '#3b82f6'
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--p-primary-color')
    .trim()
  return value || '#3b82f6'
}

/** Cumulative cost with and without PV — the gap between them is the saving. */
const savingsChart = computed(() => {
  const buckets = props.report?.pv.buckets ?? []
  const withData = buckets.filter((bucket) => bucket.cumulativeSavingsEur !== null)
  if (withData.length < 2) return null

  let cumulativeNet = 0
  let cumulativeNoPv = 0
  const netSeries: number[] = []
  const noPvSeries: number[] = []
  for (const bucket of withData) {
    cumulativeNet += bucket.netElectricityCostEur ?? 0
    cumulativeNoPv += bucket.noPvElectricityCostEur ?? 0
    netSeries.push(Math.round(cumulativeNet * 100) / 100)
    noPvSeries.push(Math.round(cumulativeNoPv * 100) / 100)
  }

  return {
    labels: withData.map((bucket) => bucket.label),
    datasets: [
      {
        label: 'Ohne PV (hypothetisch)',
        data: noPvSeries,
        borderColor: 'rgba(120, 120, 120, 0.9)',
        borderDash: [4, 3],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      },
      {
        label: 'Mit PV (tatsächlich)',
        data: netSeries,
        borderColor: primaryColor(),
        borderWidth: 2,
        pointRadius: 0,
        fill: '-1',
        backgroundColor: 'rgba(34, 197, 94, 0.15)',
      },
    ],
  }
})

const savingsChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { display: true, position: 'bottom' as const },
    tooltip: {
      callbacks: {
        label: (ctx: any) =>
          `${ctx.dataset?.label ?? ''}: ${fmtEur(Number(ctx.raw ?? 0))}`,
      },
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      ticks: { callback: (value: number | string) => fmtEur(Number(value)) },
    },
  },
}

interface ApplicationRow extends ApplicationCost {
  label: string
  share: number | null
}

/** Cost per application over the shown period, largest first. */
const applicationRows = computed<ApplicationRow[]>(() => {
  const totals = props.report?.usageCosts.totals
  if (!totals) return []

  const entries: Array<{ label: string; cost: ApplicationCost }> = [
    { label: 'Heizung', cost: totals.heating },
    { label: 'Warmwasser', cost: totals.hotWater },
    { label: 'E-Auto / Wallbox', cost: totals.evCharger },
    { label: 'Haushalt (übrig)', cost: totals.household },
  ]
  const sum = entries.reduce((total, entry) => total + (entry.cost.costEur ?? 0), 0)

  return entries
    .filter((entry) => entry.cost.totalKwh !== null)
    .map((entry) => ({
      label: entry.label,
      ...entry.cost,
      share: sum > 0 && entry.cost.costEur !== null ? entry.cost.costEur / sum : null,
    }))
    .sort((a, b) => (b.costEur ?? 0) - (a.costEur ?? 0))
})

function fmtShare(value: number | null) {
  if (value === null) return '–'
  return `${(value * 100).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`
}

const hasPvData = computed(() => (props.report?.pv.buckets ?? []).some((b) => b.savingsEur !== null))
</script>

<template>
  <section v-if="loading || report" class="economics-card">
    <div class="economics-head">
      <h2><i class="pi pi-euro" /> Wirtschaftlichkeit</h2>
      <p>
        Eigenverbrauchte kWh zum angenommenen Eigenverbrauchswert bewertet, Netzbezug zum
        jeweils gültigen Arbeitspreis.
      </p>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Wirtschaftlichkeit…
    </div>

    <p v-else-if="!report?.hasTariffs" class="economics-empty">
      Für diese Auswertung werden Strompreise benötigt — bitte Tarife anlegen oder die
      historischen Preise importieren.
    </p>

    <template v-else>
      <!-- PV savings -->
      <div v-if="hasPvData" class="economics-block">
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Ersparnis durch PV</span>
            <strong class="tile-value">{{ fmtEur(report.pv.totalSavingsEur) }}</strong>
            <span class="tile-sub">im angezeigten Zeitraum</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Stromkosten mit PV</span>
            <strong class="tile-value">{{ fmtEur(report.pv.totalNetElectricityCostEur) }}</strong>
            <span class="tile-sub">
              statt {{ fmtEur(report.pv.totalNoPvElectricityCostEur) }} ohne PV
            </span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">PV-Nutzen</span>
            <strong class="tile-value">{{ fmtEur(report.pv.totalPvBenefitEur) }}</strong>
            <span class="tile-sub">vermiedener Netzbezug + Einspeiseerlös</span>
          </div>
        </div>

        <div v-if="savingsChart" class="economics-chart">
          <Chart type="line" :data="savingsChart" :options="savingsChartOptions" />
        </div>
      </div>

      <!-- Amortisation -->
      <div v-if="amortization && amortization.investmentTotalEur !== null" class="economics-block">
        <h3>Amortisation</h3>
        <div class="figures-row">
          <div class="figure-tile">
            <span class="tile-label">Investition</span>
            <strong class="tile-value">{{ fmtEur(amortization.investmentTotalEur) }}</strong>
            <span class="tile-sub">
              netto {{ fmtEur(amortization.investmentNetEur) }} + MwSt.
              {{ fmtEur(amortization.investmentVatEur) }}
            </span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">Bereits erwirtschaftet</span>
            <strong class="tile-value">{{ fmtEur(amortization.cumulativePvBenefitEur) }}</strong>
            <span class="tile-sub">in {{ fmtYears(amortization.yearsElapsed) }} Jahren</span>
          </div>
          <div class="figure-tile">
            <span class="tile-label">{{ amortization.payoffReached ? 'Überschuss' : 'Noch offen' }}</span>
            <strong class="tile-value">
              {{ fmtEur(Math.abs(amortization.remainingEur ?? 0)) }}
            </strong>
            <span class="tile-sub">
              <template v-if="amortization.payoffReached">Anlage ist amortisiert</template>
              <template v-else-if="amortization.projectedPayoffDate">
                voraussichtlich bezahlt {{ fmtDate(amortization.projectedPayoffDate) }}
              </template>
              <template v-else>noch keine Hochrechnung möglich</template>
            </span>
          </div>
        </div>

        <div v-if="payoffProgress !== null" class="payoff-bar" :aria-label="`${fmtShare(payoffProgress)} amortisiert`">
          <div class="payoff-fill" :style="{ width: `${payoffProgress * 100}%` }" />
        </div>

        <p v-if="amortization.opportunityCostPerYearEur !== null" class="economics-note">
          Mit Opportunitätskosten von {{ fmtEur(amortization.opportunityCostPerYearEur) }}/Jahr:
          noch {{ fmtEur(amortization.remainingWithOpportunityEur) }} offen,
          <template v-if="amortization.projectedPayoffDateWithOpportunity">
            voraussichtlich bezahlt {{ fmtDate(amortization.projectedPayoffDateWithOpportunity) }}.
          </template>
          <template v-else>
            beim aktuellen Ertrag rechnerisch nicht erreichbar.
          </template>
          <template v-if="amortization.benefitLast12MonthsEur !== null">
            Hochrechnung auf Basis der letzten 12 Monate
            ({{ fmtEur(amortization.benefitLast12MonthsEur) }}).
          </template>
        </p>
      </div>

      <!-- Cost per application -->
      <div v-if="applicationRows.length > 0" class="economics-block">
        <h3>Kosten je Anwendung</h3>
        <DataTable :value="applicationRows" size="small" class="application-table">
          <Column field="label" header="Anwendung" />
          <Column header="Kosten">
            <template #body="{ data }">{{ fmtEur(data.costEur) }}</template>
          </Column>
          <Column header="Anteil">
            <template #body="{ data }">{{ fmtShare(data.share) }}</template>
          </Column>
          <Column header="Verbrauch">
            <template #body="{ data }">{{ fmtKwh(data.totalKwh) }}</template>
          </Column>
          <Column header="davon PV">
            <template #body="{ data }">{{ fmtKwh(data.pvKwh) }}</template>
          </Column>
          <Column header="davon Netz">
            <template #body="{ data }">{{ fmtKwh(data.gridKwh) }}</template>
          </Column>
        </DataTable>
        <p class="economics-note">
          Grundpreis {{ fmtEur(report.usageCosts.totals.baseCostEur) }} ist keiner Anwendung
          zugeordnet; Gesamtkosten {{ fmtEur(report.usageCosts.totals.totalCostEur) }}.
        </p>
      </div>

      <!-- Water -->
      <div v-if="report.water.length > 0" class="economics-block">
        <h3>Wasserkosten</h3>
        <DataTable :value="report.water" size="small" class="application-table">
          <Column field="name" header="Zähler" />
          <Column header="Kosten">
            <template #body="{ data }">{{ fmtEur(data.totalCostEur) }}</template>
          </Column>
          <Column header="Verbrauch">
            <template #body="{ data }">
              {{ fmtNumber(data.totalVolume) }} {{ data.unit }}
            </template>
          </Column>
        </DataTable>
        <p class="economics-note">
          Frisch- und Abwasser werden beide auf die gemessene Menge berechnet; die
          Grundgebühr ist anteilig enthalten.
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.economics-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}

.economics-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.economics-head p {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 70ch;
}

.economics-empty {
  margin: 0.75rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.economics-block {
  margin-top: 1.25rem;
}

.economics-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  color: var(--p-text-color);
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
  font-size: 1.3rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-color);
}

.tile-sub {
  font-size: 0.74rem;
  color: var(--p-text-muted-color);
}

.economics-chart {
  height: 260px;
  margin-top: 0.9rem;
}

.payoff-bar {
  height: 8px;
  margin-top: 0.75rem;
  border-radius: 999px;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  overflow: hidden;
}

.payoff-fill {
  height: 100%;
  background: var(--p-primary-color);
}

.economics-note {
  margin: 0.6rem 0 0;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}

.application-table {
  margin-top: 0.25rem;
}
</style>
