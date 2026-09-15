<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { recomputeAutoCrops } from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { isActive } = useScanQueueStatus()

const autoCropLoading = ref(false)
const autoCropResult = ref<{ updated: number } | null>(null)
const autoCropError = ref('')

async function handleRecomputeAutoCrops() {
  autoCropResult.value = null
  autoCropError.value = ''
  autoCropLoading.value = true
  try {
    autoCropResult.value = await recomputeAutoCrops()
  } catch (err: any) {
    autoCropError.value = err.message || 'Fehler beim Berechnen der Auto-Crops'
  } finally {
    autoCropLoading.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>Auto-Crop neu berechnen</h3>
    <p>
      Berechnet den Fokuspunkt für Thumbnail-Ausschnitte anhand erkannter Gesichter
      und Sehenswürdigkeiten. Hochkant-Bilder werden so verschoben, dass der wichtigste
      Bereich sichtbar ist.
    </p>

    <Message v-if="autoCropError" severity="error" class="data-management-group__item" @close="autoCropError = ''">{{ autoCropError }}</Message>

    <div v-if="autoCropResult" class="data-management-group__item">
      <Message severity="info" :closable="false">
        {{ autoCropResult.updated }} Fotos aktualisiert.
      </Message>
    </div>

    <Button class="data-management-group__item"
      icon="pi pi-arrows-alt"
      outlined
      label="Auto-Crop neu berechnen"
      :loading="autoCropLoading"
      :disabled="autoCropLoading || isActive"
      @click="handleRecomputeAutoCrops"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
