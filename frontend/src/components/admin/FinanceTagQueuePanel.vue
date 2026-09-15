<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import {
  getFinanceTagQueueStatus, retryFailedFinanceTagJobs,
  cancelPendingFinanceTagJobs, reenqueueAllFinanceTagJobs,
  type TagQueueServiceStatus,
} from '../../api/finance'
import { useRealtimeEvent } from '../../composables/useRealtime'

const financeTagQueueStatus = ref<TagQueueServiceStatus>({ pending: 0, processing: 0, failed: 0, done: 0 })
const financeTagQueueError = ref('')
const financeTagRetryLoading = ref(false)
const financeTagCancelLoading = ref(false)
const financeTagReenqueueLoading = ref(false)
const financeTagCancelledPending = ref(false)

const financeTagIsActive = computed(
  () => financeTagQueueStatus.value.pending > 0 || financeTagQueueStatus.value.processing > 0
)

watch(financeTagIsActive, (active) => {
  if (!active) financeTagCancelledPending.value = false
})

async function fetchFinanceTagQueueStatus() {
  try {
    const res = await getFinanceTagQueueStatus()
    financeTagQueueStatus.value = res.status
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

onMounted(fetchFinanceTagQueueStatus)
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
</script>

<template>
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
</template>

<style scoped src="./adminPanels.css"></style>
