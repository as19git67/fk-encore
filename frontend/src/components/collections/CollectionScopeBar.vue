<script setup lang="ts">
/**
 * "Nur aus der Sammelmappe X" above a list that has no filter toolbar of its
 * own yet (#1548, stage 3) — the same chip a ListToolbar shows, standing
 * alone. Removing it shows the whole list again.
 */
import Button from 'primevue/button'
import { collectionName } from '../../composables/useCollectionNames'

defineProps<{ collectionId: number }>()
const emit = defineEmits<{ (e: 'clear'): void }>()
</script>

<template>
  <div class="collection-scope" data-testid="collection-scope">
    <i class="pi pi-folder" aria-hidden="true" />
    <span>Sammelmappe: {{ collectionName(collectionId) }}</span>
    <Button
      icon="pi pi-times"
      text
      rounded
      size="small"
      aria-label="Sammelmappen-Filter entfernen"
      @click="emit('clear')"
    />
  </div>
</template>

<style scoped>
.collection-scope {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 0 0 var(--space-3);
  border-radius: 999px;
  background: var(--p-content-hover-background);
  color: var(--p-text-color);
  font-size: var(--text-sm);
}
</style>
