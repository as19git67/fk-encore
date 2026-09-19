<script setup lang="ts">
import PageLayout from '../layout/PageLayout.vue'

/**
 * Page shell for the admin/settings pages that were carved out of the old
 * DataManagementView. Since issue #1272 it is a thin wrapper around
 * PageLayout (the title, the width, the document title all come from
 * there); what remains here is the column of panels.
 *
 * The per-section look lives in `adminPanels.css` and is imported by the
 * panels themselves rather than applied from here — scoped styles do not
 * reach slotted content, so a wrapper cannot style what it is handed.
 */
defineProps<{ title: string }>()
</script>

<template>
  <PageLayout :title="title" width="normal">
    <div class="admin-panels">
      <slot />
    </div>
  </PageLayout>
</template>

<style scoped>
.admin-panels {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
</style>
