<script setup lang="ts">
import Button from 'primevue/button'
import Message from 'primevue/message'

/**
 * The one way a page reports that loading failed (issue #1272, stage 3;
 * concept §3). Goes into `PageLayout`'s `#notice` slot, so it sits in the
 * sticky stack and stays visible while the user scrolls.
 *
 * Load errors belong here, not in a toast: a toast disappears before the
 * user can act on it, and "try again" is the whole point.
 */

withDefaults(
  defineProps<{
    message: string
    /** Offer a retry button. */
    retryable?: boolean
    closable?: boolean
  }>(),
  { retryable: true, closable: false },
)

defineEmits<{
  (e: 'retry'): void
  (e: 'close'): void
}>()
</script>

<template>
  <Message
    severity="error"
    :closable="closable"
    data-testid="error-banner"
    @close="$emit('close')"
  >
    <span class="error-banner">
      <span class="error-banner__text">{{ message }}</span>
      <Button
        v-if="retryable"
        label="Erneut versuchen"
        icon="pi pi-refresh"
        size="small"
        text
        class="error-banner__retry"
        data-testid="error-retry"
        @click="$emit('retry')"
      />
      <slot />
    </span>
  </Message>
</template>

<style scoped>
.error-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.error-banner__text {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
