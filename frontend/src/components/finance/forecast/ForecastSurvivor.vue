<script setup lang="ts">
import { computed } from 'vue'
import type { ForecastPerson, ForecastSurvivorCheck } from '../../../api/finance'
import { formatEur } from './forecastModel'
import ScrollX from '../../layout/ScrollX.vue'

/**
 * "What if X dies at …?" for every age from now on (#1341). One cell per
 * age: green when the survivor's money lasts (the number is what is left
 * at the end), red when it runs out (the number is the year). A click
 * puts that death into the scenario.
 */

const props = defineProps<{
  check: ForecastSurvivorCheck
  person: ForecastPerson
  real: boolean
  inflationRate: number
  startYear: number
  endYear: number
}>()

const emit = defineEmits<{ (e: 'pick', age: number): void }>()

const maxWealth = computed(() => Math.max(1, ...props.check.rows.filter((r) => r.ok).map((r) => r.finalWealth)))

function shown(v: number): number {
  return props.real ? v / Math.pow(1 + props.inflationRate, props.endYear - props.startYear) : v
}

function style(r: ForecastSurvivorCheck['rows'][number]): Record<string, string> {
  if (!r.ok) return { background: 'rgba(239, 68, 68, 0.28)' }
  const t = Math.max(0.12, Math.min(0.6, r.finalWealth / maxWealth.value))
  return { background: `rgba(16, 185, 129, ${t.toFixed(2)})` }
}

function title(r: ForecastSurvivorCheck['rows'][number]): string {
  return r.ok ? `Restvermögen am Ende: ${formatEur(shown(r.finalWealth))}` : `Geld geht ${r.failYear ?? '?'} aus`
}

const worst = computed(() => props.check.rows.find((r) => r.age === props.check.worstAge) ?? null)
const failing = computed(() => props.check.rows.filter((r) => !r.ok).length)
</script>

<template>
  <div class="survivor" data-testid="survivor-check">
    <p v-if="worst" class="survivor__summary">
      <template v-if="failing === 0">Stirbt {{ person.label }} in irgendeinem Jahr, reicht das Geld trotzdem; am knappsten wird es bei einem Tod mit {{ worst.age }} ({{ worst.year }}).</template>
      <template v-else-if="failing === check.rows.length">In keinem Jahr reicht das Geld nach dem Tod von {{ person.label }}; am frühesten geht es aus bei einem Tod mit {{ worst.age }} ({{ worst.year }}).</template>
      <template v-else>
        Bei einem Tod von {{ person.label }} in {{ failing }} von {{ check.rows.length }} Jahren geht das Geld aus; am schlimmsten wäre {{ worst.age }} ({{ worst.year }}).
      </template>
    </p>
    <ScrollX>
      <div class="survivor__strip" role="list" :aria-label="`Tod von ${person.label} je Alter`">
        <button
          v-for="r in check.rows"
          :key="r.age"
          type="button"
          role="listitem"
          class="survivor__cell"
          :class="{ 'survivor__cell--worst': r.age === check.worstAge }"
          :style="style(r)"
          :title="title(r)"
          :aria-label="`${person.label} stirbt mit ${r.age} (${r.year}): ${title(r)}`"
          @click="emit('pick', r.age)"
        >
          <span class="survivor__age">{{ r.age }}</span>
          <span class="survivor__value">{{ r.ok ? formatEur(shown(r.finalWealth)).replace(/\s?€/, '') : r.failYear }}</span>
        </button>
      </div>
    </ScrollX>
  </div>
</template>

<style scoped>
.survivor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.survivor__summary {
  margin: 0;
}
.survivor__strip {
  display: flex;
  gap: 2px;
}
.survivor__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 56px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: 4px;
  color: var(--p-text-color);
  font: inherit;
  cursor: pointer;
}
.survivor__cell--worst {
  box-shadow: inset 0 0 0 2px var(--p-primary-color);
}
.survivor__cell:hover {
  filter: brightness(0.95);
}
.survivor__cell:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.survivor__age {
  font-weight: 600;
}
.survivor__value {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
