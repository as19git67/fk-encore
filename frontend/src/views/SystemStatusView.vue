<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
import { getRoutingStatus, type RoutingStatus } from '../api/system'
import { formatDateShort } from '../utils/dateFormat'

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

/**
 * The router (§24 of the trip-planner concept): reachable, tiles, and
 * whether a region came after the tiles were built. Read-only like the
 * queues — the only action, restarting the routing container, is not
 * the app's to take.
 */
const routing = ref<RoutingStatus | null>(null)
const routingFailed = ref(false)

async function refreshRouting() {
  try {
    routing.value = await getRoutingStatus()
    routingFailed.value = false
  } catch {
    routingFailed.value = true
  }
}

const routingLine = computed(() => {
  const r = routing.value
  if (!r) return routingFailed.value ? 'Status nicht abrufbar.' : 'Wird geladen …'
  if (!r.reachable) return 'Nicht erreichbar — der Planer schätzt Reisezeiten.'
  if (!r.hasTiles) return 'Erreichbar, aber ohne Kacheln — der Planer schätzt Reisezeiten.'
  return `Bereit${r.version ? ` (Valhalla ${r.version})` : ''}.`
})

onMounted(() => { void refresh(); void refreshRouting() })
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

    <section class="status-services">
      <h2 class="status-services__title">Dienste</h2>
      <div class="status-tiles">
        <div class="status-tile" :class="{ 'status-tile--warn': routing?.tilesBehindRegion || routing?.reachable === false }">
          <div class="status-tile__head">
            <i class="pi pi-directions" />
            <span class="status-tile__label">Routing</span>
          </div>
          <p class="status-tile__desc">
            Echte Reisezeiten für den Reiseplaner, gebaut aus den importierten OSM-Regionen.
          </p>
          <p class="status-tile__line">{{ routingLine }}</p>
          <dl v-if="routing?.reachable" class="status-tile__facts">
            <div>
              <dt>Kacheln gebaut</dt>
              <dd>{{ routing.tilesBuiltAt ? formatDateShort(routing.tilesBuiltAt) : '–' }}</dd>
            </div>
            <div>
              <dt>Neueste Region</dt>
              <dd>{{ routing.newestRegionAt ? formatDateShort(routing.newestRegionAt) : '–' }}</dd>
            </div>
          </dl>
          <p v-if="routing?.tilesBehindRegion" class="status-tile__warn">
            Eine Region ist jünger als die Kacheln: Sie ist für Spots durchsuchbar, aber noch nicht
            routbar. Den Routing-Container neu starten, dann baut er die Kacheln neu.
          </p>
        </div>
      </div>
    </section>

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
  font-size: var(--text-base);
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
  font-size: var(--text-sm);
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.status-tile__counts dd {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.status-tile__count--bad dd {
  color: var(--p-tag-danger-color);
}

.status-services {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-self: stretch;
}

.status-services__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.status-tile--warn {
  border-color: var(--p-tag-warn-color);
}

.status-tile__line {
  margin: 0;
  font-size: var(--text-base);
}

.status-tile__facts {
  display: flex;
  gap: 1.25rem;
  margin: 0;
}

.status-tile__facts div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.status-tile__facts dt {
  font-size: var(--text-sm);
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.status-tile__facts dd {
  margin: 0;
  font-size: var(--text-base);
  font-variant-numeric: tabular-nums;
}

.status-tile__warn {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-tag-warn-color);
}
</style>
