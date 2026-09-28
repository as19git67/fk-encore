<script setup lang="ts">
import { computed } from 'vue'
import type { ForecastPerson, ForecastReverse, ForecastReverseLever } from '../../../api/finance'
import { formatEur, formatPct } from './forecastModel'

/**
 * "I want to leave at X — what does it take?" (#1340). One line per lever,
 * each on its own with everything else unchanged; or the monthly buffer
 * when X already works.
 */

const props = defineProps<{
  reverse: ForecastReverse
  person: ForecastPerson
  /** The scenario's return, to say "instead of 4 %". */
  currentReturnRate: number
}>()

interface Line {
  key: string
  label: string
  value: string
  reachable: boolean
}

function line(l: ForecastReverseLever): Line {
  switch (l.key) {
    case 'savings':
      return {
        key: l.key,
        label: `Zusätzlich sparen bis zum Ausstieg`,
        value: l.value == null ? `mehr als ${formatEur(l.bound)} im Monat` : `${formatEur(l.value)} im Monat`,
        reachable: l.value != null,
      }
    case 'spending':
      return {
        key: l.key,
        label: 'Weniger ausgeben ab dem Ausstieg',
        value:
          l.value == null
            ? `mehr als ${Math.round(l.bound * 100)} % der Lebenshaltung`
            : `${Math.round(l.value * 100)} % (${formatEur(l.monthlyAmount)} im Monat weniger)`,
        reachable: l.value != null,
      }
    case 'return':
      return {
        key: l.key,
        label: `Rendite auf Depot und Sonstiges (statt ${formatPct(props.currentReturnRate)})`,
        value: l.value == null ? `mehr als ${formatPct(l.bound)}` : formatPct(l.value),
        reachable: l.value != null,
      }
    case 'one_off':
      return {
        key: l.key,
        label: 'Einmalbetrag heute (Erbe, Bonus, Verkauf)',
        value: l.value == null ? `mehr als ${formatEur(l.bound)}` : formatEur(l.value),
        reachable: l.value != null,
      }
  }
}

const lines = computed(() => props.reverse.levers.map(line))
const none = computed(() => lines.value.length > 0 && lines.value.every((l) => !l.reachable))
</script>

<template>
  <div class="target" data-testid="target-age">
    <template v-if="reverse.reachable">
      <p class="target__verdict target__verdict--ok">
        {{ person.label }} kann mit {{ reverse.targetAge }} aufhören.
        <template v-if="(reverse.bufferMonthly ?? 0) > 0">
          Der Haushalt könnte sogar <strong>{{ formatEur(reverse.bufferMonthly) }} im Monat</strong> mehr ausgeben (heutige Kaufkraft).
        </template>
        <template v-else>Viel Luft ist dabei nicht.</template>
      </p>
    </template>
    <template v-else>
      <p class="target__verdict target__verdict--gap">
        Mit {{ reverse.targetAge }} reicht es für {{ person.label }} so nicht. Eines davon würde genügen, alles andere unverändert:
      </p>
      <ul class="target__levers">
        <li v-for="l in lines" :key="l.key" :class="{ 'target__lever--out': !l.reachable }">
          <span>{{ l.label }}</span>
          <strong>{{ l.value }}</strong>
        </li>
      </ul>
      <p v-if="none" class="target__none">Keiner der Hebel reicht in vernünftigen Grenzen — der Zeitpunkt ist so nicht erreichbar.</p>
    </template>
  </div>
</template>

<style scoped>
.target {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.target__verdict {
  margin: 0;
}
.target__verdict--ok {
  color: var(--p-text-color);
}
.target__levers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.target__levers li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: var(--text-base);
}
.target__levers li:last-child {
  border-bottom: none;
}
.target__levers strong {
  white-space: nowrap;
  text-align: right;
}
.target__lever--out {
  color: var(--p-text-muted-color);
}
.target__none {
  margin: 0;
  color: var(--p-text-muted-color);
}
</style>
