<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import { reindexAllPhotos, getReindexStatus, findPhotoGroups, type ReindexStatus } from '../api/photos'

const status = ref<ReindexStatus>({ inProgress: false, total: 0, processed: 0, errors: 0 })
const error = ref('')
const loading = ref(false)
const groupingLoading = ref(false)
const groupingResult = ref<{ groups_created: number; total_photos_grouped: number } | null>(null)
let pollInterval: ReturnType<typeof setInterval> | null = null

const progress = computed(() => {
  if (!status.value.total) return 0
  return Math.round((status.value.processed / status.value.total) * 100)
})

async function fetchStatus() {
  try {
    status.value = await getReindexStatus()
  } catch (err: any) {
    // ignore polling errors
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

async function handleFindGroups() {
  error.value = ''
  groupingLoading.value = true
  groupingResult.value = null
  try {
    groupingResult.value = await findPhotoGroups()
  } catch (err: any) {
    error.value = err.message || 'Fehler bei der Gruppierung'
  } finally {
    groupingLoading.value = false
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

// Watch for completion and stop polling
const checkCompletion = setInterval(() => {
  if (!status.value.inProgress && pollInterval) {
    stopPolling()
  }
}, 1000)
onUnmounted(() => clearInterval(checkCompletion))
</script>

<template>
  <div>
    <h2>Datenverwaltung</h2>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-3">Fotos neu scannen</h3>
      <p class="text-secondary mb-4">
        Alle Fotos werden erneut durch die Gesichtserkennung und Embedding-Berechnung geschickt.
        Bestehende Zuordnungen werden dabei aktualisiert.
      </p>

      <div v-if="status.inProgress" class="mb-4">
        <div class="flex justify-between mb-2">
          <span class="font-medium">Fortschritt</span>
          <span class="text-secondary">
            {{ status.processed }} von {{ status.total }} Fotos
            <template v-if="status.errors > 0">
              ({{ status.errors }} Fehler)
            </template>
          </span>
        </div>
        <ProgressBar :value="progress" :showValue="true" />
      </div>

      <div v-else-if="status.total > 0 && !status.inProgress" class="mb-4">
        <Message severity="success" :closable="false">
          Letzter Scan abgeschlossen: {{ status.processed }} von {{ status.total }} Fotos verarbeitet.
          <template v-if="status.errors > 0">
            {{ status.errors }} Fehler aufgetreten.
          </template>
        </Message>
      </div>

      <Button
        icon="pi pi-images"
        label="Alle neu scannen"
        @click="handleReindex"
        :disabled="status.inProgress"
        :loading="loading"
      />
    </div>

    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-3">Ähnliche Fotos gruppieren</h3>
      <p class="text-secondary mb-4">
        Fotos werden anhand visueller Ähnlichkeit und zeitlicher Nähe automatisch gruppiert.
        Bereits bearbeitete Gruppen bleiben erhalten.
      </p>

      <div v-if="groupingResult" class="mb-4">
        <Message severity="success" :closable="false">
          {{ groupingResult.groups_created }} neue Gruppen erstellt
          ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
        </Message>
      </div>

      <Button
        icon="pi pi-objects-column"
        label="Gruppen aktualisieren"
        @click="handleFindGroups"
        :loading="groupingLoading"
      />
    </div>
  </div>
</template>
