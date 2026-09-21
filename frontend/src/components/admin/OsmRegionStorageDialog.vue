<script setup lang="ts">
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import type { RegionStorage } from '../../api/osmAdmin'

defineProps<{
  visible: boolean
  loading: boolean
  error: string
  result: RegionStorage | null
}>()
defineEmits<{ 'update:visible': [value: boolean] }>()
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    header="Datenbankgröße"
    @update:visible="$emit('update:visible', $event)"
  >
    <div v-if="loading" class="storage-dialog__loading">
      <i class="pi pi-spin pi-spinner" /> Wird geladen …
    </div>
    <Message v-else-if="error" severity="error" :closable="false">{{ error }}</Message>
    <div v-else-if="result" class="storage-dialog">
      <div class="storage-dialog__summary">
        <code>{{ result.database }}</code>
        <span class="storage-dialog__total">{{ result.sizeMb }} MB</span>
      </div>

      <table class="storage-dialog__table">
        <thead>
          <tr><th>Tabelle</th><th>Gesamt</th><th>Heap</th><th>Zeilen</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in result.tables" :key="t.table">
            <td><code>{{ t.table }}</code></td>
            <td>{{ t.totalMb }} MB</td>
            <td>{{ t.tableMb }} MB</td>
            <td>{{ t.rows.toLocaleString('de-DE') }}</td>
          </tr>
        </tbody>
      </table>

      <div class="storage-dialog__pois">
        <strong>POIs: {{ result.poiTotal.toLocaleString('de-DE') }}</strong>
        <span class="storage-dialog__hint">
          {{ result.poisWithShape }} mit Umriss, {{ result.poisWithFacadeAzimuth }} mit Fassaden-Azimut
        </span>
        <ul class="storage-dialog__kinds">
          <li v-for="k in result.poisByKind" :key="k.kind">
            {{ k.kind }}: {{ k.count.toLocaleString('de-DE') }}
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <Button label="Schließen" @click="$emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.storage-dialog__loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}
.storage-dialog__summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.storage-dialog__total {
  font-size: var(--text-2xl);
  font-weight: 600;
}
.storage-dialog__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
  margin-bottom: 1rem;
}
.storage-dialog__table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: var(--text-sm);
  text-transform: uppercase;
  text-align: left;
  padding-bottom: 0.3rem;
}
.storage-dialog__table td {
  padding: 0.2rem 0;
  border-top: 1px solid var(--p-content-border-color);
}
.storage-dialog__pois {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: var(--text-base);
}
.storage-dialog__hint {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
}
.storage-dialog__kinds {
  margin: 0.3rem 0 0;
  padding-left: 1.2rem;
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
</style>
