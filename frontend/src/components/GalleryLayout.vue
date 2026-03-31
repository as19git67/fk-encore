<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'

const props = defineProps<{
  centerRef?: (el: HTMLElement | null) => void
}>()

function setCenterRef(el: Element | ComponentPublicInstance | null) {
  props.centerRef?.(el instanceof HTMLElement ? el : null)
}
</script>

<template>
  <div class="gallery-layout">
    <nav v-if="$slots.left" class="timeline-nav">
      <slot name="left" />
    </nav>
    <div class="photo-grid-scroll" :ref="setCenterRef">
      <slot />
    </div>
    <slot name="right" />
  </div>
</template>

<style scoped>
.gallery-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.timeline-nav {
  width: 80px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 1rem 0.5rem;
  background: var(--surface-card, #ffffff);
  border-right: 1px solid var(--surface-border, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0 1rem 1rem;
}
</style>

