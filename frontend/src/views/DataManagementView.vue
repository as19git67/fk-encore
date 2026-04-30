<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import RadioButton from 'primevue/radiobutton'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import {
  getScanQueueStatus, rescanPhotos, retryFailedScans, cancelPendingScans,
  findPhotoGroups,
  getPhotosToRefreshMetadata, refreshPhotoMetadata,
  getPhotosNeedingGpsRescan, rescanPhotoGps,
  recomputeAutoCrops,
  purgePhotos,
  type ScanQueueStatus,
  type PurgeResult,
} from '../api/photos'
import {
  getFinanceTagQueueStatus, retryFailedFinanceTagJobs,
  cancelPendingFinanceTagJobs, reenqueueAllFinanceTagJobs,
  runAnomalyDetection,
  type TagQueueServiceStatus,
  type AnomalyRunResult,
} from '../api/finance'
import { getBuildInfo } from '../api/system'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'

const auth = useAuthStore()
const canPurgePhotos = computed(() => auth.hasPermission('photos.purge'))

// ── Scan Queue ────────────────────────────────────────────────────────────────

const queueStatus = ref<ScanQueueStatus>({ services: [] })
const queueError = ref('')
const rescanLoading = ref(false)
const retryLoading = ref(false)
const cancelLoading = ref(false)
const cancelledPending = ref(false)  // true after cancel until queue settles

const serviceLabels: Record<string, string> = {
  embedding: 'Embeddings',
  face_detection: 'Gesichtserkennung',
  landmark: 'Sehenswürdigkeiten',
  quality: 'Qualität',
  geocoding: 'Geocoding',
  library_scan: 'Bibliotheks-Scan',
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
    if (cancelledPending.value && !isActive.value) {
      cancelledPending.value = false
    }
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

// Push updates: backend emits `scan-queue/state.changed` (debounced to
// at most one event every 500ms) for every queue mutation. We just
// refetch — the REST endpoint remains the source of truth. The
// WebSocket bus auto-reconnects with exponential backoff and replays
// the outbox on resume, so no separate polling fallback is needed.
useRealtimeEvent('scan-queue', 'state.changed', () => {
  fetchQueueStatus()
})

async function handleRescan(force: boolean) {
  queueError.value = ''
  rescanLoading.value = true
  try {
    await rescanPhotos(force)
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
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    retryLoading.value = false
  }
}

async function handleCancel() {
  cancelLoading.value = true
  try {
    await cancelPendingScans()
    cancelledPending.value = true
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    cancelLoading.value = false
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
  } catch (err: any) {
    gpsRescanError.value = err.message || 'Fehler beim GPS-Rescan'
  } finally {
    gpsRescanLoading.value = false
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

// ── Danger Zone: Purge Photos ────────────────────────────────────────────────

const purgeDialogVisible = ref(false)
const purgeMode = ref<'db' | 'all'>('db')
const purgeConfirmText = ref('')
const purgeLoading = ref(false)
const purgeError = ref('')
const purgeResult = ref<PurgeResult | null>(null)

const PURGE_CONFIRM_KEYWORD = 'LÖSCHEN'
const canConfirmPurge = computed(
  () => purgeConfirmText.value.trim().toUpperCase() === PURGE_CONFIRM_KEYWORD && !purgeLoading.value
)

function openPurgeDialog() {
  purgeMode.value = 'db'
  purgeConfirmText.value = ''
  purgeError.value = ''
  purgeResult.value = null
  purgeDialogVisible.value = true
}

async function handlePurge() {
  if (!canConfirmPurge.value) return
  purgeLoading.value = true
  purgeError.value = ''
  try {
    const res = await purgePhotos(purgeMode.value === 'all')
    purgeResult.value = res
    purgeConfirmText.value = ''
    // Keep dialog open so the admin can inspect the result.
    await fetchQueueStatus()
  } catch (err: any) {
    purgeError.value = err.message || 'Fehler beim Löschen der Fotodaten'
  } finally {
    purgeLoading.value = false
  }
}

const purgeDbTotals = computed(() => {
  if (!purgeResult.value) return 0
  return Object.values(purgeResult.value.dbCounts).reduce((s, n) => s + n, 0)
})

// ── Finance Tag-Queue ─────────────────────────────────────────────────────────

const financeTagQueueStatus = ref<TagQueueServiceStatus>({ pending: 0, processing: 0, failed: 0, done: 0 })
const financeTagQueueError = ref('')
const financeTagRetryLoading = ref(false)
const financeTagCancelLoading = ref(false)
const financeTagReenqueueLoading = ref(false)
const financeTagCancelledPending = ref(false)

const financeTagIsActive = computed(
  () => financeTagQueueStatus.value.pending > 0 || financeTagQueueStatus.value.processing > 0
)

async function fetchFinanceTagQueueStatus() {
  try {
    const res = await getFinanceTagQueueStatus()
    financeTagQueueStatus.value = res.status
    if (financeTagCancelledPending.value && !financeTagIsActive.value) {
      financeTagCancelledPending.value = false
    }
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

useRealtimeEvent('scan-queue', 'state.changed', () => {
  fetchFinanceTagQueueStatus()
})

async function handleFinanceTagRetry() {
  financeTagQueueError.value = ''
  financeTagRetryLoading.value = true
  try {
    await retryFailedFinanceTagJobs()
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    financeTagRetryLoading.value = false
  }
}

async function handleFinanceTagCancel() {
  financeTagCancelLoading.value = true
  try {
    await cancelPendingFinanceTagJobs()
    financeTagCancelledPending.value = true
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    financeTagCancelLoading.value = false
  }
}

async function handleFinanceTagReenqueue() {
  financeTagQueueError.value = ''
  financeTagReenqueueLoading.value = true
  try {
    await reenqueueAllFinanceTagJobs()
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Einreihen'
  } finally {
    financeTagReenqueueLoading.value = false
  }
}

// ── Anomalie-Erkennung ────────────────────────────────────────────────────────

const anomalyLoading = ref(false)
const anomalyResult = ref<AnomalyRunResult | null>(null)
const anomalyError = ref('')

async function handleRunAnomalyDetection() {
  anomalyResult.value = null
  anomalyError.value = ''
  anomalyLoading.value = true
  try {
    anomalyResult.value = await runAnomalyDetection()
  } catch (err: any) {
    anomalyError.value = err.message || 'Fehler bei der Anomalie-Erkennung'
  } finally {
    anomalyLoading.value = false
  }
}

// ── Build-Info ────────────────────────────────────────────────────────────────

const buildNumber = ref('…')

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await fetchQueueStatus()
  await fetchFinanceTagQueueStatus()
  getBuildInfo().then(info => { buildNumber.value = info.build })
})
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

      <!-- Status-Tabelle (Desktop) -->
      <div class="queue-table-wrapper">
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
              <td>
                <div>{{ serviceLabels[svc.service] ?? svc.service }}</div>
                <div v-if="svc.progress" class="queue-progress-line">
                  {{ svc.progress.scanned }} gescannt
                  <template v-if="svc.progress.imported > 0"> · {{ svc.progress.imported }} importiert</template>
                  <template v-if="svc.progress.skipped > 0"> · {{ svc.progress.skipped }} übersprungen</template>
                  <template v-if="svc.progress.errors > 0"> · {{ svc.progress.errors }} Fehler</template>
                </div>
              </td>
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
      </div>

      <!-- Status-Karten (Mobil) -->
      <div class="queue-cards mb-4">
        <div v-for="svc in queueStatus.services" :key="svc.service" class="queue-card">
          <div class="queue-card__header">{{ serviceLabels[svc.service] ?? svc.service }}</div>
          <div v-if="svc.progress" class="queue-progress-line">
            {{ svc.progress.scanned }} gescannt
            <template v-if="svc.progress.imported > 0"> · {{ svc.progress.imported }} importiert</template>
            <template v-if="svc.progress.skipped > 0"> · {{ svc.progress.skipped }} übersprungen</template>
            <template v-if="svc.progress.errors > 0"> · {{ svc.progress.errors }} Fehler</template>
          </div>
          <div class="queue-card__stats">
            <div class="queue-card__stat">
              <span class="queue-card__label">Ausstehend</span>
              <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Läuft</span>
              <span v-if="svc.processing > 0" class="badge badge-processing">
                <i class="pi pi-spin pi-spinner" style="font-size:0.7rem" />
                {{ svc.processing }}
              </span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Fehler</span>
              <span v-if="svc.failed > 0" class="badge badge-failed">{{ svc.failed }}</span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Erledigt</span>
              <span class="text-secondary">{{ svc.done }}</span>
            </div>
          </div>
        </div>
        <div v-if="queueStatus.services.length === 0" class="text-secondary" style="text-align:center">
          Keine Daten
        </div>
      </div>

      <div v-if="isActive" class="status-progress">
        <span v-if="cancelledPending" class="text-secondary" style="font-size:0.85rem">
          <i class="pi pi-spin pi-spinner mr-1" />
          Wird abgebrochen… {{ totalProcessing }} laufende Jobs werden noch beendet.
        </span>
        <span v-else class="text-secondary" style="font-size:0.85rem">
          <i class="pi pi-spin pi-spinner mr-1" />
          {{ totalProcessing }} werden verarbeitet, {{ totalPending }} warten…
        </span>
        <ProgressBar class="status-progress__bar" mode="indeterminate" />
        <Button
          icon="pi pi-times"
          label="Scan abbrechen"
          severity="danger"
          size="small"
          outlined
          :loading="cancelLoading"
          :disabled="cancelLoading || cancelledPending"
          @click="handleCancel"
          style="align-self: flex-start; margin-top: 0.25rem"
        />
      </div>

      <div v-if="!isActive" class="button-row">
        <Button
          icon="pi pi-search-plus"
          label="Fehlende Scans starten"
          :loading="rescanLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRescan(false)"
        />
        <Button
          icon="pi pi-refresh"
          label="Alles neu scannen"
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

    <!-- Finance KI-Tag-Queue -->
    <div class="data-management-group">
      <h3>Finance KI-Tagging</h3>
      <p>
        Neue Buchungen werden automatisch mit KI-Tag-Vorschlägen versehen. Hier siehst du
        den aktuellen Bearbeitungsstand und kannst fehlgeschlagene Jobs erneut starten.
      </p>

      <Message v-if="financeTagQueueError" severity="error" class="mb-3" @close="financeTagQueueError = ''">
        {{ financeTagQueueError }}
      </Message>

      <div class="queue-table-wrapper">
        <table class="queue-table mb-4">
          <thead>
            <tr>
              <th>Dienst</th>
              <th>Ausstehend</th>
              <th>In Bearbeitung</th>
              <th>Fehlgeschlagen</th>
              <th>Fertig</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>KI-Tag-Vorschläge</td>
              <td>{{ financeTagQueueStatus.pending }}</td>
              <td>{{ financeTagQueueStatus.processing }}</td>
              <td>{{ financeTagQueueStatus.failed }}</td>
              <td>{{ financeTagQueueStatus.done }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="financeTagCancelledPending" class="mb-3 text-sm text-muted">
        Ausstehende Jobs wurden abgebrochen.
      </div>

      <div class="queue-actions">
        <Button
          label="Alle einreihen"
          icon="pi pi-refresh"
          severity="secondary"
          :loading="financeTagReenqueueLoading"
          :disabled="financeTagReenqueueLoading"
          @click="handleFinanceTagReenqueue"
        />
        <Button
          v-if="financeTagQueueStatus.failed > 0"
          label="Fehlgeschlagene wiederholen"
          icon="pi pi-replay"
          severity="warn"
          :loading="financeTagRetryLoading"
          :disabled="financeTagRetryLoading"
          @click="handleFinanceTagRetry"
        />
        <Button
          v-if="financeTagIsActive"
          label="Abbrechen"
          icon="pi pi-times"
          severity="danger"
          outlined
          :loading="financeTagCancelLoading"
          :disabled="financeTagCancelLoading"
          @click="handleFinanceTagCancel"
        />
      </div>
    </div>

    <!-- Finance Anomalie-Erkennung -->
    <div class="data-management-group">
      <h3>Finance Anomalie-Erkennung</h3>
      <p>
        Erkennt Änderungen bei wiederkehrenden Zahlungen (Lastschriften, Gehalt, Daueraufträge),
        mögliche Doppelbuchungen sowie neue regelmäßige Zahlungen.
      </p>

      <Message v-if="anomalyError" severity="error" class="data-management-group__item" @close="anomalyError = ''">
        {{ anomalyError }}
      </Message>

      <div v-if="anomalyResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ anomalyResult.accounts }} Konten · {{ anomalyResult.transactions_processed }} Buchungen verarbeitet ·
          {{ anomalyResult.mandates_created }} neue Mandate · {{ anomalyResult.mandates_updated }} Mandate aktualisiert ·
          <strong>{{ anomalyResult.anomalies_created }} Anomalien erkannt</strong>
        </Message>
      </div>

      <Button
        class="data-management-group__item"
        icon="pi pi-search"
        outlined
        label="Anomalien jetzt erkennen"
        :loading="anomalyLoading"
        :disabled="anomalyLoading"
        @click="handleRunAnomalyDetection"
      />
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
        outlined
        label="Gruppen neu berechnen"
        :loading="groupingLoading"
        :disabled="groupingLoading || isActive || rescanLoading || retryLoading"
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
        outlined
        label="GPS neu einlesen"
        :disabled="gpsRescanLoading || isActive || rescanLoading || retryLoading"
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
        outlined
        label="Auto-Crop neu berechnen"
        :loading="autoCropLoading"
        :disabled="autoCropLoading || isActive || rescanLoading || retryLoading"
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
        outlined
        label="Metadaten aktualisieren"
        :disabled="refreshingMetadata || isActive || rescanLoading || retryLoading"
        :loading="refreshingMetadata"
        @click="handleRefreshMetadata"
      />
    </div>

    <!-- Danger Zone: Purge Photos -->
    <div v-if="canPurgePhotos" class="data-management-group danger-zone">
      <h3 class="danger-zone__title">Danger Zone</h3>
      <p>
        Entfernt unwiderruflich alle Fotos, Alben, Gesichter, Personen,
        Embeddings und Scan-Queue-Einträge aus der Datenbank. Benutzerkonten,
        Rollen und Berechtigungen bleiben erhalten.
      </p>
      <Button class="data-management-group__item"
        icon="pi pi-trash"
        label="Alle Fotodaten löschen…"
        severity="danger"
        @click="openPurgeDialog"
      />
    </div>

    <!-- Build-Info -->
    <div class="data-management-group">
      <h3>Version</h3>
      <span class="build-number">Build {{ buildNumber }}</span>
    </div>

    <!-- Purge Confirmation Dialog -->
    <Dialog
      v-model:visible="purgeDialogVisible"
      modal
      :closable="!purgeLoading"
      :closeOnEscape="!purgeLoading"
      header="Alle Fotodaten löschen"
      :style="{ width: 'min(520px, 92vw)' }"
    >
      <div v-if="!purgeResult" class="purge-dialog">
        <Message severity="error" :closable="false" class="purge-dialog__warn">
          Diese Aktion ist <strong>nicht umkehrbar</strong>.
          Es werden <strong>alle</strong> Fotos, Alben, Gesichter, Personen,
          Embeddings und Scan-Queue-Einträge entfernt.
        </Message>

        <div class="purge-dialog__options">
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-db" name="purgeMode" value="db" />
            <span>
              <strong>Nur Datenbank</strong>
              <span class="purge-dialog__hint">
                Löscht alle Datenbank-Einträge. Die Original­dateien und Thumbnails bleiben auf der Festplatte erhalten (verwaist).
              </span>
            </span>
          </label>
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-all" name="purgeMode" value="all" />
            <span>
              <strong>Datenbank + Dateien</strong>
              <span class="purge-dialog__hint">
                Löscht zusätzlich alle hochgeladenen Fotos und alle zwischengespeicherten Thumbnails von der Festplatte.
              </span>
            </span>
          </label>
        </div>

        <div class="purge-dialog__confirm">
          <label for="purge-confirm-input">
            Bitte zur Bestätigung <strong>{{ PURGE_CONFIRM_KEYWORD }}</strong> eintippen:
          </label>
          <InputText
            id="purge-confirm-input"
            v-model="purgeConfirmText"
            :disabled="purgeLoading"
            autocomplete="off"
          />
        </div>

        <Message v-if="purgeError" severity="error" @close="purgeError = ''">{{ purgeError }}</Message>
      </div>

      <div v-else class="purge-result">
        <Message severity="success" :closable="false">
          Fotodaten wurden gelöscht. Entfernte Datenbank-Einträge: <strong>{{ purgeDbTotals }}</strong>.
        </Message>
        <table class="purge-result__table">
          <thead>
            <tr><th>Tabelle</th><th>Gelöschte Zeilen</th></tr>
          </thead>
          <tbody>
            <tr v-for="(count, table) in purgeResult.dbCounts" :key="table">
              <td>{{ table }}</td>
              <td>{{ count }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="purgeResult.files.deleted" class="purge-result__files">
          <strong>Dateien:</strong>
          {{ purgeResult.files.uploadsRemoved }} Uploads,
          {{ purgeResult.files.thumbnailsRemoved }} Thumbnail-Shards entfernt
          <span v-if="purgeResult.files.failures > 0">
            — {{ purgeResult.files.failures }} Fehler
          </span>
        </div>
        <div v-else class="purge-result__files">
          <strong>Dateien:</strong> wurden behalten (nur DB-Einträge entfernt).
        </div>
        <div class="purge-result__embeddings">
          <strong>Embedding-Service:</strong>
          <template v-if="purgeResult.embeddingService.ok">
            {{ purgeResult.embeddingService.deleted }} Embeddings gelöscht.
          </template>
          <template v-else>
            <span class="purge-result__warn">
              Fehler: {{ purgeResult.embeddingService.error || 'Service nicht erreichbar' }}
            </span>
          </template>
        </div>
      </div>

      <template #footer>
        <template v-if="!purgeResult">
          <Button
            label="Abbrechen"
            severity="secondary"
            outlined
            :disabled="purgeLoading"
            @click="purgeDialogVisible = false"
          />
          <Button
            :label="purgeMode === 'all' ? 'Alles endgültig löschen' : 'Datenbank leeren'"
            icon="pi pi-trash"
            severity="danger"
            :loading="purgeLoading"
            :disabled="!canConfirmPurge"
            @click="handlePurge"
          />
        </template>
        <template v-else>
          <Button label="Schließen" @click="purgeDialogVisible = false" />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.data-management-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
  padding-inline: 0.25em;
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

.anomaly-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.status-progress {
  display: flex;
  flex-direction: column;
  margin-block: 0.25em;
  align-self: stretch;
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
  align-self: flex-start;
}

@media (max-width: 600px) {
  .button-row {
    flex-direction: column;
    align-self: stretch;
  }
}

@media (max-width: 600px) {
  .button-row + .button-row,
  .data-management-group :deep(.p-button:only-child) {
    width: 100%;
  }
}

/* Desktop: show table, hide cards */
.queue-table-wrapper { display: block; align-self: stretch; }
.queue-cards { display: none; }

@media (max-width: 600px) {
  .queue-table-wrapper { display: none; }
  .queue-cards { display: flex; flex-direction: column; gap: 0.5rem; align-self: stretch; }
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
  border-bottom: 1px solid var(--p-content-border-color);
}
.queue-table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
}

/* Mobile card layout */
.queue-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
}
.queue-card__header {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.4rem;
}
.queue-card__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.3rem 1rem;
}
.queue-card__stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.85rem;
}
.queue-card__label {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.queue-progress-line {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
  margin-top: 0.15rem;
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

/* Danger Zone */
.danger-zone {
  margin-top: 1rem;
  border: 1px solid var(--p-red-400, #e34c4c);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background: color-mix(in srgb, var(--p-red-50, #fff5f5) 60%, transparent);
}
.danger-zone__title {
  color: var(--p-red-600, #c62828);
}

/* Purge dialog */
.purge-dialog {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.purge-dialog__warn {
  margin: 0;
}
.purge-dialog__options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-dialog__option {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
}
.purge-dialog__option span {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.purge-dialog__hint {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.purge-dialog__confirm {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.purge-dialog__confirm label {
  font-size: 0.9rem;
}

/* Purge result */
.purge-result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-result__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.purge-result__table th,
.purge-result__table td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
}
.purge-result__table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
}
.purge-result__files,
.purge-result__embeddings {
  font-size: 0.9rem;
}
.purge-result__warn {
  color: var(--p-red-600, #c62828);
}
</style>
