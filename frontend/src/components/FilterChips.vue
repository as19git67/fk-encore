<script setup lang="ts">
import Chip from 'primevue/chip'
import type { FilterChip } from './layout/listToolbar'

/**
 * Compact summary of the applied filter, as removable chips.
 *
 * Generic since stage 3 (#1272): a chip carries its own `remove()`, so the
 * component knows nothing about photos, documents or transactions. Each
 * domain builds its chips in its own filter composable.
 */

defineProps<{
  chips: FilterChip[]
}>()
</script>

<template>
  <div v-if="chips.length" class="filter-chips" data-testid="filter-chips">
    <Chip
      v-for="chip in chips"
      :key="chip.key"
      :label="chip.label"
      removable
      @remove="chip.remove()"
    />
  </div>
</template>

<style scoped>
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
}
</style>
