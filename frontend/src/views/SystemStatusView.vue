<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import AdminPage from '../components/admin/AdminPage.vue'
import BuildInfo from '../components/admin/BuildInfo.vue'
import { visibleQueues, type QueueOverviewEntry } from '../config/queueOverview'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import { getScanQueueStatus } from '../api/photos'
import { getDocumentQueueStatus } from '../api/documents'
import { getFinanceTagQueueStatus } from '../api/finance'

interface QueueCounts {
  pending: number
  processing: number
  failed: number
}

const auth = useAuthStore()
const router = useRouter()

const queues = visibleQueues((key) => auth.hasPermission(key))
const counts = ref<Record<string, QueueCounts | null>>(
  Object.fromEntries(queues.map((q) => [q.id, null])),
)

/**
 * Read-only status only: every queue is operated from its own module page,
 * which is where the buttons live. This page exists so "is anything stuck?"
 * can be answered without visiting three modules.
 */
const loaders: Record<string, () => Promise<QueueCounts>> = {
  photos: async () => {
    const { services } = await getScanQueueStatus()
    return sum(services)
  },
  documents: async () => {
    const { services } = await getDocumentQueueStatus()
    return sum(services)
  },
  finance: async () => {
    const { status } = await getFinanceTagQueueStatus()
    return { pending: status.pending, processing: status.processing, failed: status.failed }
  },
}

function sum(services: Array<{ pending: number; processing: number; failed: number }>): QueueCounts {
  return services.reduce(
    (acc, svc) => ({
      pending: acc.pending + svc.pending,
      processing: acc.processing + svc.processing,
      failed: acc.failed + svc.failed,
    }),
    { pending: 0, processing: 0, failed: 0 },
  )
}

async function refresh() {
  await Promise.all(
    queues.map(async (q) => {
      const load = loaders[q.id]
      if (!load) return
      try {
        counts.value[q.id] = await load()
      } catch {
        // Leave the tile in its "–" state; the next push event retries.
      }
    }),
  )
}

onMounted(refresh)
useRealtimeEvent('scan-queue', 'state.changed', () => { void refresh() })

function open(entry: QueueOverviewEntry) {
  void router.push({ name: entry.routeName })
}
</script>

<template>
  <AdminPage title="Systemstatus">
    <div v-if="queues.length === 0" class="status-empty">
      Für die Hintergrund-Warteschlangen fehlen dir die nötigen Rechte.
    </div>

    <div v-else class="status-tiles">
      <div v-for="q in queues" :key="q.id" class="status-tile">
        <div class="status-tile__head">
          <i :class="q.icon" />
          <span class="status-tile__label">{{ q.label }}</span>
        </div>
        <p class="status-tile__desc">{{ q.description }}</p>
        <dl class="status-tile__counts">
          <div>
            <dt>Ausstehend</dt>
            <dd>{{ counts[q.id]?.pending ?? '–' }}</dd>
          </div>
          <div>
            <dt>In Arbeit</dt>
            <dd>{{ counts[q.id]?.processing ?? '–' }}</dd>
          </div>
          <div :class="{ 'status-tile__count--bad': (counts[q.id]?.failed ?? 0) > 0 }">
            <dt>Fehler</dt>
            <dd>{{ counts[q.id]?.failed ?? '–' }}</dd>
          </div>
        </dl>
        <Button
          label="Öffnen"
          icon="pi pi-arrow-right"
          icon-pos="right"
          size="small"
          outlined
          @click="open(q)"
        />
      </div>
    </div>

    <BuildInfo />
  </AdminPage>
</template>

<style scoped>
.status-empty {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.status-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
  align-self: stretch;
}

.status-tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
}

.status-tile__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}

.status-tile__desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.status-tile__counts {
  display: flex;
  gap: 1.25rem;
  margin: 0.25rem 0 0.5rem;
}

.status-tile__counts div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.status-tile__counts dt {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.status-tile__counts dd {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.status-tile__count--bad dd {
  color: var(--p-tag-danger-color, #c62828);
}
</style>
