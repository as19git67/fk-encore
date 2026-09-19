<script setup lang="ts">
/**
 * Meter anomalies inbox (Issue #792, Etappe 7 / #1015) — the utility-meter
 * counterpart of the finance anomalies view. Findings of the daily job are
 * confirmed (worth a look, keep it) or dismissed.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListToolbar, useListView } from '../composables/useListToolbar'
import type { FilterChip } from '../components/layout/listToolbar'
import {
  listMeterAnomalies,
  setMeterAnomalyStatus,
  runMeterAnomalyDetection,
  METER_ANOMALY_TYPE_LABELS,
  METER_TYPE_ICONS,
  type MeterAnomalyItem,
  type MeterAnomalyStatus,
  type MeterAnomalyType,
} from '../api/meters'
import { useAuthStore } from '../stores/auth'
import { useMeterAnomalyStore } from '../stores/meterAnomalies'

const router = useRouter()
const auth = useAuthStore()
const badgeStore = useMeterAnomalyStore()

const canResolve = computed(() => auth.hasPermission('meters.read_entry'))
const canRun = computed(() => auth.hasPermission('meters.manage'))

const anomalies = ref<MeterAnomalyItem[]>([])
const loading = ref(false)
const running = ref(false)
const error = ref<string | null>(null)
const busy = ref<Set<number>>(new Set())

const scopeOptions = [
  { label: 'Offen', value: 'pending' },
  { label: 'Alle', value: 'all' },
]
const typeOptions = [
  { label: 'Alle Arten', value: 'all' },
  ...(Object.keys(METER_ANOMALY_TYPE_LABELS) as MeterAnomalyType[]).map((value) => ({
    label: METER_ANOMALY_TYPE_LABELS[value],
    value,
  })),
]

// Both dropdowns live in the URL, so a reload — or a link someone shared —
// reproduces the list that was on screen. `scope` costs a round trip,
// `type` narrows what is already loaded.
const scopeView = useListView({ options: scopeOptions, defaultValue: 'pending', key: 'scope' })
const scopeValue = scopeView.value
const scope = computed(() => scopeValue.value as 'pending' | 'all')

const typeView = useListView({ options: typeOptions, defaultValue: 'all', key: 'type' })
const typeValue = typeView.value
const typeFilter = computed(() => typeValue.value as 'all' | MeterAnomalyType)

const filtered = computed(() =>
  typeFilter.value === 'all'
    ? anomalies.value
    : anomalies.value.filter((item) => item.type === typeFilter.value),
)

// Covers the dropdown as well as browser back/forward, which write the
// query key without going through the control.
watch(scope, () => load())

function labelOf(options: { label: string; value: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value
}

const filterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = []
  if (scopeValue.value !== 'pending') {
    chips.push({
      key: 'scope',
      label: `Umfang: ${labelOf(scopeOptions, scopeValue.value)}`,
      remove: () => { scopeValue.value = 'pending' },
    })
  }
  if (typeValue.value !== 'all') {
    chips.push({
      key: 'type',
      label: `Art: ${labelOf(typeOptions, typeValue.value)}`,
      remove: () => { typeValue.value = 'all' },
    })
  }
  return chips
})

function clearFilters() {
  scopeValue.value = 'pending'
  typeValue.value = 'all'
}

const toolbar = useListToolbar({
  filter: {
    chips: filterChips,
    activeCount: () => filterChips.value.length,
    clearAll: clearFilters,
  },
  result: {
    loaded: () => filtered.value.length,
    // The type filter narrows client-side, so the loaded count is "of what
    // the scope returned".
    total: () => anomalies.value.length,
    loading: () => loading.value,
  },
})

async function load() {
  loading.value = true
  error.value = null
  try {
    anomalies.value = (await listMeterAnomalies(scope.value)).anomalies
  } catch (e: any) {
    error.value = e?.message ?? 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function setStatus(item: MeterAnomalyItem, status: MeterAnomalyStatus) {
  if (busy.value.has(item.id)) return
  busy.value.add(item.id)
  try {
    await setMeterAnomalyStatus(item.id, status)
    if (scope.value === 'pending' && status !== 'pending') {
      anomalies.value = anomalies.value.filter((a) => a.id !== item.id)
    } else {
      item.status = status
      item.resolvedAt = status === 'pending' ? null : new Date().toISOString()
    }
    void badgeStore.refresh()
  } catch (e: any) {
    error.value = e?.message ?? 'Status konnte nicht gesetzt werden'
  } finally {
    busy.value.delete(item.id)
  }
}

async function dismissAll() {
  for (const item of filtered.value.filter((a) => a.status === 'pending')) {
    await setStatus(item, 'dismissed')
  }
}

async function runNow() {
  running.value = true
  error.value = null
  try {
    await runMeterAnomalyDetection()
    await load()
    void badgeStore.refresh()
  } catch (e: any) {
    error.value = e?.message ?? 'Prüfung fehlgeschlagen'
  } finally {
    running.value = false
  }
}

function openMeter(item: MeterAnomalyItem) {
  void router.push({ name: 'zaehler-detail', params: { id: item.meterId } })
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function iconFor(type: MeterAnomalyType): string {
  switch (type) {
    case 'consumption_spike': return 'pi pi-arrow-up-right'
    case 'consumption_drop': return 'pi pi-arrow-down-right'
    case 'standstill': return 'pi pi-pause-circle'
    case 'negative_consumption': return 'pi pi-undo'
  }
}

function severityClass(type: MeterAnomalyType): string {
  switch (type) {
    case 'consumption_spike': return 'sev-warn'
    case 'consumption_drop': return 'sev-info'
    case 'standstill': return 'sev-danger'
    case 'negative_consumption': return 'sev-danger'
  }
}

function statusSeverity(status: MeterAnomalyStatus) {
  return status === 'confirmed' ? 'warn' : status === 'dismissed' ? 'secondary' : 'info'
}

function statusLabel(status: MeterAnomalyStatus) {
  return status === 'confirmed' ? 'Bestätigt' : status === 'dismissed' ? 'Verworfen' : 'Offen'
}
</script>

<template>
  <PageLayout title="Zähler-Auffälligkeiten" width="normal" :ready="!loading">
    <template #actions>
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        severity="secondary"
        text
        :disabled="loading"
        @click="load"
      />
      <Button
        v-if="canRun"
        icon="pi pi-play"
        label="Jetzt prüfen"
        severity="secondary"
        :loading="running"
        v-tooltip.bottom="'Die tägliche Prüfung sofort ausführen'"
        @click="runNow"
      />
      <Button
        v-if="canResolve && filtered.some((a) => a.status === 'pending')"
        icon="pi pi-check"
        label="Alle verwerfen"
        severity="secondary"
        @click="dismissAll"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <Select
            v-model="scopeValue"
            :options="scopeOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Umfang"
            class="filter-select"
          />
          <Select
            v-model="typeValue"
            :options="typeOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Art der Auffälligkeit"
            class="filter-select"
          />
        </template>
      </ListToolbar>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />
    </template>

    <p class="intro-hint">
      Die tägliche Prüfung vergleicht den Tagesverbrauch der letzten Ableseintervalle mit dem
      bisherigen Verlauf und mit dem gleichen Zeitraum des Vorjahres. <strong>Bestätigen</strong>
      hält eine echte Auffälligkeit fest, <strong>Verwerfen</strong> räumt sie aus dem Postfach.
    </p>

    <PageSkeleton v-if="loading && anomalies.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="filtered.length === 0"
      icon="pi pi-check-circle"
      :title="scope === 'pending' ? 'Keine offenen Auffälligkeiten' : 'Keine Auffälligkeiten'"
      :message="filterChips.length > 0
        ? 'Mit anderen Filtereinstellungen findet sich vielleicht etwas.'
        : 'Die tägliche Prüfung hat nichts gefunden.'"
      :filtered="filterChips.length > 0"
      @clear-filters="clearFilters"
    />

    <ul v-else class="anomaly-list">
      <li v-for="item in filtered" :key="item.id" :class="['anomaly-card', severityClass(item.type)]">
        <div class="card-icon">
          <i :class="iconFor(item.type)" />
        </div>
        <div class="card-body">
          <div class="card-head">
            <span class="card-type">{{ METER_ANOMALY_TYPE_LABELS[item.type] }}</span>
            <button type="button" class="card-meter" @click="openMeter(item)">
              <i :class="METER_TYPE_ICONS[item.meterType]" /> {{ item.meterName }}
            </button>
            <Tag v-if="scope === 'all'" :value="statusLabel(item.status)" :severity="statusSeverity(item.status)" />
            <span class="card-date">{{ fmtDate(item.intervalStart) }} – {{ fmtDate(item.intervalEnd) }}</span>
          </div>
          <p class="card-message">{{ item.message }}</p>
          <div v-if="item.score !== null" class="card-detail">
            Abweichung: {{ item.score.toLocaleString('de-DE', { maximumFractionDigits: 1 }) }} σ
            <template v-if="item.details.seasonalRate !== null && item.details.seasonalRate !== undefined">
              · Vorjahr gleicher Zeitraum: {{ Number(item.details.seasonalRate).toLocaleString('de-DE', { maximumFractionDigits: 3 }) }} {{ item.unit }}/Tag
            </template>
          </div>
        </div>
        <div v-if="canResolve" class="card-actions">
          <template v-if="item.status === 'pending'">
            <Button
              icon="pi pi-flag"
              label="Bestätigen"
              size="small"
              severity="warn"
              outlined
              :loading="busy.has(item.id)"
              @click="setStatus(item, 'confirmed')"
            />
            <Button
              icon="pi pi-times"
              label="Verwerfen"
              size="small"
              severity="secondary"
              text
              :loading="busy.has(item.id)"
              @click="setStatus(item, 'dismissed')"
            />
          </template>
          <Button
            v-else
            icon="pi pi-replay"
            label="Wieder öffnen"
            size="small"
            severity="secondary"
            text
            :loading="busy.has(item.id)"
            @click="setStatus(item, 'pending')"
          />
        </div>
      </li>
    </ul>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.intro-hint {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}
.filter-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.filter-select {
  min-width: 13rem;
}
.anomaly-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.anomaly-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: start;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--p-content-border-color);
  border-left-width: 4px;
  border-radius: 10px;
  background: var(--p-content-background);
}
.sev-warn {
  border-left-color: var(--p-tag-warn-color);
}
.sev-danger {
  border-left-color: var(--p-tag-danger-color);
}
.sev-info {
  border-left-color: var(--p-tag-info-color);
}
.card-icon {
  font-size: 1.2rem;
  color: var(--p-text-muted-color);
  padding-top: 0.15rem;
}
.card-body {
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
}
.card-type {
  font-weight: 600;
  color: var(--p-text-color);
}
.card-meter {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--p-primary-color);
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.card-meter:hover {
  text-decoration: underline;
}
.card-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.card-message {
  margin: 0.35rem 0 0;
  font-size: 0.9rem;
  color: var(--p-text-color);
}
.card-detail {
  margin-top: 0.25rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
.card-actions {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-items: stretch;
}
@media (max-width: 560px) {
  .anomaly-card {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .card-actions {
    grid-column: 2;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
