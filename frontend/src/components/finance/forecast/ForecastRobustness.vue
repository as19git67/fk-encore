<script setup lang="ts">
import { computed } from 'vue'
import type { ForecastLevers, ForecastPerson, ForecastSensitivity, ForecastSensitivityCell } from '../../../api/finance'
import { formatPct } from './forecastModel'
import ScrollX from '../../layout/ScrollX.vue'

/**
 * How fragile is the earliest leave age (#1339)? A table of the earliest
 * age over return × inflation around the scenario's own rates, and the
 * one assumption that moves it most. A click on a cell hands its rates
 * to the scenario.
 */

const props = defineProps<{
  sensitivity: ForecastSensitivity | null
  levers: ForecastLevers | null
  person: ForecastPerson
}>()

const emit = defineEmits<{ (e: 'pick', payload: { returnRate: number; inflationRate: number }): void }>()

function cell(returnRate: number, inflationRate: number): ForecastSensitivityCell | undefined {
  return props.sensitivity?.cells.find((c) => c.returnRate === returnRate && c.inflationRate === inflationRate)
}

const baseAge = computed(() => (props.sensitivity ? (cell(props.sensitivity.baseReturnRate, props.sensitivity.baseInflationRate)?.age ?? null) : null))

function isBase(returnRate: number, inflationRate: number): boolean {
  return !!props.sensitivity && returnRate === props.sensitivity.baseReturnRate && inflationRate === props.sensitivity.baseInflationRate
}

/** Green when earlier than the base, red when later or impossible. */
function tone(c: ForecastSensitivityCell | undefined): 'better' | 'same' | 'worse' | 'none' {
  if (!c) return 'none'
  if (c.age == null) return 'none'
  if (baseAge.value == null) return 'better'
  if (c.age < baseAge.value) return 'better'
  if (c.age > baseAge.value) return 'worse'
  return 'same'
}

const biggest = computed(() => props.levers?.levers.find((l) => l.key === props.levers?.biggest) ?? null)

function leverText(delta: number | null, age: number | null): string {
  if (age == null) return 'kein Alter reicht mehr'
  if (delta == null) return `Ausstieg mit ${age}`
  if (delta === 0) return 'ändert nichts'
  const years = Math.abs(delta) === 1 ? '1 Jahr' : `${Math.abs(delta)} Jahre`
  return delta > 0 ? `${years} später (${age})` : `${years} früher (${age})`
}
</script>

<template>
  <div class="robustness">
    <template v-if="sensitivity">
      <ScrollX>
        <table class="sens" data-testid="sensitivity">
          <caption class="sens__caption">
            Frühester Ausstieg von {{ person.label }}: Zeilen Rendite, Spalten Inflation. Umrandet sind die aktuellen Annahmen; ein Klick übernimmt ein Paar.
          </caption>
          <thead>
            <tr>
              <th scope="col" class="sens__corner">Rendite \ Inflation</th>
              <th v-for="i in sensitivity.inflationRates" :key="i" scope="col">{{ formatPct(i) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sensitivity.returnRates" :key="r">
              <th scope="row">{{ formatPct(r) }}</th>
              <td v-for="i in sensitivity.inflationRates" :key="i" :class="[`sens__td--${tone(cell(r, i))}`, { 'sens__td--base': isBase(r, i) }]">
                <button
                  type="button"
                  class="sens__cell"
                  :aria-label="`Rendite ${formatPct(r)}, Inflation ${formatPct(i)}: ${cell(r, i)?.age == null ? 'kein Alter reicht' : `Ausstieg mit ${cell(r, i)!.age}`}`"
                  :aria-current="isBase(r, i) ? 'true' : undefined"
                  @click="emit('pick', { returnRate: r, inflationRate: i })"
                >
                  {{ cell(r, i)?.age ?? '–' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </ScrollX>
    </template>

    <template v-if="levers">
      <p v-if="biggest && levers.baseAge != null" class="robustness__biggest" data-testid="biggest-lever">
        Größter Hebel: <strong>{{ biggest.label }}</strong> — {{ leverText(biggest.deltaYears, biggest.age) }}.
      </p>
      <p v-else-if="levers.baseAge == null" class="muted">Ohne ein Alter, das reicht, lässt sich kein Hebel messen.</p>
      <ul class="levers">
        <li v-for="l in levers.levers" :key="l.key" :class="{ 'levers__item--biggest': l.key === levers.biggest }">
          <span>{{ l.label }}</span>
          <span class="levers__delta">{{ leverText(l.deltaYears, l.age) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.robustness {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.sens {
  border-collapse: separate;
  border-spacing: 2px;
  font-size: var(--text-sm);
}
.sens__caption {
  caption-side: top;
  text-align: left;
  color: var(--p-text-muted-color);
  padding-bottom: var(--space-2);
}
.sens th {
  font-weight: 600;
  padding: var(--space-1) var(--space-2);
  color: var(--p-text-muted-color);
  text-align: center;
  white-space: nowrap;
}
.sens__corner {
  font-weight: 400;
}
.sens td {
  border-radius: 4px;
  padding: 0;
  text-align: center;
  min-width: 56px;
  background: var(--p-content-hover-background);
}
.sens td.sens__td--better {
  background: rgba(16, 185, 129, 0.28);
}
.sens td.sens__td--worse {
  background: rgba(239, 68, 68, 0.22);
}
.sens td.sens__td--none {
  background: rgba(239, 68, 68, 0.4);
}
.sens td.sens__td--base {
  box-shadow: inset 0 0 0 2px var(--p-primary-color);
}
.sens__cell {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  border-radius: 4px;
  font: inherit;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sens__cell:hover {
  background: rgba(0, 0, 0, 0.06);
}
.sens__cell:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.robustness__biggest {
  margin: 0;
}
.muted {
  margin: 0;
  color: var(--p-text-muted-color);
}
.levers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.levers li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: var(--text-base);
}
.levers li:last-child {
  border-bottom: none;
}
.levers__item--biggest {
  font-weight: 600;
}
.levers__delta {
  white-space: nowrap;
  text-align: right;
}
</style>
