<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import {
  getDocumentQueueStatus,
  cancelDocumentQueue,
  retryDocumentQueue,
  type DocQueueServiceStatus,
  type DocQueueJob,
} from '../api/documents'
import { useRealtimeEvent } from '../composables/useRealtime'

const services = ref<DocQueueServiceStatus[]>([])
const jobs = ref<DocQueueJob[]>([])
const loading = ref(false)
const actionLoading = ref(false)
const expanded = ref(false)

const totalPending = computed(() => services.value.reduce((s, r) => s + r.pending, 0))
const totalProcessing = computed(() => services.value.reduce((s, r) => s + r.processing, 0))
const totalFailed = computed(() => services.value.reduce((s, r) => s + r.failed, 0))
const hasActivity = computed(() => totalPending.value + totalProcessing.value + totalFailed.value > 0)

/**
 * A job that has been waiting long enough that it is worth looking at. The
 * pipeline is serial per service, so a normal backlog also "waits" — what
 * matters is a job whose wait is measured in hours, or one that keeps being
 * deferred (llm-service unreachable for that document, ai-queue slot never
 * granted).
 */
const STUCK_AFTER_MS = 30 * 60 * 1000

function waitedMs(job: DocQueueJob): number {
  const t = new Date(job.enqueued_at).getTime()
  return Number.isNaN(t) ? 0 : Date.now() - t
}

function formatWaited(job: DocQueueJob): string {
  const min = Math.floor(waitedMs(job) / 60000)
  if (min < 1) return '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`
}

const stuckJobs = computed(() =>
  jobs.value.filter((j) => j.defer_count > 0 || waitedMs(j) >= STUCK_AFTER_MS),
)

const serviceLabel: Record<string, string> = {
  text_extract: 'Text',
  classify: 'KI',
  embed: 'Embedding',
  receipt_ocr: 'Beleg-OCR',
}

async function load() {
  loading.value = true
  try {
    const res = await getDocumentQueueStatus()
    services.value = res.services
    jobs.value = res.jobs ?? []
  } catch { /* ignore */ } finally {
    loading.value = false
  }
}

async function handleCancel() {
  actionLoading.value = true
  try {
    await cancelDocumentQueue()
    await load()
  } catch { /* ignore */ } finally {
    actionLoading.value = false
  }
}

async function handleRetry() {
  actionLoading.value = true
  try {
    await retryDocumentQueue()
    await load()
  } catch { /* ignore */ } finally {
    actionLoading.value = false
  }
}

useRealtimeEvent('scan-queue', 'state.changed', () => {
  load()
})

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  load()
  pollTimer = setInterval(load, 30_000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div v-if="hasActivity" class="queue-panel">
    <button type="button" class="queue-summary" @click="expanded = !expanded">
      <i class="pi pi-spin pi-spinner" v-if="totalProcessing > 0" />
      <i class="pi pi-clock" v-else />
      <span class="queue-label">
        Warteschlange:
        <Tag v-if="totalProcessing > 0" severity="info" :value="`${totalProcessing} aktiv`" />
        <Tag v-if="totalPending > 0" severity="secondary" :value="`${totalPending} wartend`" />
        <Tag v-if="totalFailed > 0" severity="danger" :value="`${totalFailed} fehlgeschlagen`" />
      </span>
      <i :class="expanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" class="toggle-icon" />
    </button>

    <div v-if="expanded" class="queue-detail">
      <table class="queue-table">
        <thead>
          <tr>
            <th>Dienst</th>
            <th>Wartend</th>
            <th>Aktiv</th>
            <th>Fehler</th>
            <th>Fertig</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in services" :key="s.service">
            <td>{{ serviceLabel[s.service] ?? s.service }}</td>
            <td>{{ s.pending }}</td>
            <td>{{ s.processing }}</td>
            <td :class="{ 'error-cell': s.failed > 0 }">{{ s.failed }}</td>
            <td>{{ s.done }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="stuckJobs.length > 0" class="stuck-block">
        <div class="stuck-title">
          <i class="pi pi-exclamation-triangle" />
          Hängende Jobs ({{ stuckJobs.length }})
        </div>
        <p class="stuck-hint">
          Diese Jobs warten ungewöhnlich lange. Ein wartender Embedding-Job ändert
          den Dokumentstatus nicht — das Dokument ist deshalb über die Statusfilter
          der Liste nicht auffindbar.
        </p>
        <table class="queue-table">
          <thead>
            <tr>
              <th>Dokument</th>
              <th>Dienst</th>
              <th>Wartet</th>
              <th>Zurückgestellt</th>
              <th>Grund</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in stuckJobs" :key="j.id">
              <td>
                <router-link :to="{ name: 'dokumente-detail', params: { id: j.document_id } }">
                  {{ j.document_title ?? `#${j.document_id}` }}
                </router-link>
                <span class="doc-status">({{ j.document_status }})</span>
              </td>
              <td>{{ serviceLabel[j.service] ?? j.service }}</td>
              <td>{{ formatWaited(j) }}</td>
              <td>{{ j.defer_count }}×</td>
              <td class="reason">{{ j.error_msg ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="queue-actions">
        <Button
          v-if="totalFailed > 0"
          label="Fehlgeschlagene wiederholen"
          icon="pi pi-refresh"
          size="small"
          severity="warn"
          :loading="actionLoading"
          @click="handleRetry"
        />
        <Button
          v-if="totalPending > 0"
          label="Warteschlange abbrechen"
          icon="pi pi-times"
          size="small"
          severity="danger"
          outlined
          :loading="actionLoading"
          @click="handleCancel"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-panel {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  overflow: hidden;
}
.queue-summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--p-text-color);
  text-align: left;
  flex-wrap: wrap;
}
.queue-summary:hover { background: var(--p-content-hover-background); }
.queue-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  flex-wrap: wrap;
}
.toggle-icon { margin-left: auto; color: var(--p-text-muted-color); flex-shrink: 0; }
.queue-detail { padding: 0.5rem 0.75rem 0.75rem; }
.queue-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.queue-table th, .queue-table td {
  padding: 0.3rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid var(--p-content-border-color);
}
.queue-table th { font-weight: 600; color: var(--p-text-muted-color); }
.error-cell { color: var(--p-red-500, #e74c3c); font-weight: 600; }
.queue-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.stuck-block { margin-bottom: 0.75rem; }
.stuck-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.stuck-hint {
  margin: 0 0 0.4rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
.doc-status { margin-left: 0.35rem; color: var(--p-text-muted-color); }
.reason {
  max-width: 22rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--p-text-muted-color);
}
</style>
