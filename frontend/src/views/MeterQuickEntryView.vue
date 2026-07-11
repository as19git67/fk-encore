<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import {
  addReading,
  getQuickEntryConfig,
  ocrMeterReading,
  saveQuickEntryConfig,
  METER_TYPE_ICONS,
  METER_TYPE_LABELS,
  type MeterListItem,
  type QuickEntryItem,
} from '../api/meters'
import { toLocalIsoDateTime } from '../utils/dateFormat'

interface EntryRow {
  meter: QuickEntryItem
  value: number | null
  saving: boolean
  saved: boolean
  ocrLoading: boolean
  error: string
  info: string
}

const loading = ref(false)
const savingConfig = ref(false)
const error = ref('')
const info = ref('')
const availableMeters = ref<MeterListItem[]>([])
const configuredItems = ref<QuickEntryItem[]>([])
const rows = ref<EntryRow[]>([])
const readingDate = ref(new Date())
const selectedMeterId = ref<number | null>(null)
const ocrFileInput = ref<HTMLInputElement | null>(null)
const ocrTargetMeterId = ref<number | null>(null)

const configuredIds = computed(() => new Set(configuredItems.value.map((item) => item.id)))
const addableMeterOptions = computed(() =>
  availableMeters.value
    .filter((meter) => !configuredIds.value.has(meter.id))
    .map((meter) => ({
      label: `${meter.name} · ${METER_TYPE_LABELS[meter.type]}`,
      value: meter.id,
    })),
)
const hasRows = computed(() => rows.value.length > 0)
const hasPendingValues = computed(() => rows.value.some((row) => row.value !== null && !row.saved))
const saveAllLoading = computed(() => rows.value.some((row) => row.saving))

function formatValue(value: number | null, decimals = 1) {
  if (value === null || value === undefined) return '–'
  return new Intl.NumberFormat(navigator.language, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value)
}

function formatDate(value: string | null) {
  if (!value) return 'noch keine Ablesung'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return new Intl.DateTimeFormat(navigator.language, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)
}

function typeIcon(meter: MeterListItem) {
  return METER_TYPE_ICONS[meter.type] ?? 'pi pi-gauge'
}

function resetRows() {
  rows.value = configuredItems.value.map((meter) => ({
    meter,
    value: null,
    saving: false,
    saved: false,
    ocrLoading: false,
    error: '',
    info: '',
  }))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await getQuickEntryConfig()
    availableMeters.value = res.availableMeters
    configuredItems.value = [...res.items].sort((a, b) => a.sortOrder - b.sortOrder)
    resetRows()
  } catch (err: any) {
    error.value = err.message || 'Schnellerfassung konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function persistConfig(nextItems = configuredItems.value) {
  savingConfig.value = true
  error.value = ''
  try {
    const res = await saveQuickEntryConfig(nextItems.map((item) => item.id))
    availableMeters.value = res.availableMeters
    configuredItems.value = [...res.items].sort((a, b) => a.sortOrder - b.sortOrder)
    resetRows()
    info.value = 'Konfiguration gespeichert.'
  } catch (err: any) {
    error.value = err.message || 'Konfiguration konnte nicht gespeichert werden'
  } finally {
    savingConfig.value = false
  }
}

async function addConfiguredMeter() {
  if (selectedMeterId.value === null) return
  const meter = availableMeters.value.find((candidate) => candidate.id === selectedMeterId.value)
  if (!meter) return
  selectedMeterId.value = null
  const next = [
    ...configuredItems.value,
    { ...meter, sortOrder: configuredItems.value.length },
  ]
  await persistConfig(next)
}

async function removeConfiguredMeter(index: number) {
  const next = configuredItems.value.filter((_, i) => i !== index)
  await persistConfig(next)
}

async function moveConfiguredMeter(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= configuredItems.value.length) return
  const next = [...configuredItems.value]
  const [item] = next.splice(index, 1)
  if (!item) return
  next.splice(target, 0, item)
  await persistConfig(next)
}

function findRow(meterId: number) {
  return rows.value.find((row) => row.meter.id === meterId) ?? null
}

function triggerOcr(row: EntryRow) {
  ocrTargetMeterId.value = row.meter.id
  ocrFileInput.value?.click()
}

async function handleOcrFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  const meterId = ocrTargetMeterId.value
  if (!file || meterId === null) return
  const row = findRow(meterId)
  if (!row) return
  row.ocrLoading = true
  row.error = ''
  row.info = ''
  try {
    const result = await ocrMeterReading(meterId, file)
    if (result.value === null) {
      row.error = 'Kein Zählerstand erkannt. Bitte manuell eingeben.'
      return
    }
    row.value = result.value
    row.saved = false
    row.info = `OCR ${Math.round(result.confidence * 100)}%`
  } catch (err: any) {
    row.error = err.message || 'OCR-Dienst nicht erreichbar'
  } finally {
    row.ocrLoading = false
    ocrTargetMeterId.value = null
    if (ocrFileInput.value) ocrFileInput.value.value = ''
  }
}

async function saveRow(row: EntryRow) {
  row.error = ''
  if (row.value === null || !Number.isFinite(row.value)) {
    row.error = 'Bitte einen Zählerstand eingeben.'
    return
  }
  row.saving = true
  try {
    await addReading(row.meter.id, {
      value: row.value,
      takenAt: toLocalIsoDateTime(readingDate.value),
      notes: row.info || undefined,
      source: row.info.startsWith('OCR') ? 'ocr' : 'manual',
    })
    row.saved = true
    row.info = 'Gespeichert'
  } catch (err: any) {
    row.error = err.message || 'Ablesung konnte nicht gespeichert werden'
  } finally {
    row.saving = false
  }
}

async function saveAll() {
  for (const row of rows.value) {
    if (row.value !== null && !row.saved) {
      await saveRow(row)
    }
  }
}

onMounted(load)
</script>

<template>
  <main class="quick-entry">
    <section class="page-head">
      <div>
        <p class="eyebrow">Zähler</p>
        <h1>Schnellerfassung</h1>
        <p class="muted">Stelle einmal deine Ablese-Liste zusammen und erfasse danach alle Werte mit einem gemeinsamen Datum.</p>
      </div>
      <Button icon="pi pi-refresh" label="Aktualisieren" severity="secondary" outlined :loading="loading" @click="load" />
    </section>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-else-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>

    <section class="card config-card">
      <div class="section-title">
        <div>
          <h2>Konfiguration</h2>
          <p>Diese Liste wird für deinen Benutzer gespeichert.</p>
        </div>
        <Tag :value="`${configuredItems.length} Zähler`" severity="secondary" />
      </div>

      <div class="add-row">
        <Select
          v-model="selectedMeterId"
          :options="addableMeterOptions"
          option-label="label"
          option-value="value"
          filter
          placeholder="Zähler hinzufügen …"
          class="add-select"
        />
        <Button icon="pi pi-plus" label="Hinzufügen" :disabled="selectedMeterId === null" :loading="savingConfig" @click="addConfiguredMeter" />
      </div>

      <div v-if="configuredItems.length === 0" class="empty">
        Noch keine Zähler ausgewählt. Füge oben die Zähler hinzu, die du regelmäßig abliest.
      </div>
      <ol v-else class="config-list">
        <li v-for="(meter, index) in configuredItems" :key="meter.id">
          <span class="meter-icon"><i :class="typeIcon(meter)" /></span>
          <span class="config-name">
            <strong>{{ meter.name }}</strong>
            <small>{{ METER_TYPE_LABELS[meter.type] }} · {{ meter.unit }}</small>
          </span>
          <div class="config-actions">
            <Button icon="pi pi-arrow-up" text rounded severity="secondary" :disabled="index === 0 || savingConfig" @click="moveConfiguredMeter(index, -1)" />
            <Button icon="pi pi-arrow-down" text rounded severity="secondary" :disabled="index === configuredItems.length - 1 || savingConfig" @click="moveConfiguredMeter(index, 1)" />
            <Button icon="pi pi-times" text rounded severity="danger" :disabled="savingConfig" @click="removeConfiguredMeter(index)" />
          </div>
        </li>
      </ol>
    </section>

    <section class="card capture-card">
      <div class="capture-head">
        <div>
          <h2>Ablesungen erfassen</h2>
          <p>Das Datum gilt für alle Werte, die du in dieser Maske speicherst.</p>
        </div>
        <label class="date-field">Datum
          <DatePicker v-model="readingDate" date-format="dd.mm.yy" />
        </label>
      </div>

      <div v-if="!hasRows" class="empty">Konfiguriere zuerst mindestens einen Zähler.</div>
      <div v-else class="entry-list">
        <article v-for="row in rows" :key="row.meter.id" class="entry-row" :class="{ saved: row.saved }">
          <div class="entry-main">
            <span class="meter-icon"><i :class="typeIcon(row.meter)" /></span>
            <div class="entry-title">
              <strong>{{ row.meter.name }}</strong>
              <small>
                Vorher: {{ formatValue(row.meter.lastReadingValue, row.meter.decimals) }} {{ row.meter.unit }}
                <span v-if="row.meter.lastReadingAt"> · {{ formatDate(row.meter.lastReadingAt) }}</span>
              </small>
            </div>
          </div>
          <div class="entry-input">
            <InputNumber
              v-model="row.value"
              :min-fraction-digits="0"
              :max-fraction-digits="row.meter.decimals"
              :placeholder="row.meter.unit"
              fluid
              @update:model-value="row.saved = false"
            />
            <span class="unit">{{ row.meter.unit }}</span>
            <Button
              icon="pi pi-camera"
              severity="secondary"
              outlined
              :loading="row.ocrLoading"
              v-tooltip.top="'Foto-Erkennung'"
              @click="triggerOcr(row)"
            />
            <Button
              icon="pi pi-check"
              :label="row.saved ? 'Gespeichert' : 'Speichern'"
              :severity="row.saved ? 'success' : 'primary'"
              :loading="row.saving"
              @click="saveRow(row)"
            />
          </div>
          <Message v-if="row.error" severity="warn" :closable="false" class="row-msg">{{ row.error }}</Message>
          <small v-else-if="row.info" class="row-info">{{ row.info }}</small>
        </article>
      </div>

      <div v-if="hasRows" class="capture-footer">
        <Button
          icon="pi pi-save"
          label="Alle eingegebenen speichern"
          :disabled="!hasPendingValues"
          :loading="saveAllLoading"
          @click="saveAll"
        />
      </div>
    </section>

    <input ref="ocrFileInput" type="file" accept="image/*" capture="environment" class="hidden-file" @change="handleOcrFile" />
  </main>
</template>

<style scoped>
.quick-entry {
  max-width: 980px;
  margin: 0 auto;
  padding: 1rem;
}

.page-head,
.section-title,
.capture-head,
.entry-main,
.entry-input,
.add-row,
.config-list li,
.capture-footer {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.page-head,
.section-title,
.capture-head {
  justify-content: space-between;
}

.eyebrow,
.muted,
.section-title p,
.capture-head p,
.config-name small,
.entry-title small,
.row-info {
  color: var(--text-color-secondary);
}

.eyebrow {
  margin: 0 0 0.2rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.8rem;
}

h1,
h2,
p {
  margin-top: 0;
}

.card {
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid var(--surface-border);
  border-radius: 16px;
  background: var(--surface-card);
}

.add-select {
  flex: 1;
  min-width: 0;
}

.empty {
  padding: 1rem;
  border: 1px dashed var(--surface-border);
  border-radius: 12px;
  color: var(--text-color-secondary);
}

.config-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: grid;
  gap: 0.5rem;
}

.config-list li,
.entry-row {
  border: 1px solid var(--surface-border);
  border-radius: 14px;
  background: var(--surface-ground);
}

.config-list li {
  padding: 0.65rem;
}

.meter-icon {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 12%, transparent);
  flex: 0 0 auto;
}

.config-name,
.entry-title {
  min-width: 0;
  flex: 1;
  display: grid;
}

.config-name strong,
.entry-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
}

.date-field {
  display: grid;
  gap: 0.25rem;
  min-width: 12rem;
}

.entry-list {
  display: grid;
  gap: 0.75rem;
}

.entry-row {
  padding: 0.8rem;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(19rem, 26rem);
  gap: 0.8rem;
}

.entry-row.saved {
  border-color: color-mix(in srgb, var(--green-500) 55%, var(--surface-border));
}

.unit {
  color: var(--text-color-secondary);
  min-width: 2.5rem;
}

.row-msg,
.row-info {
  grid-column: 1 / -1;
}

.capture-footer {
  justify-content: flex-end;
  margin-top: 1rem;
}

.hidden-file {
  display: none;
}

@media (max-width: 760px) {
  .quick-entry {
    padding: 0.75rem;
  }

  .page-head,
  .section-title,
  .capture-head,
  .add-row {
    align-items: stretch;
    flex-direction: column;
  }

  .entry-row {
    grid-template-columns: 1fr;
  }

  .entry-input {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .entry-input :deep(.p-button:last-child) {
    grid-column: 1 / -1;
  }

  .config-actions {
    gap: 0;
  }
}
</style>
