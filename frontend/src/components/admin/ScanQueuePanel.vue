<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import QueueErrorsDialog from '../QueueErrorsDialog.vue'
import {
  rescanPhotos, retryFailedScans, cancelPendingScans,
  redetectMissingPois, redetectEmptyPois, getScanQueueFailures,
} from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { status: queueStatus, totalPending, totalProcessing, totalFailed, isActive } =
  useScanQueueStatus()

const queueError = ref('')
const rescanLoading = ref(false)
const retryLoading = ref(false)
const cancelLoading = ref(false)
const cancelledPending = ref(false)  // true after cancel until queue settles
const poiRedetectLoading = ref(false)
const poiRedetectResult = ref<number | null>(null)  // queued count after a run
const poiRedetectEmptyLoading = ref(false)
const poiRedetectEmptyResult = ref<number | null>(null)  // queued count after a run

const serviceLabels: Record<string, string> = {
  embedding: 'Ähnlichkeitsanalyse',
  face_detection: 'Gesichtserkennung',
  face_assignment: 'Gesichtszuordnung',
  landmark: 'Sehenswürdigkeiten (Legacy)',
  poi_detection: 'POI-Erkennung',
  quality: 'Qualität',
  geocoding: 'Geocoding',
  thumbnail: 'Vorschaubilder',
  text_ocr: 'Texterkennung',
}

// Once the queue has drained the cancel is done: clear the flag so a later
// scan gets a usable cancel button again.
watch(isActive, (active) => {
  if (!active) cancelledPending.value = false
})

// ── Failed-jobs detail dialog ─────────────────────────────────────────────────
// Clicking a service's "Fehler" count opens a grouped breakdown of the
// failed jobs (error message · count · last failure · sample photo ids).
const failuresDialogVisible = ref(false)
const failuresService = ref<string | null>(null)

const failuresTitle = computed(() =>
  failuresService.value
    ? `Fehler — ${serviceLabels[failuresService.value] ?? failuresService.value}`
    : 'Fehler',
)
const failuresLoader = computed(() => {
  const svc = failuresService.value
  return svc ? () => getScanQueueFailures(svc).then((r) => r.groups) : null
})

function openFailures(service: string) {
  failuresService.value = service
  failuresDialogVisible.value = true
}

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

async function handlePoiRedetect() {
  queueError.value = ''
  poiRedetectResult.value = null
  poiRedetectLoading.value = true
  try {
    const { queued } = await redetectMissingPois()
    poiRedetectResult.value = queued
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Nachholen der POI-Erkennung'
  } finally {
    poiRedetectLoading.value = false
  }
}

async function handlePoiRedetectEmpty() {
  queueError.value = ''
  poiRedetectEmptyResult.value = null
  poiRedetectEmptyLoading.value = true
  try {
    const { queued } = await redetectEmptyPois()
    poiRedetectEmptyResult.value = queued
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim erneuten Prüfen der POI-Erkennung'
  } finally {
    poiRedetectEmptyLoading.value = false
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
</script>

<template>
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
              <button
                v-if="svc.failed > 0"
                type="button"
                class="badge badge-failed badge-button"
                :title="`Fehlerdetails für ${serviceLabels[svc.service] ?? svc.service} anzeigen`"
                @click="openFailures(svc.service)"
              >{{ svc.failed }}</button>
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
            <button
              v-if="svc.failed > 0"
              type="button"
              class="badge badge-failed badge-button"
              :title="`Fehlerdetails für ${serviceLabels[svc.service] ?? svc.service} anzeigen`"
              @click="openFailures(svc.service)"
            >{{ svc.failed }}</button>
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
      <Button
        icon="pi pi-map-marker"
        label="POI für Altbilder nachholen"
        severity="secondary"
        outlined
        :loading="poiRedetectLoading"
        :disabled="rescanLoading || retryLoading || poiRedetectLoading || poiRedetectEmptyLoading"
        v-tooltip.bottom="'Nur poi_detection für Fotos mit GPS und fertigem Embedding, die noch nie korrekt verarbeitet wurden (Fix #558) – idempotent, ohne kompletten Rescan.'"
        @click="handlePoiRedetect"
      />
      <Button
        icon="pi pi-replay"
        label="POI für trefferlose Fotos erneut prüfen"
        severity="secondary"
        outlined
        :loading="poiRedetectEmptyLoading"
        :disabled="rescanLoading || retryLoading || poiRedetectLoading || poiRedetectEmptyLoading"
        v-tooltip.bottom="'Einmalige Aktion: poi_detection für ALLE Fotos mit GPS und fertigem Embedding, die keinen POI-Treffer haben. Fängt auch Race-Opfer ein, die der Button links überspringt – läuft aber auch über Fotos, die zu Recht keinen POI in der Nähe haben.'"
        @click="handlePoiRedetectEmpty"
      />
    </div>
    <p v-if="poiRedetectResult !== null" class="poi-redetect-result">
      {{ poiRedetectResult > 0
        ? `${poiRedetectResult} Foto(s) für die POI-Erkennung neu eingereiht.`
        : 'Keine passenden Altbilder gefunden – nichts neu einzureihen.' }}
    </p>
    <p v-if="poiRedetectEmptyResult !== null" class="poi-redetect-result">
      {{ poiRedetectEmptyResult > 0
        ? `${poiRedetectEmptyResult} trefferlose(s) Foto(s) für die POI-Erkennung erneut eingereiht.`
        : 'Keine trefferlosen Fotos mit fertigem Embedding gefunden.' }}
    </p>

    <!-- Failed-jobs detail dialog (opened from a "Fehler" count) -->
    <QueueErrorsDialog
      v-model:visible="failuresDialogVisible"
      :title="failuresTitle"
      :loader="failuresLoader"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
<style scoped>
.poi-redetect-result {
  margin: 0.5rem 0 0;
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
</style>
