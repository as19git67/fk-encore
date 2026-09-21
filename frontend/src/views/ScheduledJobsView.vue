<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import {
  listScheduledJobs,
  pauseScheduledJob,
  resumeScheduledJob,
  runScheduledJobNow,
  type ScheduledJob,
} from '../api/admin'
import { useRealtimeEvent } from '../composables/useRealtime'

const jobs = ref<ScheduledJob[]>([])
const loading = ref(false)
const error = ref('')
const pendingAction = ref<Record<string, string>>({})
let tickTimer: ReturnType<typeof setInterval> | null = null
const tick = ref(0)

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

function patchJob(updated: ScheduledJob) {
  const idx = jobs.value.findIndex((j) => j.name === updated.name)
  if (idx === -1) jobs.value.push(updated)
  else jobs.value[idx] = updated
}

async function withAction(job: ScheduledJob, kind: string, fn: () => Promise<{ job: ScheduledJob }>) {
  pendingAction.value = { ...pendingAction.value, [job.name]: kind }
  try {
    const res = await fn()
    patchJob(res.job)
  } catch (err: any) {
    error.value = `${kind} ${job.name}: ${err?.message ?? err}`
  } finally {
    const next = { ...pendingAction.value }
    delete next[job.name]
    pendingAction.value = next
  }
}

const onPause = (job: ScheduledJob) => withAction(job, 'pause', () => pauseScheduledJob(job.name))
const onResume = (job: ScheduledJob) => withAction(job, 'resume', () => resumeScheduledJob(job.name))
const onRunNow = (job: ScheduledJob) => withAction(job, 'run-now', () => runScheduledJobNow(job.name))

// Realtime subscription: backend publishes "scheduled-job.changed" on
// the "system" channel for every status transition (running, ok,
// error, paused). We swap the row in-place — no refetch.
useRealtimeEvent('system', 'scheduled-job.changed', (ev) => {
  const payload = ev.payload as unknown as ScheduledJob | undefined
  if (payload && typeof payload.name === 'string') patchJob(payload)
})

onMounted(() => {
  fetchJobs()
  // Tick a reactive counter every 5s so relative times ("vor 12min")
  // re-render without refetching the list — realtime keeps the data
  // itself up to date.
  tickTimer = setInterval(() => {
    tick.value++
  }, 5_000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

// ─── Shared list toolbar (#1272, stage 3) ───────────────────────────
// Every registered job is already in memory, so the search narrows the
// cards right here — by the job name, the one thing the cards are keyed on.
const search = useListSearch({
  placeholder: 'Job suchen',
  storageKey: 'admin.jobs.search',
})

const searching = computed(() => search.term.value.trim().length > 0)

const visibleJobs = computed(() => {
  const term = search.term.value.trim().toLowerCase()
  if (!term) return jobs.value
  return jobs.value.filter((job) => job.name.toLowerCase().includes(term))
})

const toolbar = useListToolbar({
  search,
  result: {
    loaded: () => visibleJobs.value.length,
    total: () => jobs.value.length,
    loading: () => loading.value,
  },
})

const grouped = computed(() => {
  const map = new Map<string, ScheduledJob[]>()
  for (const job of visibleJobs.value) {
    const key = job.service ?? 'andere'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(job)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
})

const statusSeverity: Record<ScheduledJob['status'], string> = {
  scheduled: 'info',
  running: 'warn',
  ok: 'success',
  error: 'danger',
  deactivated: 'secondary',
  paused: 'secondary',
}

const statusLabel: Record<ScheduledJob['status'], string> = {
  scheduled: 'geplant',
  running: 'läuft',
  ok: 'OK',
  error: 'Fehler',
  deactivated: 'deaktiviert',
  paused: 'pausiert',
}

function formatDate(value: string | null): string {
  if (!value) return '–'
  return new Date(value).toLocaleString('de-DE')
}

function formatRelative(value: string | null): string {
  // tick.value triggers re-evaluation every 5s
  void tick.value
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
  <PageLayout title="Eingeplante Jobs" width="normal" :ready="!loading">
    <template #actions>
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        text
        size="small"
        :loading="loading"
        @click="fetchJobs"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="fetchJobs" @close="error = ''" />
    </template>

    <div class="jobs-page">
    <p class="hint">
      Liste aller Hintergrund-Jobs des lokalen Schedulers. Status-Updates kommen live
      über WebSocket — kein Refresh nötig. „Pausieren" überspringt nur den Handler-Aufruf,
      der Timer bleibt armiert; „Resume" setzt sofort fort. „Jetzt ausführen" startet
      den Job sofort, unabhängig vom nächsten Slot.
    </p>

    <PageSkeleton v-if="loading && jobs.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="visibleJobs.length === 0"
      icon="pi pi-clock"
      :title="searching ? 'Keine Treffer' : 'Keine Jobs registriert'"
      :message="
        searching
          ? 'Zu diesem Suchbegriff passt kein Job.'
          : 'Noch keine Jobs registriert — sobald ein Dienst einen Hintergrund-Job anmeldet, steht er hier.'
      "
      :filtered="searching"
      @clear-filters="search.clear()"
    />

    <div v-for="[service, list] in grouped" :key="service" class="group">
      <h2 class="group-title">{{ service }}</h2>
      <ul class="job-list">
        <li v-for="job in list" :key="job.name" class="job-card">
          <header class="job-header">
            <div class="job-title">
              <strong>{{ job.name }}</strong>
              <span v-if="job.description" class="hint">{{ job.description }}</span>
            </div>
            <Tag :severity="statusSeverity[job.status]" :value="statusLabel[job.status]" />
          </header>

          <dl class="job-fields">
            <div class="field">
              <dt>Schedule</dt>
              <dd><code v-if="job.schedule_label">{{ job.schedule_label }}</code><span v-else>–</span></dd>
            </div>
            <div class="field">
              <dt>Nächster Lauf</dt>
              <dd>
                <span class="when-line">{{ formatDate(job.next_fire_at) }}</span>
                <span class="hint">{{ formatRelative(job.next_fire_at) }}</span>
              </dd>
            </div>
            <div class="field">
              <dt>Letzter Lauf</dt>
              <dd>
                <span class="when-line">{{ formatDate(job.last_run_at) }}</span>
                <span class="hint">
                  <template v-if="job.last_run_at">
                    {{ formatRelative(job.last_run_at) }} · {{ formatDuration(job.last_duration_ms) }}
                  </template>
                  <template v-else>noch nicht gelaufen</template>
                </span>
              </dd>
            </div>
            <div class="field">
              <dt>Läufe</dt>
              <dd>
                <span :class="{ 'has-errors': job.error_count > 0 }">
                  {{ job.run_count }}<template v-if="job.error_count > 0"> · {{ job.error_count }}&nbsp;Fehler</template>
                </span>
              </dd>
            </div>
            <div v-if="job.last_error" class="field full">
              <dt>Letzter Fehler</dt>
              <dd><code class="error">{{ job.last_error }}</code></dd>
            </div>
          </dl>

          <div class="job-actions">
            <Button
              v-if="job.enabled"
              icon="pi pi-pause"
              label="Pausieren"
              size="small"
              severity="secondary"
              :loading="pendingAction[job.name] === 'pause'"
              :disabled="!!pendingAction[job.name]"
              @click="onPause(job)"
            />
            <Button
              v-else
              icon="pi pi-play"
              label="Resume"
              size="small"
              :loading="pendingAction[job.name] === 'resume'"
              :disabled="!!pendingAction[job.name]"
              @click="onResume(job)"
            />
            <Button
              icon="pi pi-bolt"
              label="Jetzt ausführen"
              size="small"
              severity="warn"
              :loading="pendingAction[job.name] === 'run-now'"
              :disabled="!!pendingAction[job.name] || job.status === 'running'"
              @click="onRunNow(job)"
            />
          </div>
        </li>
      </ul>
    </div>
    </div>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.jobs-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
  font-size: var(--text-base);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.group-title {
  margin: 0;
  font-size: var(--text-base);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}
.job-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 0.75rem;
}
.job-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  background: var(--p-content-background);
}
.job-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.job-title {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.job-title strong {
  word-break: break-word;
}
.job-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.field.full {
  grid-column: 1 / -1;
}
.field dt {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}
.field dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}
.when-line {
  display: block;
}
.has-errors {
  color: var(--p-red-500);
}
code.error {
  color: var(--p-red-500);
  font-size: var(--text-md);
  white-space: pre-wrap;
  word-break: break-word;
}
.job-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.job-actions :deep(.p-button) {
  flex: 1 1 auto;
  min-width: 140px;
}

/* Mobile: stack everything single-column, fields become a tighter
 * 2-row stack instead of a 2-column grid (which gets cramped under
 * ~340px). Remove the page padding so cards reach the screen edges. */
@media (max-width: 639px) {
  .jobs-page {
    gap: 0.75rem;
  }
  .job-list {
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  .job-card {
    padding: 0.75rem;
  }
  .job-fields {
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }
  .job-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
  }
}
</style>
