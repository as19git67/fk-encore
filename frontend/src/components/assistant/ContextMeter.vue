<script setup lang="ts">
/**
 * How full the model's window got in the latest answer, as a thin bar and a
 * line of small print under the question field. Turns amber once the next
 * longer turn would push something out, or already has.
 */
import { computed } from 'vue'
import type { ContextUsage } from '../../api/assistant'
import { contextMeter } from '../../utils/contextUsage'

const props = defineProps<{ usage: ContextUsage }>()

const meter = computed(() => contextMeter(props.usage))
</script>

<template>
  <div class="context-meter" :class="{ 'context-meter--warn': meter.warn }" :title="meter.description">
    <span
      class="bar"
      role="meter"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="meter.percent"
      :aria-valuetext="meter.description"
      aria-label="Kontext belegt"
    >
      <span class="fill" :style="{ width: `${meter.percent}%` }" />
    </span>
    <span class="text">
      Kontext {{ meter.percent }} %<template v-for="p in meter.parts" :key="p"> · {{ p }}</template>
    </span>
  </div>
</template>

<style scoped>
.context-meter {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
  min-width: 0;
}

.bar {
  flex: 0 0 4rem;
  height: 0.25rem;
  border-radius: 0.125rem;
  background: var(--p-content-border-color);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--p-primary-color);
}

.context-meter--warn .fill {
  background: var(--p-orange-500);
}

.text {
  min-width: 0;
}
</style>
