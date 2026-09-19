<script setup lang="ts">
import Button from 'primevue/button'

/**
 * The one "nothing here" panel (issue #1272, stage 3; concept §3).
 *
 * Shown when a list finished loading with no rows. When the emptiness is
 * the filter's doing, the way out is offered right here instead of leaving
 * the user to find the toolbar again.
 */

withDefaults(
  defineProps<{
    /** PrimeIcons class; a neutral inbox icon by default. */
    icon?: string
    title: string
    /** One explaining line under the title. */
    message?: string
    /** Filters are active, so offer to clear them. */
    filtered?: boolean
  }>(),
  { icon: 'pi pi-inbox', message: undefined, filtered: false },
)

defineEmits<{
  (e: 'clear-filters'): void
}>()
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <i :class="['empty-state__icon', icon]" aria-hidden="true" />
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="message" class="empty-state__message">{{ message }}</p>
    <div class="empty-state__actions">
      <Button
        v-if="filtered"
        label="Filter zurücksetzen"
        icon="pi pi-filter-slash"
        size="small"
        outlined
        data-testid="empty-clear-filters"
        @click="$emit('clear-filters')"
      />
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-3);
  text-align: center;
  min-width: 0;
}

.empty-state__icon {
  font-size: 2rem;
  color: var(--p-text-muted-color);
  opacity: 0.7;
}

.empty-state__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--p-text-color);
}

.empty-state__message {
  margin: 0;
  max-width: 34rem;
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  line-height: 1.5;
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}
.empty-state__actions:empty {
  display: none;
}
</style>
