<script setup lang="ts">
/**
 * Advance payments against the calculated actual cost (Issue #792, report
 * E3 / #1018). Fed by the finance transactions linked to readings.
 */
import { computed } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { METER_TYPE_LABELS, type AdvancePaymentsReport } from '../api/meters'

const props = defineProps<{
  report: AdvancePaymentsReport | null
  loading?: boolean
}>()

const meters = computed(() => props.report?.meters ?? [])

function fmtCurrency(value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value)
}

function settlementLabel(value: number | null) {
  if (value === null) return '–'
  if (Math.abs(value) < 0.005) return 'ausgeglichen'
  return value > 0 ? `Erstattung ${fmtCurrency(value)}` : `Nachzahlung ${fmtCurrency(-value)}`
}

function settlementClass(value: number | null) {
  if (value === null) return ''
  return value >= 0 ? 'is-better' : 'is-worse'
}

const rows = computed(() =>
  meters.value.flatMap((meter) =>
    [...meter.years].reverse().map((year) => ({
      id: `${meter.meterId}-${year.year}`,
      meterName: meter.name,
      meterType: METER_TYPE_LABELS[meter.type],
      ...year,
    })),
  ),
)
</script>

<template>
  <section v-if="loading || meters.length > 0" class="advance-card">
    <div class="advance-head">
      <h2><i class="pi pi-euro" /> Abschläge vs. Ist-Kosten</h2>
      <p>
        Mit Ablesungen verknüpfte Zahlungen je Kalenderjahr gegen die aus Verbrauch und Tarifen
        berechneten Kosten. Kalenderjahr statt Abrechnungsjahr — die Zahl ist eine Orientierung
        vor der Jahresabrechnung, kein Ersatz dafür.
      </p>
    </div>

    <div v-if="loading" class="info info-compact">
      <i class="pi pi-spin pi-spinner" /> Abschlagsvergleich…
    </div>

    <DataTable v-else :value="rows" data-key="id" size="small" class="advance-table">
      <Column header="Zähler">
        <template #body="{ data }">
          {{ data.meterName }} <span class="muted">({{ data.meterType }})</span>
        </template>
      </Column>
      <Column header="Jahr">
        <template #body="{ data }">
          {{ data.year }}
          <i v-if="data.partial" class="pi pi-exclamation-circle partial-marker" v-tooltip.right="'Laufendes Jahr — beide Seiten noch unvollständig'" />
        </template>
      </Column>
      <Column header="Gezahlt">
        <template #body="{ data }">
          {{ fmtCurrency(data.paidEur) }}
          <span class="muted">({{ data.transactions }})</span>
        </template>
      </Column>
      <Column header="Ist-Kosten">
        <template #body="{ data }">{{ fmtCurrency(data.actualCostEur) }}</template>
      </Column>
      <Column header="Erwartung">
        <template #body="{ data }">
          <span :class="settlementClass(data.expectedSettlementEur)">{{ settlementLabel(data.expectedSettlementEur) }}</span>
        </template>
      </Column>
    </DataTable>
  </section>
</template>

<style scoped>
.advance-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin-bottom: 1.25rem;
}
.advance-head h2 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.advance-head p {
  margin: 0.25rem 0 0.75rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}
.is-worse {
  color: var(--p-tag-warn-color);
}
.is-better {
  color: var(--p-tag-success-color);
}
.muted {
  color: var(--p-text-muted-color);
  font-size: 0.85em;
}
.partial-marker {
  margin-left: 0.25rem;
  color: var(--p-tag-warn-color);
  font-size: 0.8rem;
}
.advance-table :deep(.p-datatable-table-container) {
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
