<script setup lang="ts">
/**
 * Page shell for the admin/settings pages that were carved out of the old
 * DataManagementView: the flex column, the page padding and the <h1>.
 *
 * The per-section look lives in `adminPanels.css` and is imported by the
 * panels themselves rather than applied from here — scoped styles do not
 * reach slotted content, so a wrapper cannot style what it is handed.
 */
defineProps<{ title: string }>()
</script>

<template>
  <div class="data-management-view">
    <h1 class="title">{{ title }}</h1>
    <slot />
  </div>
</template>

<style scoped>
.data-management-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
  padding-inline: 0.25em;
}

@media (min-width: 800px) {
  .data-management-view {
    margin-inline: 0.5em;
  }
}

.data-management-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}
</style>
