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
  background: var(--p-yellow-100);
  border-bottom: 1px solid var(--p-yellow-300);
  font-size: 0.82rem;
  color: var(--p-yellow-900);
}

.service-status-bar__icon {
  color: var(--p-yellow-600);
  flex-shrink: 0;
}

.service-status-bar__text {
  font-weight: 600;
  flex-shrink: 0;
}

.service-status-bar__badge {
  background: var(--p-yellow-200);
  border: 1px solid var(--p-yellow-400);
  border-radius: 0.75rem;
  padding: 0.1rem 0.6rem;
  font-weight: 500;
  cursor: default;
}

.service-status-bar__hint {
  color: var(--p-yellow-700);
  font-style: italic;
}

@media (prefers-color-scheme: dark) {
  .service-status-bar {
    background: var(--p-yellow-900);
    border-bottom-color: var(--p-yellow-700);
    color: var(--p-yellow-100);
  }

  .service-status-bar__icon {
    color: var(--p-yellow-300);
  }

  .service-status-bar__badge {
    background: var(--p-yellow-800);
    border-color: var(--p-yellow-600);
  }

  .service-status-bar__hint {
    color: var(--p-yellow-200);
  }
}
</style>

