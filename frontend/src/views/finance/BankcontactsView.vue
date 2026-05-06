<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import type { Bankcontact, SyncSlot } from '../../api/finance'
import TanDialog from '../../components/finance/TanDialog.vue'

const store = useBankcontactsStore()
const router = useRouter()

const syncingId = ref<number | null>(null)
const syncError = ref<string | null>(null)

// Re-renders the relative-time widget every 30 s so "in 12 Min" stays
// honest without forcing a re-fetch.
const tickNow = ref(new Date())
let tickHandle: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void store.refresh()
  tickHandle = setInterval(() => {
    tickNow.value = new Date()
  }, 30_000)
})
onUnmounted(() => {
  if (tickHandle !== null) clearInterval(tickHandle)
})

// ----- Overview-Widget (oberhalb der Tabelle) -------------------------

const pendingTanContacts = computed<Bankcontact[]>(() =>
  store.items.filter((b) => b.last_sync_status === 'tan-required'),
)

interface NextSyncInfo {
  bankcontact: Bankcontact
  slot: SyncSlot
  weekday: number
  minutesAhead: number
}

const nextSync = computed<NextSyncInfo | null>(() => {
  let best: NextSyncInfo | null = null
  for (const bc of store.items) {
    for (const slot of bc.sync_times ?? []) {
      const ahead = minutesUntilNextSlot(slot, tickNow.value)
      if (ahead === null) continue
      if (!best || ahead.minutesAhead < best.minutesAhead) {
        best = { bankcontact: bc, slot, weekday: ahead.weekday, minutesAhead: ahead.minutesAhead }
      }
    }
  }
  return best
})

const nextSyncLabel = computed<string>(() => {
  const n = nextSync.value
  if (!n) return 'Kein Sync-Zeitplan konfiguriert'
  return `${n.bankcontact.name}: ${WEEKDAY_LABELS_DE[n.weekday]} ${n.slot.time} (${formatRelative(n.minutesAhead)})`
})

const WEEKDAY_LABELS_DE: Record<number, string> = {
  0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa',
}
const _WEEKDAY_PARSE: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

function partsInTz(tz: string, when: Date): { weekday: number; hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(when)
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? ''
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN)
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN)
    const weekday = _WEEKDAY_PARSE[wd]
    if (weekday === undefined || Number.isNaN(h) || Number.isNaN(m)) return null
    // `hour: '2-digit', hour12: false` returns "24" at midnight in some
    // locales — clamp to [0,23].
    const hour = h === 24 ? 0 : h
    return { weekday, hour, minute: m }
  } catch {
    // Invalid tz string. Skip silently — the cron itself rejects bad
    // tz on save, so we shouldn't normally see this.
    return null
  }
}

function minutesUntilNextSlot(
  slot: SyncSlot,
  now: Date,
): { weekday: number; minutesAhead: number } | null {
  const cur = partsInTz(slot.tz, now)
  if (!cur) return null
  const [hStr, mStr] = slot.time.split(':')
  const slotH = Number(hStr)
  const slotM = Number(mStr)
  if (Number.isNaN(slotH) || Number.isNaN(slotM)) return null
  const slotMinOfDay = slotH * 60 + slotM
  const nowMinOfDay = cur.hour * 60 + cur.minute
  const allowedDays = slot.weekdays.length > 0 ? slot.weekdays : [0, 1, 2, 3, 4, 5, 6]

  for (let d = 0; d < 8; d++) {
    const targetWeekday = (cur.weekday + d) % 7
    if (!allowedDays.includes(targetWeekday)) continue
    if (d === 0 && slotMinOfDay <= nowMinOfDay) continue
    return { weekday: targetWeekday, minutesAhead: d * 1440 + (slotMinOfDay - nowMinOfDay) }
  }
  return null
}

function formatRelative(minutes: number): string {
  if (minutes < 60) return `in ${minutes} Min.`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) {
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`
  }
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh === 0 ? `in ${d}d` : `in ${d}d ${hh}h`
}

function jumpToFirstPending() {
  const target = pendingTanContacts.value[0]
  if (target) openDetail(target.id)
}

function statusSeverity(status: string | null): 'success' | 'warn' | 'danger' | 'secondary' {
  if (!status) return 'secondary'
  if (status === 'ok') return 'success'
  if (status === 'tan-required') return 'warn'
  if (status.startsWith('error')) return 'danger'
  return 'secondary'
}

function statusLabel(status: string | null): string {
  if (!status) return '—'
  if (status === 'ok') return 'OK'
  if (status === 'tan-required') return 'TAN offen'
  if (status.startsWith('error:')) return `Fehler ${status.slice(6)}`
  return status
}

async function triggerSync(id: number) {
  syncingId.value = id
  syncError.value = null
  try {
    const resp = await store.syncNow(id)
    if (resp.state === 'error') {
      syncError.value = `${resp.errorCode}: ${resp.errorMessage}`
    }
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncingId.value = null
  }
}

function openDetail(id: number) {
  void router.push({ name: 'finance-bankcontact-detail', params: { id } })
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Bankkontakte</h1>
      <div class="header-actions">
        <Button
          icon="pi pi-question-circle"
          severity="secondary"
          text
          aria-label="Hilfe"
          v-tooltip.bottom="'Hilfe / Wie funktioniert das?'"
          @click="router.push({ name: 'finance-bankcontacts-help' })"
        />
        <Button
          label="Neu anlegen"
          icon="pi pi-plus"
          @click="router.push({ name: 'finance-bankcontact-new' })"
        />
      </div>
    </header>

    <Message v-if="store.error" severity="error" :closable="false">
      {{ store.error }}
    </Message>
    <Message v-if="syncError" severity="error" :closable="true" @close="syncError = null">
      {{ syncError }}
    </Message>

    <section v-if="store.items.length > 0" class="overview">
      <button
        type="button"
        class="overview-card overview-card--tan"
        :class="{ 'is-clickable': pendingTanContacts.length > 0 }"
        :disabled="pendingTanContacts.length === 0"
        @click="jumpToFirstPending"
      >
        <i class="pi pi-shield" aria-hidden="true" />
        <span class="overview-card__label">TAN offen</span>
        <span class="overview-card__value">
          {{ pendingTanContacts.length }}
          <small v-if="pendingTanContacts.length > 0">
            ({{ pendingTanContacts.map((b) => b.name).join(', ') }})
          </small>
        </span>
      </button>

      <div class="overview-card overview-card--sync">
        <i class="pi pi-clock" aria-hidden="true" />
        <span class="overview-card__label">Nächster Sync</span>
        <span class="overview-card__value">{{ nextSyncLabel }}</span>
      </div>
    </section>

    <DataTable
      :value="store.items"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      @row-click="(e) => openDetail((e.data as { id: number }).id)"
      striped-rows
    >
      <Column field="name" header="Name" />
      <Column field="blz" header="BLZ" class="hidden md:table-cell" headerClass="hidden md:table-cell" />
      <Column field="login" header="Login" class="hidden md:table-cell" headerClass="hidden md:table-cell" />
      <Column header="Letzter Sync">
        <template #body="{ data }">
          {{ data.last_sync_at ? new Date(data.last_sync_at).toLocaleString('de-DE') : '—' }}
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag :severity="statusSeverity(data.last_sync_status)" :value="statusLabel(data.last_sync_status)" />
        </template>
      </Column>
      <Column header="Aktionen" :style="{ width: '12rem' }" class="hidden md:table-cell" headerClass="hidden md:table-cell">
        <template #body="{ data }">
          <Button
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            text
            :loading="syncingId === data.id"
            @click.stop="triggerSync(data.id)"
            v-tooltip="'Sync jetzt'"
          />
        </template>
      </Column>
    </DataTable>

    <TanDialog />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}
/* Mobile: tighter padding so the list reaches the viewport edges. */
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
.header-actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0.75rem;
}
.overview-card {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  column-gap: 0.75rem;
  row-gap: 0.1rem;
  align-items: center;
  padding: 0.85rem 1rem;
  background: var(--p-surface-50);
  border: 1px solid var(--p-surface-200);
  border-radius: 0.5rem;
  text-align: left;
  font: inherit;
  color: inherit;
}
.overview-card > i {
  grid-row: 1 / span 2;
  font-size: 1.5rem;
  color: var(--p-text-muted-color);
}
.overview-card__label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.overview-card__value {
  font-size: 1rem;
  line-height: 1.25;
}
.overview-card__value small {
  display: block;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
  margin-top: 0.1rem;
}
.overview-card--tan {
  cursor: default;
}
.overview-card--tan.is-clickable {
  cursor: pointer;
  background: var(--p-yellow-50, #fffbe6);
  border-color: var(--p-yellow-300, #facc15);
}
.overview-card--tan.is-clickable > i {
  color: var(--p-yellow-700, #a16207);
}
.overview-card--tan.is-clickable:hover {
  background: var(--p-yellow-100, #fef3c7);
}
</style>
