<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { listScheduledJobs, type ScheduledJob } from '../api/admin'

const jobs = ref<ScheduledJob[]>([])
const loading = ref(false)
const error = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

async function fetchJobs() {
  loading.value = true
  try {
    const res = await listScheduledJobs()
    jobs.value = res.jobs
    error.value = ''
  } catch (err: any) {
    error.value = err?.message ?? String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchJobs()
  // Light polling — the underlying state lives in process memory and
  // we want next_fire_at counters to tick down. 10s is gentle enough.
  refreshTimer = setInterval(fetchJobs, 10_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

const sortedJobs = computed(() =>
  [...jobs.value].sort((a, b) => {
    const sa = a.service ?? ''
    const sb = b.service ?? ''
    if (sa !== sb) return sa.localeCompare(sb)
    return a.name.localeCompare(b.name)
  }),
)

const statusSeverity: Record<ScheduledJob['status'], string> = {
  scheduled: 'info',
  running: 'warn',
  ok: 'success',
  error: 'danger',
  deactivated: 'secondary',
}

const statusLabel: Record<ScheduledJob['status'], string> = {
  scheduled: 'geplant',
  running: 'läuft',
  ok: 'OK',
  error: 'Fehler',
  deactivated: 'deaktiviert',
}

function formatDate(value: string | null): string {
  if (!value) return '–'
  return new Date(value).toLocaleString('de-DE')
}

function formatRelative(value: string | null): string {
  if (!value) return '–'
  const ms = new Date(value).getTime() - Date.now()
  const abs = Math.abs(ms)
  const sign = ms < 0 ? 'vor' : 'in'
  const sec = Math.round(abs / 1000)
  if (sec < 60) return `${sign} ${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${sign} ${min}min`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${sign} ${hr}h`
  const day = Math.round(hr / 24)
  return `${sign} ${day}d`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '–'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Eingeplante Jobs</h1>
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        text
        :loading="loading"
        @click="fetchJobs"
      />
    </header>

    <p class="hint">
      Liste aller Hintergrund-Jobs, die der lokale Scheduler
      (<code>lib/local-cron.ts</code>) verwaltet. Werte stammen aus
      einer Prozess-internen Registry und werden bei jedem
      Container-Neustart zurückgesetzt. Auto-Refresh alle 10&nbsp;s.
    </p>

    <Message v-if="error" severity="error" :closable="true" @close="error = ''">
      {{ error }}
    </Message>

    <DataTable
      :value="sortedJobs"
      :loading="loading"
      data-key="name"
      row-group-mode="subheader"
      group-rows-by="service"
      sort-mode="single"
      sort-field="service"
      :sort-order="1"
      striped-rows
      class="jobs-table"
    >
      <template #groupheader="slotProps">
        <span class="group-header">{{ slotProps.data.service ?? 'andere' }}</span>
      </template>

      <Column field="name" header="Name">
        <template #body="{ data }">
          <div class="name-cell">
            <strong>{{ data.name }}</strong>
            <span v-if="data.description" class="hint">{{ data.description }}</span>
          </div>
        </template>
      </Column>

      <Column field="schedule_label" header="Schedule">
        <template #body="{ data }">
          <code v-if="data.schedule_label">{{ data.schedule_label }}</code>
          <span v-else>–</span>
        </template>
      </Column>

      <Column field="status" header="Status">
        <template #body="{ data }">
          <Tag :severity="statusSeverity[data.status]" :value="statusLabel[data.status]" />
        </template>
      </Column>

      <Column field="next_fire_at" header="Nächster Lauf">
        <template #body="{ data }">
          <div class="when-cell">
            <span>{{ formatDate(data.next_fire_at) }}</span>
            <span class="hint">{{ formatRelative(data.next_fire_at) }}</span>
          </div>
        </template>
      </Column>

      <Column field="last_run_at" header="Letzter Lauf">
        <template #body="{ data }">
          <div class="when-cell">
            <span>{{ formatDate(data.last_run_at) }}</span>
            <span class="hint">
              <template v-if="data.last_run_at">
                {{ formatRelative(data.last_run_at) }} · {{ formatDuration(data.last_duration_ms) }}
              </template>
              <template v-else>
                noch nicht gelaufen
              </template>
            </span>
          </div>
        </template>
      </Column>

      <Column field="run_count" header="Läufe" style="text-align: right;">
        <template #body="{ data }">
          <span :class="{ 'has-errors': data.error_count > 0 }">
            {{ data.run_count }}<template v-if="data.error_count > 0"> · {{ data.error_count }}&nbsp;Fehler</template>
          </span>
        </template>
      </Column>

      <Column field="last_error" header="Letzter Fehler">
        <template #body="{ data }">
          <code v-if="data.last_error" class="error">{{ data.last_error }}</code>
          <span v-else>–</span>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 1280px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.page-header h1 {
  margin: 0;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
  font-size: 0.85rem;
}
.group-header {
  font-weight: 600;
  text-transform: capitalize;
}
.name-cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.when-cell {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-variant-numeric: tabular-nums;
}
.has-errors {
  color: var(--p-red-500, #ef4444);
}
code.error {
  color: var(--p-red-500, #ef4444);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.jobs-table {
  font-size: 0.92rem;
}
</style>
