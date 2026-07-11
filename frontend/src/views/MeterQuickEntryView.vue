<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import {
  addReading,
  getQuickEntryConfig,
  ocrMeterReading,
  METER_TYPE_ICONS,
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

const router = useRouter()
const loading = ref(false)
const error = ref('')
const info = ref('')
const configuredItems = ref<QuickEntryItem[]>([])
const rows = ref<EntryRow[]>([])
const readingDate = ref(new Date())
const ocrFileInput = ref<HTMLInputElement | null>(null)
const ocrTargetMeterId = ref<number | null>(null)

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
    configuredItems.value = [...res.items].sort((a, b) => a.sortOrder - b.sortOrder)
    resetRows()
  } catch (err: any) {
    error.value = err.message || 'Schnellerfassung konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

function openConfig() {
  void router.push({ name: 'zaehler-schnellerfassung-config' })
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
        <p class="muted">Erfasse deine vorbereitete Ablese-Liste mit einem gemeinsamen Datum.</p>
      </div>
      <div class="head-actions">
        <Button icon="pi pi-cog" severity="secondary" outlined rounded v-tooltip.bottom="'Schnellerfassung konfigurieren'" @click="openConfig" />
      </div>
    </section>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-else-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>

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

      <div v-if="!hasRows" class="empty empty-config">
        <span>Konfiguriere zuerst mindestens einen Zähler.</span>
        <Button icon="pi pi-cog" label="Konfiguration öffnen" severity="secondary" outlined @click="openConfig" />
      </div>
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
.capture-head,
.entry-main,
.entry-input,
.head-actions,
.capture-footer {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.page-head,
.capture-head {
  justify-content: space-between;
}

.eyebrow,
.muted,
.capture-head p,
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

.empty {
  padding: 1rem;
  border: 1px dashed var(--surface-border);
  border-radius: 12px;
  color: var(--text-color-secondary);
}

.empty-config {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
}

.entry-row {
  border: 1px solid var(--surface-border);
  border-radius: 14px;
  background: var(--surface-ground);
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

.entry-title {
  min-width: 0;
  flex: 1;
  display: grid;
}

.entry-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  .capture-head,
  .head-actions,
  .empty-config {
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
}
</style>
