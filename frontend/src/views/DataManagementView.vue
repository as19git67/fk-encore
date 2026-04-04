<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import {
  getScanQueueStatus, rescanPhotos, retryFailedScans, findPhotoGroups,
  getPhotosToRefreshMetadata, refreshPhotoMetadata,
  getPhotosNeedingGpsRescan, rescanPhotoGps,
  recomputeAutoCrops,
  type ScanQueueStatus,
} from '../api/photos'
import { getBuildInfo } from '../api/system'

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
  geocoding: 'Geocoding',
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

// ── GPS Re-Extraktion ─────────────────────────────────────────────────────────

const gpsRescanLoading = ref(false)
const gpsRescanProgress = ref(0)
const gpsRescanCurrent = ref(0)
const gpsRescanTotal = ref(0)
const gpsRescanResult = ref<{ gpsFound: number; geocoded: number; scansQueued: number } | null>(null)
const gpsRescanError = ref('')

async function handleGpsRescan() {
  if (gpsRescanLoading.value) return
  gpsRescanLoading.value = true
  gpsRescanProgress.value = 0
  gpsRescanCurrent.value = 0
  gpsRescanTotal.value = 0
  gpsRescanResult.value = null
  gpsRescanError.value = ''
  try {
    const { ids } = await getPhotosNeedingGpsRescan()
    if (ids.length === 0) {
      gpsRescanResult.value = { gpsFound: 0, geocoded: 0, scansQueued: 0 }
      return
    }
    gpsRescanTotal.value = ids.length
    let gpsFound = 0, geocoded = 0, scansQueued = 0
    for (const id of ids) {
      try {
        const res = await rescanPhotoGps(id)
        if (res.gpsFound) gpsFound++
        if (res.geocoded) geocoded++
        if (res.scansQueued) scansQueued++
      } catch { /* skip individual failures */ }
      gpsRescanCurrent.value++
      gpsRescanProgress.value = Math.round((gpsRescanCurrent.value / gpsRescanTotal.value) * 100)
      // Respect Nominatim rate limit (1 req/s)
      if (gpsRescanCurrent.value < ids.length) await new Promise(r => setTimeout(r, 1100))
    }
    gpsRescanResult.value = { gpsFound, geocoded, scansQueued }
    if (scansQueued > 0) startPolling()
  } catch (err: any) {
    gpsRescanError.value = err.message || 'Fehler beim GPS-Rescan'
  } finally {
    gpsRescanLoading.value = false
    await fetchQueueStatus()
  }
}

// ── Auto-Crop ────────────────────────────────────────────────────────────────

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

// ── Build-Info ────────────────────────────────────────────────────────────────

const buildNumber = ref('…')

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await fetchQueueStatus()
  if (isActive.value) startPolling()
  getBuildInfo().then(info => { buildNumber.value = info.build })
})

onUnmounted(() => stopPolling())
</script>

<template>
  <div class="data-management-view">
    <h1 class="title">Datenverwaltung</h1>

    <!-- Scan Queue -->
    <div class="data-management-group">
      <h3>Scan-Queue</h3>
      <p>
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
    <div class="data-management-group">
      <h3>Ähnliche Fotos gruppieren</h3>
      <p>
        Ähnliche Fotos werden anhand der Embeddings automatisch zu Gruppen zusammengefasst.
      </p>

      <Message v-if="groupingError" severity="error" class="data-management-group__item" @close="groupingError = ''">{{ groupingError }}</Message>

      <div v-if="groupingResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ groupingResult.groups_created }} neue Gruppen erstellt
          ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
        </Message>
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-images"
        label="Gruppen neu berechnen"
        :loading="groupingLoading"
        :disabled="groupingLoading || isActive"
        @click="handleFindGroups"
      />
    </div>

    <!-- GPS Re-Extraktion -->
    <div class="data-management-group">
      <h3>GPS-Koordinaten neu einlesen</h3>
      <p>
        Liest GPS-Daten aus Fotos neu ein, bei denen die Extraktion beim Upload fehlgeschlagen ist,
        und wiederholt das Reverse-Geocoding für Fotos ohne Ortsbezeichnung.
        Wenn GPS-Koordinaten neu gefunden werden, werden alle anderen Scans (Embeddings,
        Gesichtserkennung, Qualität) ebenfalls neu gestartet.
      </p>

      <Message v-if="gpsRescanError" severity="error" class="data-management-group__item" @close="gpsRescanError = ''">{{ gpsRescanError }}</Message>

      <div v-if="gpsRescanResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ gpsRescanResult.gpsFound }} Fotos mit neuen GPS-Koordinaten ·
          {{ gpsRescanResult.geocoded }} Fotos geocodiert ·
          {{ gpsRescanResult.scansQueued }} Fotos neu in die Scan-Queue eingereiht
        </Message>
      </div>

      <div v-if="gpsRescanLoading" class="data-management-group__item">
        <span class="text-secondary">GPS wird verarbeitet… {{ gpsRescanCurrent }} / {{ gpsRescanTotal }}</span>
        <ProgressBar :value="gpsRescanProgress" :showValue="false" style="margin-top:0.5rem" />
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-map-marker"
        label="GPS neu einlesen"
        :disabled="gpsRescanLoading || isActive"
        :loading="gpsRescanLoading"
        @click="handleGpsRescan"
      />
    </div>

    <!-- Auto-Crop -->
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
        label="Auto-Crop neu berechnen"
        :loading="autoCropLoading"
        :disabled="autoCropLoading"
        @click="handleRecomputeAutoCrops"
      />
    </div>

    <!-- Metadaten -->
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
        label="Metadaten aktualisieren"
        :disabled="refreshingMetadata || isActive"
        :loading="refreshingMetadata"
        @click="handleRefreshMetadata"
      />
    </div>

    <!-- Build-Info -->
    <div class="data-management-group">
      <h3>Version</h3>
      <span class="build-number">Build {{ buildNumber }}</span>
    </div>
  </div>
</template>

<style scoped>
.data-management-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
}

@media (min-width: 800px) {
  .data-management-view {
    margin-inline: 0.5em;
  }
}

.data-management-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.data-management-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5em;
}

.build-number {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #888);
  font-family: monospace;
}

.data-management-group h3, .data-management-group p {
  margin-block: 0;
}

.data-management-group .data-management-group__item {
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
  border-bottom: 1px solid var(--p-surface-200);
}
.queue-table th {
  color: var(--p-text-muted-color);
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
