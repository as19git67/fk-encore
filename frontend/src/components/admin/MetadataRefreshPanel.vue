<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import { getPhotosToRefreshMetadata, refreshPhotoMetadata } from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { isActive } = useScanQueueStatus()

const refreshingMetadata = ref(false)
const refreshProgress = ref(0)
const refreshTotal = ref(0)
const refreshCurrent = ref(0)
const metaError = ref('')

async function handleRefreshMetadata() {
  if (refreshingMetadata.value) return
  refreshingMetadata.value = true
  refreshProgress.value = 0
  refreshCurrent.value = 0
  refreshTotal.value = 0
  metaError.value = ''
  try {
    const res = await getPhotosToRefreshMetadata()
    if (res.ids.length === 0) { refreshingMetadata.value = false; return }
    refreshTotal.value = res.ids.length
    for (const id of res.ids) {
      try { await refreshPhotoMetadata(id) } catch {}
      refreshCurrent.value++
      refreshProgress.value = Math.round((refreshCurrent.value / refreshTotal.value) * 100)
    }
  } catch (err: any) {
    metaError.value = err.message || 'Fehler beim Aktualisieren der Metadaten'
  } finally {
    refreshingMetadata.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>Metadaten aktualisieren</h3>
    <p>
      Aufnahmedatum und andere EXIF-Metadaten werden für Fotos ohne gespeichertes Datum neu eingelesen.
    </p>

    <Message v-if="metaError" severity="error" class="data-management-group__item" @close="metaError = ''">{{ metaError }}</Message>

    <div v-if="refreshingMetadata" class="data-management-group__item">
      <span class="text-secondary">Metadaten werden aktualisiert… {{ refreshCurrent }} / {{ refreshTotal }}</span>
      <ProgressBar :value="refreshProgress" :showValue="false" style="margin-top:0.5rem" />
    </div>

    <Button class="data-management-group__item"
      icon="pi pi-refresh"
      outlined
      label="Metadaten aktualisieren"
      :disabled="refreshingMetadata || isActive"
      :loading="refreshingMetadata"
      @click="handleRefreshMetadata"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
