<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import {
  getDocumentQueueStatus, reclassifyAllDocuments, relocateAllDocuments,
  cancelDocumentQueue, retryDocumentQueue,
  type DocQueueStatus,
  type ReclassifyAllMode,
  type RelocateAllDocumentsResponse,
} from '../../api/documents'
import { useRealtimeEvent } from '../../composables/useRealtime'

const docQueueStatus = ref<DocQueueStatus>({ services: [], jobs: [] })
const docReclassifyLoading = ref(false)
const docReclassifyError = ref('')
const docReclassifyResult = ref<{ queued: number; skipped_encrypted?: number; status_breakdown?: Record<string, number> } | null>(null)
const docRelocateLoading = ref(false)
const docRelocateResult = ref<RelocateAllDocumentsResponse | null>(null)
const docCancelLoading = ref(false)
const docRetryLoading = ref(false)

const docQueueServiceLabels: Record<string, string> = {
  text_extract: 'OCR / Text',
  classify: 'KI-Klassifikation',
  embed: 'Embedding',
  receipt_ocr: 'Beleg-OCR (PaddleOCR)',
}

const docTotalPending = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.pending, 0)
)
const docTotalProcessing = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.processing, 0)
)
const docTotalFailed = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.failed, 0)
)
const docIsActive = computed(
  () => docTotalPending.value > 0 || docTotalProcessing.value > 0
)

async function fetchDocQueueStatus() {
  try {
    docQueueStatus.value = await getDocumentQueueStatus()
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

onMounted(fetchDocQueueStatus)
useRealtimeEvent('scan-queue', 'state.changed', () => {
  fetchDocQueueStatus()
})

async function handleDocReclassifyAll(mode: ReclassifyAllMode) {
  docReclassifyError.value = ''
  docReclassifyResult.value = null
  docRelocateResult.value = null
  docReclassifyLoading.value = true
  try {
    const result = await reclassifyAllDocuments(mode)
    docReclassifyResult.value = result
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Einreihen'
  } finally {
    docReclassifyLoading.value = false
  }
}

async function handleDocRelocateAll() {
  docReclassifyError.value = ''
  docReclassifyResult.value = null
  docRelocateResult.value = null
  docRelocateLoading.value = true
  try {
    docRelocateResult.value = await relocateAllDocuments()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Aktualisieren der Dateipfade'
  } finally {
    docRelocateLoading.value = false
  }
}

async function handleDocCancel() {
  docReclassifyError.value = ''
  docCancelLoading.value = true
  try {
    await cancelDocumentQueue()
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    docCancelLoading.value = false
  }
}

async function handleDocRetry() {
  docReclassifyError.value = ''
  docRetryLoading.value = true
  try {
    await retryDocumentQueue()
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    docRetryLoading.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>Dokument-Verarbeitung</h3>
    <p>
      Neue und neu klassifizierte Dokumente durchlaufen drei Schritte:
      OCR / Text-Extraktion, KI-Klassifikation und Embedding.
    </p>

    <Message v-if="docReclassifyError" severity="error" class="mb-3" @close="docReclassifyError = ''">
      {{ docReclassifyError }}
    </Message>

    <div v-if="docReclassifyResult !== null" class="mb-3">
      <Message severity="info" :closable="false">
        {{ docReclassifyResult.queued }} Dokument(e) in die Warteschlange eingereiht.
        <template v-if="docReclassifyResult.skipped_encrypted">
          {{ docReclassifyResult.skipped_encrypted }} verschlüsselte Dokument(e) übersprungen.
        </template>
        <template v-if="docReclassifyResult.status_breakdown">
          <br>Status-Verteilung:
          <span v-for="(count, status) in docReclassifyResult.status_breakdown" :key="status" style="margin-left:0.5em">
            {{ status }}={{ count }}
          </span>
        </template>
      </Message>
    </div>

    <div v-if="docRelocateResult !== null" class="mb-3">
      <Message :severity="docRelocateResult.failed > 0 ? 'warn' : 'info'" :closable="false">
        {{ docRelocateResult.processed }} Dokument(e) geprüft,
        {{ docRelocateResult.moved }} Dateipfad(e) aktualisiert
        <template v-if="docRelocateResult.failed > 0">
          , {{ docRelocateResult.failed }} fehlgeschlagen
        </template>.
      </Message>
    </div>

    <div class="queue-table-wrapper">
      <table class="queue-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Ausstehend</th>
            <th>In Arbeit</th>
            <th>Fehler</th>
            <th>Fertig</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="svc in docQueueStatus.services" :key="svc.service">
            <td>{{ docQueueServiceLabels[svc.service] ?? svc.service }}</td>
            <td>{{ svc.pending }}</td>
            <td>{{ svc.processing }}</td>
            <td :class="{ 'text-danger': svc.failed > 0 }">{{ svc.failed }}</td>
            <td class="text-secondary">{{ svc.done }}</td>
          </tr>
          <tr v-if="docQueueStatus.services.length === 0">
            <td colspan="5" class="text-secondary" style="text-align:center">Keine Daten</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Status-Karten (Mobil) -->
    <div class="queue-cards mb-3">
      <div v-for="svc in docQueueStatus.services" :key="svc.service" class="queue-card">
        <div class="queue-card__header">{{ docQueueServiceLabels[svc.service] ?? svc.service }}</div>
        <div class="queue-card__stats">
          <div class="queue-card__stat">
            <span class="queue-card__label">Ausstehend</span>
            <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
            <span v-else class="text-secondary">—</span>
          </div>
          <div class="queue-card__stat">
            <span class="queue-card__label">In Arbeit</span>
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
            <span class="queue-card__label">Fertig</span>
            <span class="text-secondary">{{ svc.done }}</span>
          </div>
        </div>
      </div>
      <div v-if="docQueueStatus.services.length === 0" class="text-secondary" style="text-align:center">
        Keine Daten
      </div>
    </div>

    <ProgressBar
      v-if="docIsActive"
      mode="indeterminate"
      class="mb-3"
      style="height: 4px"
    />

    <div class="queue-actions">
      <Button
        label="Nur KI-Klassifikation"
        icon="pi pi-sparkles"
        severity="secondary"
        :loading="docReclassifyLoading"
        :disabled="docReclassifyLoading || docIsActive"
        @click="handleDocReclassifyAll('classify_only')"
      />
      <Button
        label="OCR + Klassifikation"
        icon="pi pi-refresh"
        severity="secondary"
        :loading="docReclassifyLoading"
        :disabled="docReclassifyLoading || docIsActive"
        @click="handleDocReclassifyAll('full')"
      />
      <Button
        label="Fehlende fortsetzen"
        icon="pi pi-play"
        severity="secondary"
        :loading="docReclassifyLoading"
        :disabled="docReclassifyLoading || docIsActive"
        @click="handleDocReclassifyAll('resume')"
      />
      <Button
        label="Dateipfade aktualisieren"
        icon="pi pi-folder"
        severity="secondary"
        v-tooltip.top="'Wendet das aktuelle Ordner- und Dateinamensschema auf alle Dokumente an.'"
        :loading="docRelocateLoading"
        :disabled="docRelocateLoading || docReclassifyLoading || docIsActive"
        @click="handleDocRelocateAll"
      />
      <Button
        v-if="docTotalFailed > 0"
        label="Fehlgeschlagene wiederholen"
        icon="pi pi-replay"
        severity="warn"
        :loading="docRetryLoading"
        :disabled="docRetryLoading"
        @click="handleDocRetry"
      />
      <Button
        v-if="docIsActive"
        label="Abbrechen"
        icon="pi pi-times"
        severity="danger"
        outlined
        :loading="docCancelLoading"
        :disabled="docCancelLoading"
        @click="handleDocCancel"
      />
    </div>
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
