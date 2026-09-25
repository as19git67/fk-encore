<script setup lang="ts">
import { computed } from 'vue'
import type { ForecastMatrixCell, ForecastPerson } from '../../../api/finance'
import { formatEur } from './forecastModel'
import ScrollX from '../../layout/ScrollX.vue'

/**
 * Leave-work age of A × leave-work age of B (#1337). Green shades for
 * the remaining buffer, red where the money runs out; the year it runs
 * out is the tooltip.
 */

const props = defineProps<{
  cells: ForecastMatrixCell[]
  personA: ForecastPerson
  personB: ForecastPerson
  real: boolean
  inflationRate: number
  startYear: number
  endYear: number
}>()

const emit = defineEmits<{ (e: 'pick', payload: { ageA: number; ageB: number }): void }>()

const agesA = computed(() => [...new Set(props.cells.map((c) => c.ageA))].sort((a, b) => a - b))
const agesB = computed(() => [...new Set(props.cells.map((c) => c.ageB))].sort((a, b) => a - b))

const maxWealth = computed(() => Math.max(1, ...props.cells.filter((c) => c.ok).map((c) => c.finalWealth)))

function cell(ageA: number, ageB: number): ForecastMatrixCell | undefined {
  return props.cells.find((c) => c.ageA === ageA && c.ageB === ageB)
}

function shown(v: number): number {
  return props.real ? v / Math.pow(1 + props.inflationRate, props.endYear - props.startYear) : v
}

function style(c: ForecastMatrixCell | undefined): Record<string, string> {
  if (!c) return {}
  if (!c.ok) return { background: 'rgba(239, 68, 68, 0.28)' }
  const t = Math.max(0.12, Math.min(0.6, c.finalWealth / maxWealth.value))
  return { background: `rgba(16, 185, 129, ${t.toFixed(2)})` }
}

function title(c: ForecastMatrixCell | undefined): string {
  if (!c) return ''
  return c.ok ? `Restvermögen am Ende: ${formatEur(shown(c.finalWealth))}` : `Geld reicht bis ${c.failYear ?? '?'}`
}
</script>

<template>
  <ScrollX>
    <table class="matrix">
      <caption class="matrix__caption">
        Zeilen: {{ personA.label }} hört auf mit …, Spalten: {{ personB.label }} hört auf mit …
      </caption>
      <thead>
        <tr>
          <th scope="col" class="matrix__corner">{{ personA.label }} \ {{ personB.label }}</th>
          <th v-for="b in agesB" :key="b" scope="col">{{ b }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in agesA" :key="a">
          <th scope="row">{{ a }}</th>
          <td v-for="b in agesB" :key="b" :style="style(cell(a, b))">
            <button
              type="button"
              class="matrix__cell"
              :title="title(cell(a, b))"
              :aria-label="`${personA.label} mit ${a}, ${personB.label} mit ${b}: ${title(cell(a, b))}`"
              @click="emit('pick', { ageA: a, ageB: b })"
            >
              <span v-if="cell(a, b)?.ok">{{ formatEur(shown(cell(a, b)!.finalWealth)).replace(/\s?€/, '') }}</span>
              <span v-else>{{ cell(a, b)?.failYear ?? '–' }}</span>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </ScrollX>
</template>

<style scoped>
.matrix {
  border-collapse: separate;
  border-spacing: 2px;
  font-size: var(--text-sm);
}
.matrix__caption {
  caption-side: top;
  text-align: left;
  color: var(--p-text-muted-color);
  padding-bottom: var(--space-2);
}
.matrix th {
  font-weight: 600;
  padding: var(--space-1) var(--space-2);
  color: var(--p-text-muted-color);
  text-align: center;
}
.matrix__corner {
  font-weight: 400;
  white-space: nowrap;
}
.matrix td {
  border-radius: 4px;
  padding: 0;
  text-align: center;
  min-width: 64px;
}
.matrix__cell {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  border-radius: 4px;
  font: inherit;
}
.matrix__cell:hover {
  background: var(--p-content-hover-background);
}
.matrix__cell:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
</style>
