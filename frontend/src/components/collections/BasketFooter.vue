<script setup lang="ts">
/**
 * The line every basket drawer ends with (#1548): empty the whole pile,
 * export it, or keep it as a collection. Whatever a module can do with its
 * own kind stands above it.
 */
import { ref } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import SaveBasketDialog from './SaveBasketDialog.vue'
import ExportDialog from './ExportDialog.vue'
import { useBasketStore } from '../../stores/basket'

const emit = defineEmits<{
  (e: 'saved', name: string): void
  (e: 'cleared'): void
}>()

const basket = useBasketStore()
const confirm = useConfirm()
const saveOpen = ref(false)
const exportOpen = ref(false)

/** Pending writes first, so the export sees what the drawer shows. */
async function openExport() {
  await basket.flush()
  await basket.load()
  exportOpen.value = true
}

function confirmClear() {
  confirm.require({
    header: 'Basket leeren?',
    message: `Alle ${basket.count} Einträge werden aus dem Basket genommen. Die Dinge selbst bleiben erhalten.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Leeren',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: () => {
      void basket.clear()
      emit('cleared')
    },
  })
}
</script>

<template>
  <div class="basket-footer">
    <Button label="Leeren" severity="danger" text icon="pi pi-trash" size="small" :disabled="basket.count === 0" @click="confirmClear" />
    <span class="basket-footer-spacer" />
    <Button
      label="Exportieren"
      icon="pi pi-download"
      size="small"
      text
      :disabled="basket.count === 0"
      data-testid="basket-export"
      @click="openExport"
    />
    <Button
      label="Als Sammelmappe speichern"
      icon="pi pi-folder-plus"
      size="small"
      :disabled="basket.count === 0"
      data-testid="shared-basket-save"
      @click="saveOpen = true"
    />
    <SaveBasketDialog v-model:visible="saveOpen" @saved="(c) => emit('saved', c.name)" />
    <ExportDialog v-model:visible="exportOpen" :collection-id="basket.id" name="Basket" />
  </div>
</template>

<style scoped>
.basket-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.basket-footer-spacer {
  flex: 1 1 auto;
}
</style>
