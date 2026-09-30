<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import type { ForecastPlanActual, ForecastSnapshot } from '../../../api/finance'
import { formatEur } from './forecastModel'
import ScrollX from '../../layout/ScrollX.vue'

/**
 * Plan against reality (#1342). Each snapshot is what a scenario expected
 * on the day it was taken; the row shows what it expected for today next
 * to today's liquid wealth. Below, the bookings of the last twelve months
 * against the scenario's spending and saving.
 */

const props = defineProps<{
  data: ForecastPlanActual
  /** Name of the scenario a new snapshot would keep. */
  scenarioName: string
  canEdit: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'snapshot'): void
  (e: 'remove', snapshot: ForecastSnapshot): void
  (e: 'adopt', payload: { itemId: number; monthly: number }): void
}>()

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
const fmtDate = (iso: string) => dateFmt.format(new Date(iso))

function deviation(s: ForecastSnapshot): { abs: number; pct: number | null } | null {
  if (!s.plannedNow) return null
  const abs = props.data.now.liquid - s.plannedNow.liquid
  return { abs, pct: s.plannedNow.liquid !== 0 ? abs / Math.abs(s.plannedNow.liquid) : null }
}

const pctFmt = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`
const signedEur = (v: number) => `${v > 0 ? '+' : ''}${formatEur(v)}`

const actuals = computed(() => props.data.actuals)
const spendingGap = computed(() => (actuals.value ? actuals.value.flows.outflowMonthly - actuals.value.plannedSpending : 0))
const savingsGap = computed(() =>
  actuals.value && actuals.value.plannedSavings != null ? actuals.value.flows.savingsMonthly - actuals.value.plannedSavings : null,
)
const canAdopt = computed(() => !!actuals.value && actuals.value.livingItemId != null && Math.abs(spendingGap.value) >= 10 && props.canEdit)
</script>

<template>
  <div class="plan-actual" data-testid="plan-actual">
    <div class="plan-actual__now">
      <span>Heute verfügbar <strong>{{ formatEur(data.now.liquid) }}</strong>, gesamt {{ formatEur(data.now.wealth) }}.</span>
      <Button
        :label="`Stand festhalten (${scenarioName})`"
        icon="pi pi-bookmark"
        size="small"
        outlined
        :disabled="!canEdit || busy"
        :loading="busy"
        @click="emit('snapshot')"
      />
    </div>

    <p v-if="data.snapshots.length === 0" class="muted">
      Noch kein Stand festgehalten. Jeder Stand merkt sich, was ein Szenario an dem Tag erwartet hat; von da an zeigt die Zeile, wie weit die Wirklichkeit davon abweicht. Einmal im Monat hält die Prognose den Stand jedes Szenarios von selbst fest.
    </p>
    <div v-else class="plan-actual__table">
      <ScrollX>
      <table class="snapshots">
        <thead>
          <tr>
            <th scope="col">Stand vom</th>
            <th scope="col">Szenario</th>
            <th scope="col" class="num">damals verfügbar</th>
            <th scope="col" class="num">erwartet für heute</th>
            <th scope="col" class="num">Abweichung</th>
            <th scope="col"><span class="sr-only">Aktionen</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data.snapshots" :key="s.id">
            <td>{{ fmtDate(s.takenAt) }} <Tag v-if="s.source === 'cron'" value="automatisch" severity="secondary" /></td>
            <td>{{ s.scenarioName }}</td>
            <td class="num">{{ formatEur(s.startLiquid) }}</td>
            <td class="num">{{ s.plannedNow ? formatEur(s.plannedNow.liquid) : '–' }}</td>
            <td class="num">
              <template v-if="deviation(s)">
                <span :class="deviation(s)!.abs >= 0 ? 'good' : 'bad'">{{ signedEur(deviation(s)!.abs) }}</span>
                <span v-if="deviation(s)!.pct != null" class="muted"> ({{ pctFmt(deviation(s)!.pct!) }})</span>
              </template>
              <template v-else>–</template>
            </td>
            <td>
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" :disabled="!canEdit || busy" :aria-label="`Stand vom ${fmtDate(s.takenAt)} löschen`" @click="emit('remove', s)" />
            </td>
          </tr>
        </tbody>
      </table>
      </ScrollX>
    </div>

    <template v-if="actuals">
      <h3 class="sub">Buchungen der letzten {{ actuals.flows.months }} Monate</h3>
      <p class="muted hint">
        Seit {{ fmtDate(actuals.since) }} über alle Konten des Haushalts; {{ actuals.flows.transfersExcluded }} Buchungen zwischen eigenen Konten bleiben außen vor.
      </p>
      <ul class="actuals">
        <li>
          <span>Ausgaben pro Monat</span>
          <span class="num">
            <strong>{{ formatEur(actuals.flows.outflowMonthly) }}</strong>
            <span class="muted"> · Plan {{ formatEur(actuals.plannedSpending) }}</span>
            <span :class="spendingGap <= 0 ? 'good' : 'bad'"> ({{ signedEur(spendingGap) }})</span>
          </span>
        </li>
        <li>
          <span>Einnahmen pro Monat</span>
          <span class="num"><strong>{{ formatEur(actuals.flows.inflowMonthly) }}</strong></span>
        </li>
        <li>
          <span>Sparrate pro Monat</span>
          <span class="num">
            <strong>{{ formatEur(actuals.flows.savingsMonthly) }}</strong>
            <template v-if="actuals.plannedSavings != null">
              <span class="muted"> · Plan {{ formatEur(actuals.plannedSavings) }}</span>
              <span v-if="savingsGap != null" :class="savingsGap >= 0 ? 'good' : 'bad'"> ({{ signedEur(savingsGap) }})</span>
            </template>
          </span>
        </li>
      </ul>
      <div v-if="canAdopt" class="plan-actual__adopt">
        <span class="muted">Die Lebenshaltung im Plan weicht von den Buchungen ab.</span>
        <Button
          :label="`Lebenshaltung auf ${formatEur(actuals.flows.outflowMonthly)} setzen`"
          size="small"
          outlined
          :disabled="busy"
          @click="emit('adopt', { itemId: actuals.livingItemId!, monthly: actuals.flows.outflowMonthly })"
        />
      </div>
    </template>
    <p v-else class="muted">Ohne Buchungen der letzten zwölf Monate lässt sich nichts gegen den Plan halten.</p>
  </div>
</template>

<style scoped>
.plan-actual {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.plan-actual__now {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
  justify-content: space-between;
}
/* A flex child keeps its intrinsic width unless told otherwise: the table must scroll, not push. */
.plan-actual__table {
  min-width: 0;
  max-width: 100%;
}
.snapshots {
  border-collapse: collapse;
  font-size: var(--text-base);
  width: 100%;
}
.snapshots th,
.snapshots td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  white-space: nowrap;
}
.snapshots th {
  color: var(--p-text-muted-color);
  font-weight: 600;
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.good {
  color: var(--p-green-600, var(--p-primary-color));
}
.bad {
  color: var(--p-red-600, var(--p-text-color));
}
.muted {
  color: var(--p-text-muted-color);
}
.hint {
  margin: 0;
  font-size: var(--text-sm);
}
.sub {
  margin: var(--space-2) 0 0;
  font-size: var(--text-lg);
}
.actuals {
  list-style: none;
  margin: 0;
  padding: 0;
}
.actuals li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.actuals li:last-child {
  border-bottom: none;
}
.plan-actual__adopt {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: center;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
