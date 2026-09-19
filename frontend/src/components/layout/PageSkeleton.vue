<script setup lang="ts">
import Skeleton from 'primevue/skeleton'

/**
 * The placeholder a list shows while its first page is loading
 * (issue #1272, stage 3; concept §3).
 *
 * Only for the *first* load: once rows exist, a refresh keeps them on
 * screen and the toolbar's spinner carries the news instead.
 */

withDefaults(
  defineProps<{
    variant?: 'list' | 'grid' | 'table'
    /** How many placeholder rows or tiles to draw. */
    count?: number
  }>(),
  { variant: 'list', count: 6 },
)
</script>

<template>
  <div :class="['page-skeleton', `page-skeleton--${variant}`]" data-testid="page-skeleton" aria-busy="true">
    <template v-if="variant === 'grid'">
      <Skeleton v-for="i in count" :key="i" height="9rem" border-radius="8px" />
    </template>
    <template v-else-if="variant === 'table'">
      <Skeleton v-for="i in count" :key="i" height="2.5rem" border-radius="6px" />
    </template>
    <template v-else>
      <div v-for="i in count" :key="i" class="page-skeleton__row">
        <Skeleton shape="circle" size="2.25rem" />
        <div class="page-skeleton__lines">
          <Skeleton width="60%" height="0.85rem" />
          <Skeleton width="35%" height="0.7rem" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) 0;
}

.page-skeleton--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(12rem, 100%), 1fr));
  gap: var(--space-2);
}

.page-skeleton__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.page-skeleton__lines {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
</style>
