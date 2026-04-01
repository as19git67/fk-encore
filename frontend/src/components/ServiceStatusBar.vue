<script setup lang="ts">
import { useServiceHealthStore } from '../stores/serviceHealth'

const store = useServiceHealthStore()

const serviceLabels: Record<string, string> = {
  insightface: 'Gesichtserkennung',
  embedding: 'Embedding',
  landmark: 'Gebäudeerkennung',
}
</script>

<template>
  <div v-if="store.hasUnavailableServices" class="service-status-bar">
    <i class="pi pi-exclamation-triangle service-status-bar__icon" />
    <span class="service-status-bar__text">Dienste nicht verfügbar:</span>
    <span
      v-for="svc in store.services.filter(s => !s.available)"
      :key="svc.name"
      class="service-status-bar__badge"
      :title="svc.lastError ?? undefined"
    >
      {{ serviceLabels[svc.name] ?? svc.name }}
    </span>
    <span class="service-status-bar__hint">Verarbeitung wird automatisch fortgesetzt, sobald die Dienste erreichbar sind.</span>
  </div>
</template>

<style scoped>
.service-status-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.4rem 1rem;
  background: var(--yellow-100, #fef9c3);
  border-bottom: 1px solid var(--yellow-300, #fde047);
  font-size: 0.82rem;
  color: var(--yellow-900, #713f12);
}

.service-status-bar__icon {
  color: var(--yellow-600, #ca8a04);
  flex-shrink: 0;
}

.service-status-bar__text {
  font-weight: 600;
  flex-shrink: 0;
}

.service-status-bar__badge {
  background: var(--yellow-200, #fef08a);
  border: 1px solid var(--yellow-400, #facc15);
  border-radius: 0.75rem;
  padding: 0.1rem 0.6rem;
  font-weight: 500;
  cursor: default;
}

.service-status-bar__hint {
  color: var(--yellow-700, #a16207);
  font-style: italic;
}
</style>

