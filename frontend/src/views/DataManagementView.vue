<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import {
  getScanQueueStatus, rescanPhotos, retryFailedScans, findPhotoGroups,
  getPhotosToRefreshMetadata, refreshPhotoMetadata,
  type ScanQueueStatus,
} from '../api/photos'

// ── Scan Queue ────────────────────────────────────────────────────────────────

const queueStatus = ref<ScanQueueStatus>({ services: [] })
const queueError = ref('')
const rescanLoading = ref(false)
const retryLoading = ref(false)
let pollInterval: ReturnType<typeof setInterval> | null = null

const serviceLabels: Record<string, string> = {
  embedding: 'Embeddings',
  face_detection: 'Gesichtserkennung',
  landmark: 'Sehenswürdigkeiten',
  quality: 'Qualität',
}

const totalPending = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.pending, 0)
)
const totalProcessing = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.processing, 0)
)
const totalFailed = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.failed, 0)
)
const isActive = computed(() => totalPending.value > 0 || totalProcessing.value > 0)

async function fetchQueueStatus() {
  try {
    queueStatus.value = await getScanQueueStatus()
  } catch {
    // ignore polling errors
  }
}

function startPolling() {
  if (pollInterval) return
  pollInterval = setInterval(fetchQueueStatus, 5000)
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

async function handleRescan(force: boolean) {
  queueError.value = ''
  rescanLoading.value = true
  try {
    await rescanPhotos(force)
    await fetchQueueStatus()
    startPolling()
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Starten des Scans'
  } finally {
    rescanLoading.value = false
  }
}

async function handleRetry() {
  queueError.value = ''
  retryLoading.value = true
  try {
    await retryFailedScans()
    await fetchQueueStatus()
    startPolling()
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    retryLoading.value = false
  }
}

// ── Foto-Gruppen ──────────────────────────────────────────────────────────────

const groupingResult = ref<{ groups_created: number; total_photos_grouped: number } | null>(null)
const groupingLoading = ref(false)
const groupingError = ref('')

async function handleFindGroups() {
  groupingResult.value = null
  groupingError.value = ''
  groupingLoading.value = true
  try {
    groupingResult.value = await findPhotoGroups()
  } catch (err: any) {
    groupingError.value = err.message || 'Fehler beim Gruppieren'
  } finally {
    groupingLoading.value = false
  }
}

// ── Metadaten ─────────────────────────────────────────────────────────────────

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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await fetchQueueStatus()
  if (isActive.value) startPolling()
})

onUnmounted(() => stopPolling())
</script>

<template>
  <div class="data-management-view">
    <h2>Datenverwaltung</h2>

    <!-- Scan Queue -->
    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-1">Scan-Queue</h3>
      <p class="text-secondary mb-3">
        Hochgeladene Fotos werden im Hintergrund durch Gesichtserkennung, Embedding-Berechnung
        und Sehenswürdigkeiten-Erkennung geschickt.
      </p>

      <Message v-if="queueError" severity="error" class="mb-3" @close="queueError = ''">{{ queueError }}</Message>

      <!-- Status-Tabelle -->
      <table class="queue-table mb-4">
        <thead>
          <tr>
            <th>Service</th>
            <th>Ausstehend</th>
            <th>Läuft</th>
            <th>Fehler</th>
            <th>Erledigt</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="svc in queueStatus.services" :key="svc.service">
            <td>{{ serviceLabels[svc.service] ?? svc.service }}</td>
            <td>
              <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
              <span v-else class="text-secondary">—</span>
            </td>
            <td>
              <span v-if="svc.processing > 0" class="badge badge-processing">
                <i class="pi pi-spin pi-spinner" style="font-size:0.7rem" />
                {{ svc.processing }}
              </span>
              <span v-else class="text-secondary">—</span>
            </td>
            <td>
              <span v-if="svc.failed > 0" class="badge badge-failed">{{ svc.failed }}</span>
              <span v-else class="text-secondary">—</span>
            </td>
            <td class="text-secondary">{{ svc.done }}</td>
          </tr>
          <tr v-if="queueStatus.services.length === 0">
            <td colspan="5" class="text-secondary" style="text-align:center">Keine Daten</td>
          </tr>
        </tbody>
      </table>

      <div v-if="isActive" class="status-progress">
        <span class="text-secondary" style="font-size:0.85rem">
          <i class="pi pi-spin pi-spinner mr-1" />
          {{ totalProcessing }} werden verarbeitet, {{ totalPending }} warten…
        </span>
        <ProgressBar class="status-progress__bar" mode="indeterminate" />
      </div>

      <div v-if="!isActive" class="button-row">
        <Button
          icon="pi pi-search-plus"
          label="Fehlende Scans starten"
          severity="secondary"
          :loading="rescanLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRescan(false)"
        />
        <Button
          icon="pi pi-refresh"
          label="Alles neu scannen"
          severity="secondary"
          :loading="rescanLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRescan(true)"
        />
        <Button
          v-if="totalFailed > 0"
          icon="pi pi-replay"
          :label="`${totalFailed} Fehler wiederholen`"
          severity="warn"
          :loading="retryLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRetry"
        />
      </div>
    </div>

    <!-- Foto-Gruppen -->
    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-1">Ähnliche Fotos gruppieren</h3>
      <p class="text-secondary mb-3">
        Ähnliche Fotos werden anhand der Embeddings automatisch zu Gruppen zusammengefasst.
      </p>

      <Message v-if="groupingError" severity="error" class="mb-3" @close="groupingError = ''">{{ groupingError }}</Message>

      <div v-if="groupingResult" class="mb-3">
        <Message severity="info" :closable="false">
          {{ groupingResult.groups_created }} neue Gruppen erstellt
          ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
        </Message>
      </div>

      <Button
        icon="pi pi-images"
        label="Gruppen neu berechnen"
        :loading="groupingLoading"
        :disabled="groupingLoading || isActive"
        @click="handleFindGroups"
      />
    </div>

    <!-- Metadaten -->
    <div class="card p-4 mb-4 surface-card border-round shadow-1">
      <h3 class="mt-0 mb-1">Metadaten aktualisieren</h3>
      <p class="text-secondary mb-3">
        Aufnahmedatum und andere EXIF-Metadaten werden für Fotos ohne gespeichertes Datum neu eingelesen.
      </p>

      <Message v-if="metaError" severity="error" class="mb-3" @close="metaError = ''">{{ metaError }}</Message>

      <div v-if="refreshingMetadata" class="mb-3">
        <span class="text-secondary">Metadaten werden aktualisiert… {{ refreshCurrent }} / {{ refreshTotal }}</span>
        <ProgressBar :value="refreshProgress" :showValue="false" style="margin-top:0.5rem" />
      </div>

      <Button
        icon="pi pi-refresh"
        label="Metadaten aktualisieren"
        :disabled="refreshingMetadata || isActive"
        :loading="refreshingMetadata"
        @click="handleRefreshMetadata"
      />
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 800px) {
  .data-management-view {
    margin-inline: 0.5em;
  }
}

.status-progress {
  display: flex;
  flex-direction: column;
  margin-block: 0.25em;
}

.status-progress .text-secondary {
  display: flex;
  align-items: center;
  gap: 0.5em;
}

.status-progress .status-progress__bar {
  display: flex;
  margin-block: 0.5em;
  height: 4px;
}

.button-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.queue-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.queue-table th,
.queue-table td {
  padding: 0.4rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--surface-border);
}
.queue-table th {
  color: var(--text-color-secondary);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.8rem;
  font-weight: 600;
}
.badge-pending  { background: var(--blue-100);   color: var(--blue-700); }
.badge-processing { background: var(--yellow-100); color: var(--yellow-700); }
.badge-failed   { background: var(--red-100);    color: var(--red-700); }
</style>
