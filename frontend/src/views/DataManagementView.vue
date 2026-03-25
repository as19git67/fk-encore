<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import {
  reindexAllPhotos, getReindexStatus, findPhotoGroups,
  getPhotosToRefreshMetadata, refreshPhotoMetadata,
  type ReindexStatus,
} from '../api/photos'

const status = ref<ReindexStatus>({ inProgress: false, total: 0, processed: 0, errors: 0 })
const error = ref('')
const loading = ref(false)
const groupingResult = ref<{ groups_created: number; total_photos_grouped: number } | null>(null)
const groupingLoading = ref(false)

// Metadata refresh
const refreshingMetadata = ref(false)
const refreshProgress = ref(0)
const refreshTotal = ref(0)
const refreshCurrent = ref(0)
const metaError = ref('')

let pollInterval: ReturnType<typeof setInterval> | null = null

const progress = computed(() => {
  if (!status.value.total) return 0
  return Math.round((status.value.processed / status.value.total) * 100)
})

async function fetchStatus() {
  try {
    const prevInProgress = status.value.inProgress
    status.value = await getReindexStatus()
    // Auto-find groups when reindex completes
    if (prevInProgress && !status.value.inProgress) {
      stopPolling()
      await autoFindGroups()
    }
  } catch (err: any) {
    // ignore polling errors
  }
}

async function autoFindGroups() {
  groupingResult.value = null
  groupingLoading.value = true
  try {
    groupingResult.value = await findPhotoGroups()
  } catch (err: any) {
    // non-critical — silently ignore
  } finally {
    groupingLoading.value = false
  }
}

function startPolling() {
  if (pollInterval) return
  pollInterval = setInterval(fetchStatus, 2000)
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

async function handleReindex() {
  error.value = ''
  loading.value = true
  groupingResult.value = null
  try {
    await reindexAllPhotos()
    await fetchStatus()
    startPolling()
  } catch (err: any) {
    if (err.message?.includes('already in progress')) {
      error.value = 'Ein Scan-Vorgang läuft bereits.'
    } else {
      error.value = err.message || 'Fehler beim Starten des Re-Indexings'
    }
  } finally {
    loading.value = false
  }
}

async function handleRefreshMetadata() {
  if (refreshingMetadata.value) return

  refreshingMetadata.value = true
  refreshProgress.value = 0
  refreshCurrent.value = 0
  refreshTotal.value = 0
  metaError.value = ''

  try {
    const res = await getPhotosToRefreshMetadata()
    const ids = res.ids

    if (ids.length === 0) {
      refreshingMetadata.value = false
      return
    }

    refreshTotal.value = ids.length

    for (const id of ids) {
      try {
        await refreshPhotoMetadata(id)
      } catch (err) {
        console.error(`Fehler beim Aktualisieren der Metadaten für Foto ${id}:`, err)
      }
      refreshCurrent.value++
      refreshProgress.value = Math.round((refreshCurrent.value / refreshTotal.value) * 100)
    }
  } catch (err: any) {
    metaError.value = err.message || 'Fehler beim Aktualisieren der Metadaten'
  } finally {
    refreshingMetadata.value = false
  }
}

onMounted(async () => {
  await fetchStatus()
  if (status.value.inProgress) {
    startPolling()
  }
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <div>
    <h2>Datenverwaltung</h2>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-3">Fotos neu scannen</h3>
      <p class="text-secondary mb-4">
        Alle Fotos werden erneut durch die Gesichtserkennung und Embedding-Berechnung geschickt.
        Bestehende Zuordnungen werden dabei aktualisiert. Anschließend werden ähnliche Fotos automatisch gruppiert.
      </p>

      <div v-if="status.inProgress" class="mb-4">
        <div class="flex justify-between mb-2">
          <span class="text-secondary">
            Fortschritt: {{ status.processed }} von {{ status.total }} Fotos
            <template v-if="status.errors > 0"> ({{ status.errors }} Fehler)</template>
            {{ progress }} %
          </span>
        </div>
        <ProgressBar :value="progress" :showValue="false" />
      </div>

      <div v-else-if="status.total > 0 && !status.inProgress" class="mb-4">
        <Message severity="success" :closable="false">
          Letzter Scan abgeschlossen: {{ status.processed }} von {{ status.total }} Fotos verarbeitet.
          <template v-if="status.errors > 0">
            {{ status.errors }} Fehler aufgetreten.
          </template>
        </Message>
      </div>

      <div v-if="groupingLoading" class="mb-4">
        <span class="text-secondary">
          <i class="pi pi-spin pi-spinner mr-2"></i>Ähnliche Fotos werden gruppiert…
        </span>
      </div>

      <div v-if="groupingResult" class="mb-4">
        <Message severity="info" :closable="false">
          {{ groupingResult.groups_created }} neue Gruppen erstellt
          ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
        </Message>
      </div>

      <Button
        icon="pi pi-images"
        label="Alle neu scannen"
        @click="handleReindex"
        :disabled="status.inProgress || groupingLoading"
        :loading="loading"
      />
    </div>

    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-3">Metadaten aktualisieren</h3>
      <p class="text-secondary mb-4">
        Aufnahmedatum und andere EXIF-Metadaten werden für Fotos ohne gespeichertes Datum neu eingelesen.
      </p>

      <Message v-if="metaError" severity="error" sticky class="mb-4">{{ metaError }}</Message>

      <div v-if="refreshingMetadata" class="mb-4">
        <div class="flex justify-between mb-2">
          <span class="text-secondary">
            Metadaten werden aktualisiert… {{ refreshCurrent }} / {{ refreshTotal }}
          </span>
        </div>
        <ProgressBar :value="refreshProgress" :showValue="false" />
      </div>

      <Button
        icon="pi pi-refresh"
        label="Metadaten aktualisieren"
        @click="handleRefreshMetadata"
        :disabled="refreshingMetadata"
        :loading="refreshingMetadata"
      />
    </div>
  </div>
</template>

<style scoped>
.button-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
