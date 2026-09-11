<script setup lang="ts">
/**
 * Meter anomalies inbox (Issue #792, Etappe 7 / #1015) — the utility-meter
 * counterpart of the finance anomalies view. Findings of the daily job are
 * confirmed (worth a look, keep it) or dismissed.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
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
const scope = ref<'pending' | 'all'>('pending')
const typeFilter = ref<'all' | MeterAnomalyType>('all')

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

const filtered = computed(() =>
  typeFilter.value === 'all'
    ? anomalies.value
    : anomalies.value.filter((item) => item.type === typeFilter.value),
)

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
  <div class="page">
    <header class="page-header">
      <h1>Zähler-Auffälligkeiten</h1>
      <div class="header-actions">
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
      </div>
    </header>

    <p class="page-hint">
      Die tägliche Prüfung vergleicht den Tagesverbrauch der letzten Ableseintervalle mit dem
      bisherigen Verlauf und mit dem gleichen Zeitraum des Vorjahres. <strong>Bestätigen</strong>
      hält eine echte Auffälligkeit fest, <strong>Verwerfen</strong> räumt sie aus dem Postfach.
    </p>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="filter-row">
      <Select v-model="scope" :options="scopeOptions" option-label="label" option-value="value" class="filter-select" @change="load" />
      <Select v-model="typeFilter" :options="typeOptions" option-label="label" option-value="value" class="filter-select" />
    </div>

    <div v-if="loading && anomalies.length === 0" class="loading">Lädt …</div>

    <section v-else-if="filtered.length === 0" class="empty">
      <i class="pi pi-check-circle empty-icon" />
      <p>Keine {{ scope === 'pending' ? 'offenen ' : '' }}Auffälligkeiten.</p>
    </section>

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
  </div>
</template>

<style scoped>
.page {
  padding: 1rem;
  max-width: 64rem;
  margin: 0 auto;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.page-header h1 {
  margin: 0;
  font-size: 1.4rem;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.page-hint {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}
.filter-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.filter-select {
  min-width: 11rem;
}
.loading,
.empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 2rem 0;
}
.empty-icon {
  font-size: 2rem;
  color: var(--p-tag-success-color);
  display: block;
  margin-bottom: 0.5rem;
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
