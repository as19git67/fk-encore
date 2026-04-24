<script setup lang="ts">
/**
 * Placeholder for Etappe 9 (Natural-Language-Analyse).
 * Only the route + nav entry is wired up in Etappe 8 so the module
 * menu matches the architecture plan; the parsing/aggregation
 * backend doesn't exist yet.
 */
import Message from 'primevue/message'
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Analyse</h1>
    </header>
    <Message severity="info" :closable="false">
      Die Natural-Language-Analyse ist für Etappe 9 geplant. Bis dahin
      nutze die Filter auf der Umsätze-Ansicht und die Tag-Liste.
    </Message>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
}
.page-header h1 {
  margin: 0;
}
</style>
