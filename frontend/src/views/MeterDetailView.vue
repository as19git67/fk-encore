<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import Chart from 'primevue/chart'
import SelectButton from 'primevue/selectbutton'
import { useConfirm } from 'primevue/useconfirm'
import {
  getMeter,
  updateMeter,
  deleteMeter,
  replaceMeterDevice,
  updateMeterDevice,
  deleteMeterDevice,
  listReadings,
  addReading,
  updateReading,
  deleteReading,
  listApiKeys,
  createApiKey,
  deleteApiKey,
  ocrMeterReading,
  getMeterReport,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  METER_ROLE_LABELS,
  type MeterDetail,
  type MeterDevice,
  type MeterRole,
  type MeterType,
  type Reading,
  type ApiKey,
  type MeterReport,
  type MeterReportGranularity,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const confirmDialog = useConfirm()
const canManage = computed(() => auth.hasPermission('meters.manage'))
const canEnter = computed(() => auth.hasPermission('meters.read_entry'))

const meterId = computed(() => Number(route.params.id))

const detail = ref<MeterDetail | null>(null)
const groups = ref<GroupSummary[]>([])
const loading = ref(false)
const error = ref('')

const typeOptions = (Object.keys(METER_TYPE_LABELS) as MeterType[]).map((value) => ({
  label: METER_TYPE_LABELS[value],
  value,
}))
const roleOptions: Array<{ label: string; value: MeterRole | null }> = [
  { label: 'Keine Report-Rolle', value: null },
  ...(Object.keys(METER_ROLE_LABELS) as MeterRole[]).map((value) => ({
    label: METER_ROLE_LABELS[value],
    value,
  })),
]

function typeLabel(t: MeterType) {
  return METER_TYPE_LABELS[t]
}
function typeIcon(t: MeterType) {
  return METER_TYPE_ICONS[t]
}
function roleLabel(role: MeterRole | null) {
  return role ? METER_ROLE_LABELS[role] : null
}
function fmt(value: number | null, decimals: number) {
  if (value === null) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
function fmtDateTime(iso: string | null) {
  if (!iso) return '–'
  return new Date(iso).toLocaleString('de-DE')
}
const isNarrowScreen = ref(false)
let narrowMedia: MediaQueryList | null = null
function updateNarrowScreen() {
  isNarrowScreen.value = narrowMedia?.matches ?? false
}
function fmtReportDate(iso: string | null) {
  if (!iso) return '–'
  const date = new Date(iso)
  if (isNarrowScreen.value) {
    return date.toLocaleDateString('de-DE', { month: '2-digit', year: '2-digit' })
  }
  return date.toLocaleString('de-DE')
}

async function loadGroups(): Promise<GroupSummary[]> {
  try {
    const res = await listGroups()
    return res.items
  } catch {
    return []
  }
}

const groupOptions = computed(() => [
  { label: 'Privat (nur ich)', value: null },
  ...groups.value.map((g) => ({ label: g.name, value: g.id })),
])

async function loadDetail() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await getMeter(meterId.value)
    await Promise.all([
      loadReadings(),
      loadReport(),
      canManage.value ? loadApiKeys() : Promise.resolve(),
    ])
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

// ── Reports ─────────────────────────────────────────────────────────────────

const report = ref<MeterReport | null>(null)
const loadingReport = ref(false)
const reportGranularity = ref<MeterReportGranularity>('month')
const reportGranularityOptions: Array<{ label: string; value: MeterReportGranularity }> = [
  { label: 'Monat', value: 'month' },
  { label: 'Jahr', value: 'year' },
]

const recentReportBuckets = computed(() => {
  const buckets = report.value?.buckets ?? []
  return reportGranularity.value === 'month' ? buckets.slice(-24) : buckets
})

const reportTableBuckets = computed(() => {
  if (reportGranularity.value !== 'year') return recentReportBuckets.value
  return [...recentReportBuckets.value].reverse()
})

type MeterReportBucket = MeterReport['buckets'][number]

function isCurrentReportPeriod(bucket: MeterReportBucket, granularity: MeterReportGranularity, now = new Date()) {
  if (granularity === 'year') return bucket.key === String(now.getFullYear())
  return bucket.key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function completedReportBuckets(buckets: MeterReportBucket[], granularity: MeterReportGranularity) {
  return buckets.filter((bucket) => !isCurrentReportPeriod(bucket, granularity))
}

function linearRegressionSlope(values: number[]): number | null {
  if (values.length < 3) return null
  const n = values.length
  const meanX = (n - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let denominator = 0
  values.forEach((value, index) => {
    const dx = index - meanX
    numerator += dx * (value - meanY)
    denominator += dx * dx
  })
  if (denominator === 0) return null
  return numerator / denominator
}

const reportAnalysis = computed(() => {
  const buckets = report.value?.buckets ?? []
  const completed = completedReportBuckets(buckets, reportGranularity.value)
  const trendSource = reportGranularity.value === 'month' ? completed.slice(-12) : completed
  const avg =
    completed.length > 0
      ? completed.reduce((sum, bucket) => sum + bucket.consumption, 0) / completed.length
      : null
  return {
    count: completed.length,
    trendPoints: trendSource.length,
    avgConsumption: avg,
    consumptionTrend: linearRegressionSlope(trendSource.map((bucket) => bucket.consumption)),
  }
})

function reportTrendLabel() {
  return reportGranularity.value === 'year' ? 'Trend/Jahr' : 'Trend/Monat'
}

function fmtReportTrend(value: number | null) {
  if (!detail.value) return 'Trend: –'
  if (value === null) return `${reportTrendLabel()}: –`
  const sign = value > 0 ? '+' : ''
  return `${reportTrendLabel()}: ${sign}${fmt(value, detail.value.decimals)} ${detail.value.unit}`
}

const reportChartData = computed(() => {
  if (!detail.value || recentReportBuckets.value.length === 0) return null
  return {
    labels: recentReportBuckets.value.map((bucket) => bucket.label),
    datasets: [
      {
        label: `${detail.value.name} (${detail.value.unit})`,
        data: recentReportBuckets.value.map((bucket) => bucket.consumption),
        backgroundColor: 'rgba(245, 158, 11, 0.55)',
        borderColor: 'rgb(217, 119, 6)',
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  }
})

const reportChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: (ctx: any) => `${fmt(Number(ctx.raw ?? 0), detail.value?.decimals ?? 1)} ${detail.value?.unit ?? ''}`,
      },
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      ticks: {
        callback: (value: number | string) => `${fmt(Number(value), detail.value?.decimals ?? 1)} ${detail.value?.unit ?? ''}`,
      },
    },
  },
}))

async function loadReport() {
  if (!detail.value) return
  loadingReport.value = true
  try {
    report.value = await getMeterReport(detail.value.id, reportGranularity.value)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Reports'
    report.value = null
  } finally {
    loadingReport.value = false
  }
}

watch(reportGranularity, () => {
  if (detail.value) void loadReport()
})

// ── Edit dialog ──────────────────────────────────────────────────────────────

interface EditForm {
  name: string
  type: MeterType
  role: MeterRole | null
  unit: string
  location: string
  notes: string
  decimals: number
  groupId: number | null
}

const showEdit = ref(false)
const saving = ref(false)
const editForm = ref<EditForm>({
  name: '',
  type: 'electricity',
  role: null,
  unit: '',
  location: '',
  notes: '',
  decimals: 1,
  groupId: null,
})

function openEdit() {
  if (!detail.value) return
  editForm.value = {
    name: detail.value.name,
    type: detail.value.type,
    role: detail.value.role,
    unit: detail.value.unit,
    location: detail.value.location ?? '',
    notes: detail.value.notes ?? '',
    decimals: detail.value.decimals,
    groupId: detail.value.groupId,
  }
  showEdit.value = true
}

async function handleSave() {
  if (!detail.value || !editForm.value.name.trim()) {
    error.value = 'Name darf nicht leer sein'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await updateMeter(detail.value.id, {
      name: editForm.value.name.trim(),
      type: editForm.value.type,
      role: editForm.value.role,
      unit: editForm.value.unit.trim(),
      location: editForm.value.location.trim() || undefined,
      notes: editForm.value.notes.trim() || undefined,
      decimals: editForm.value.decimals,
      groupId: editForm.value.groupId,
    })
    showEdit.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern'
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  if (!detail.value) return
  confirmDialog.require({
    message: `Zähler „${detail.value.name}“ mit allen Geräten und Ablesungen löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    header: 'Zähler löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performDeleteMeter(),
  })
}

async function performDeleteMeter() {
  if (!detail.value) return
  error.value = ''
  try {
    await deleteMeter(detail.value.id)
    router.push({ name: 'zaehler-list' })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── Device replace ───────────────────────────────────────────────────────────

const showReplace = ref(false)
const replacing = ref(false)
const replaceForm = ref({
  swapAt: new Date(),
  finalValue: 0,
  newSerial: '',
  newStartValue: 0,
})

function openReplace() {
  if (!detail.value) return
  const active = detail.value.devices.find((d) => d.active)
  replaceForm.value = {
    swapAt: new Date(),
    finalValue: active?.startValue ?? 0,
    newSerial: '',
    newStartValue: 0,
  }
  showReplace.value = true
}

async function handleReplace() {
  if (!detail.value) return
  replacing.value = true
  error.value = ''
  try {
    await replaceMeterDevice(detail.value.id, {
      swapAt: toLocalIsoDateTime(replaceForm.value.swapAt),
      finalValue: replaceForm.value.finalValue,
      newSerialNumber: replaceForm.value.newSerial.trim() || undefined,
      newStartValue: replaceForm.value.newStartValue,
    })
    showReplace.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Gerätewechsel'
  } finally {
    replacing.value = false
  }
}

const showDeviceEdit = ref(false)
const savingDevice = ref(false)
const deviceForm = ref<{
  id: number | null
  serialNumber: string
  installedAt: Date
  removedAt: Date | null
  startValue: number
  endValue: number | null
  notes: string
}>({
  id: null,
  serialNumber: '',
  installedAt: new Date(),
  removedAt: null,
  startValue: 0,
  endValue: null,
  notes: '',
})

function openDeviceEdit(device: MeterDevice) {
  deviceForm.value = {
    id: device.id,
    serialNumber: device.serialNumber ?? '',
    installedAt: new Date(device.installedAt),
    removedAt: device.removedAt ? new Date(device.removedAt) : null,
    startValue: device.startValue,
    endValue: device.endValue,
    notes: device.notes ?? '',
  }
  showDeviceEdit.value = true
}

async function handleSaveDevice() {
  const id = deviceForm.value.id
  if (id === null) return
  savingDevice.value = true
  error.value = ''
  try {
    await updateMeterDevice(id, {
      serialNumber: deviceForm.value.serialNumber.trim() || null,
      installedAt: toLocalIsoDateTime(deviceForm.value.installedAt),
      removedAt: deviceForm.value.removedAt ? toLocalIsoDateTime(deviceForm.value.removedAt) : null,
      startValue: deviceForm.value.startValue,
      endValue: deviceForm.value.endValue,
      notes: deviceForm.value.notes.trim() || null,
    })
    showDeviceEdit.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern des Geräts'
  } finally {
    savingDevice.value = false
  }
}

function handleDeleteDevice(device: MeterDevice) {
  confirmDialog.require({
    message: `Neuestes Gerät „${device.serialNumber ?? 'ohne Seriennummer'}“ löschen? Das ist nur möglich, solange keine Ablesungen dafür existieren.`,
    header: 'Gerät löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performDeleteDevice(device),
  })
}

async function performDeleteDevice(device: MeterDevice) {
  error.value = ''
  try {
    await deleteMeterDevice(device.id)
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Geräts'
  }
}

// ── Readings ─────────────────────────────────────────────────────────────────

const readings = ref<Reading[]>([])
const totalReadings = ref(0)
const readingsFirst = ref(0)
const readingsRows = 20
const loadingReadings = ref(false)

async function loadReadings(offset = 0) {
  if (!detail.value) return
  loadingReadings.value = true
  try {
    const res = await listReadings(detail.value.id, readingsRows, offset)
    readings.value = res.readings
    totalReadings.value = res.total
    readingsFirst.value = offset
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Ablesungen'
  } finally {
    loadingReadings.value = false
  }
}

function onReadingsPage(event: { first: number }) {
  loadReadings(event.first)
}

const showReading = ref(false)
const savingReading = ref(false)
const readingForm = ref<{ id: number | null; value: number; takenAt: Date; notes: string }>({
  id: null,
  value: 0,
  takenAt: new Date(),
  notes: '',
})

function canEditReading(r: Reading): boolean {
  if (canManage.value) return true
  return canEnter.value && r.enteredBy === (auth.user?.id ?? -1)
}

function openReadingEntry() {
  readingForm.value = { id: null, value: 0, takenAt: new Date(), notes: '' }
  showReading.value = true
}

function openReadingEdit(r: Reading) {
  readingForm.value = {
    id: r.id,
    value: r.value,
    takenAt: new Date(r.takenAt),
    notes: r.notes ?? '',
  }
  showReading.value = true
}

async function handleSaveReading() {
  if (!detail.value) return
  savingReading.value = true
  error.value = ''
  try {
    if (readingForm.value.id === null) {
      await addReading(detail.value.id, {
        value: readingForm.value.value,
        takenAt: toLocalIsoDateTime(readingForm.value.takenAt),
        notes: readingForm.value.notes.trim() || undefined,
      })
    } else {
      await updateReading(readingForm.value.id, {
        value: readingForm.value.value,
        takenAt: toLocalIsoDateTime(readingForm.value.takenAt),
        notes: readingForm.value.notes.trim() || undefined,
      })
    }
    showReading.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Ablesung'
  } finally {
    savingReading.value = false
  }
}

async function handleDeleteReading(r: Reading) {
  if (!confirm('Ablesung wirklich löschen?')) return
  error.value = ''
  try {
    await deleteReading(r.id)
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen der Ablesung'
  }
}

// ── OCR photo capture ────────────────────────────────────────────────────────

const ocrLoading = ref(false)
const ocrError = ref('')
const ocrFileInput = ref<HTMLInputElement | null>(null)

function triggerOcrUpload() {
  ocrFileInput.value?.click()
}

async function handleOcrFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !detail.value) return
  ocrLoading.value = true
  ocrError.value = ''
  try {
    const result = await ocrMeterReading(detail.value.id, file)
    if (result.value !== null) {
      readingForm.value.value = result.value
      readingForm.value.notes = `OCR (${Math.round(result.confidence * 100)}%)`
    } else {
      ocrError.value = 'Kein Zählerstand erkannt. Bitte manuell eingeben.'
    }
  } catch (err: any) {
    ocrError.value = err.message || 'OCR-Dienst nicht erreichbar'
  } finally {
    ocrLoading.value = false
    if (ocrFileInput.value) ocrFileInput.value.value = ''
  }
}

// ── API keys ─────────────────────────────────────────────────────────────────

const apiKeys = ref<ApiKey[]>([])
const loadingKeys = ref(false)
const showCreateKey = ref(false)
const creatingKey = ref(false)
const newKeyName = ref('')
const newKeyToken = ref('')

async function loadApiKeys() {
  if (!detail.value) return
  loadingKeys.value = true
  try {
    const res = await listApiKeys(detail.value.id)
    apiKeys.value = res.keys
  } catch {
    apiKeys.value = []
  } finally {
    loadingKeys.value = false
  }
}

function openCreateKey() {
  newKeyName.value = ''
  newKeyToken.value = ''
  showCreateKey.value = true
}

async function handleCreateKey() {
  if (!detail.value || !newKeyName.value.trim()) return
  creatingKey.value = true
  error.value = ''
  try {
    const result = await createApiKey(detail.value.id, newKeyName.value.trim())
    newKeyToken.value = result.token
    await loadApiKeys()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des API-Keys'
  } finally {
    creatingKey.value = false
  }
}

async function handleDeleteKey(key: ApiKey) {
  if (!confirm(`API-Key „${key.name}“ wirklich löschen?`)) return
  error.value = ''
  try {
    await deleteApiKey(key.id)
    await loadApiKeys()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des API-Keys'
  }
}

function copyToken() {
  if (newKeyToken.value) navigator.clipboard.writeText(newKeyToken.value)
}

onMounted(async () => {
  narrowMedia = window.matchMedia('(max-width: 560px)')
  updateNarrowScreen()
  narrowMedia.addEventListener('change', updateNarrowScreen)
  groups.value = await loadGroups()
  await loadDetail()
})

onUnmounted(() => {
  narrowMedia?.removeEventListener('change', updateNarrowScreen)
})

watch(meterId, () => loadDetail())
</script>

<template>
  <div class="meter-detail-view">
    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Wird geladen…</div>
    <template v-else-if="detail">
      <!-- Header -->
      <div class="detail-top">
        <Button class="back-button" icon="pi pi-arrow-left" text rounded severity="secondary" @click="router.push({ name: 'zaehler-list' })" v-tooltip.right="'Zurück'" />
        <div class="detail-top-actions">
          <Button v-if="canEnter" label="Neue Ablesung" icon="pi pi-plus" size="small" @click="openReadingEntry" />
          <Button v-if="canManage" icon="pi pi-pencil" text rounded severity="secondary" v-tooltip.top="'Bearbeiten'" @click="openEdit" />
          <Button v-if="canManage" icon="pi pi-trash" text rounded severity="danger" v-tooltip.top="'Löschen'" @click="handleDelete" />
        </div>
        <div class="detail-title">
          <h1><i :class="typeIcon(detail.type)" /> <span class="meter-name">{{ detail.name }}</span></h1>
          <div class="detail-subtitle">
            <Tag :value="typeLabel(detail.type)" severity="secondary" />
            <Tag v-if="detail.role" :value="roleLabel(detail.role)" severity="info" />
            <span v-if="detail.location"><i class="pi pi-map-marker" /> {{ detail.location }}</span>
          </div>
        </div>
      </div>

      <!-- Figures -->
      <div class="figures-bar">
        <div class="figure">
          <span class="figure-label">Letzter Stand</span>
          <span class="figure-value">{{ fmt(detail.lastReadingValue, detail.decimals) }} {{ detail.unit }}</span>
          <span class="figure-sub">{{ fmtDateTime(detail.lastReadingAt) }}</span>
        </div>
        <div class="figure">
          <span class="figure-label">Gesamt (absolut)</span>
          <span class="figure-value">{{ fmt(detail.absoluteTotal, detail.decimals) }} {{ detail.unit }}</span>
        </div>
        <div class="figure">
          <span class="figure-label">Aktives Gerät</span>
          <span class="figure-value figure-value--wrap">{{ detail.activeDeviceSerial ?? '–' }}</span>
        </div>
      </div>

      <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>

      <!-- Report -->
      <div class="section-header">
        <h2><i class="pi pi-chart-bar" /> Verbrauch</h2>
        <SelectButton
          v-model="reportGranularity"
          :options="reportGranularityOptions"
          option-label="label"
          option-value="value"
          size="small"
          :allow-empty="false"
        />
      </div>
      <div v-if="loadingReport" class="info"><i class="pi pi-spin pi-spinner" /> Report…</div>
      <div v-else-if="!report || report.buckets.length === 0" class="info">Noch nicht genug Ablesungen für einen Verbrauchsreport.</div>
      <div v-else class="report-panel">
        <div class="report-summary">
          <span class="figure-label">Ø Verbrauch</span>
          <strong>{{ fmt(reportAnalysis.avgConsumption, detail.decimals) }} {{ detail.unit }}</strong>
          <span class="figure-sub">{{ fmtReportTrend(reportAnalysis.consumptionTrend) }}</span>
          <span class="figure-sub">Basis: {{ reportAnalysis.count }} abgeschlossene {{ reportGranularity === 'month' ? 'Monate' : 'Jahre' }}, Trend: {{ reportAnalysis.trendPoints }} Werte</span>
        </div>
        <div v-if="reportChartData" class="report-chart">
          <Chart type="bar" :data="reportChartData" :options="reportChartOptions" />
        </div>
        <DataTable :value="reportTableBuckets" size="small" class="report-table">
          <Column field="label" :header="reportGranularity === 'month' ? 'Monat' : 'Jahr'" />
          <Column header="Verbrauch">
            <template #body="{ data }">{{ fmt(data.consumption, detail!.decimals) }} {{ detail!.unit }}</template>
          </Column>
          <Column header="Von">
            <template #body="{ data }">{{ fmtReportDate(data.startReadingAt) }}</template>
          </Column>
          <Column header="Bis">
            <template #body="{ data }">{{ fmtReportDate(data.endReadingAt) }}</template>
          </Column>
        </DataTable>
      </div>

      <!-- Device history -->
      <div class="section-header">
        <h2><i class="pi pi-cog" /> Gerätehistorie</h2>
        <Button v-if="canManage" label="Gerät ersetzen" icon="pi pi-refresh" size="small" @click="openReplace" />
      </div>
      <DataTable :value="detail.devices" size="small" class="device-table">
        <Column field="serialNumber" header="Seriennummer">
          <template #body="{ data }">{{ data.serialNumber ?? '–' }}</template>
        </Column>
        <Column header="Von">
          <template #body="{ data }">{{ fmtDateTime(data.installedAt) }}</template>
        </Column>
        <Column header="Bis">
          <template #body="{ data }">{{ data.removedAt ? fmtDateTime(data.removedAt) : 'aktiv' }}</template>
        </Column>
        <Column header="Startwert">
          <template #body="{ data }">{{ fmt(data.startValue, detail!.decimals) }}</template>
        </Column>
        <Column header="Endwert">
          <template #body="{ data }">{{ data.endValue === null ? '–' : fmt(data.endValue, detail!.decimals) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :value="data.active ? 'aktiv' : 'ersetzt'" :severity="data.active ? 'success' : 'secondary'" />
          </template>
        </Column>
        <Column v-if="canManage" style="width: 6.5rem">
          <template #body="{ data }">
            <div class="device-actions">
              <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" v-tooltip.left="'Gerät bearbeiten'" @click="openDeviceEdit(data)" />
              <Button
                icon="pi pi-trash"
                text
                rounded
                size="small"
                severity="danger"
                :disabled="!data.canDelete"
                v-tooltip.left="data.canDelete ? 'Neuestes Gerät löschen' : 'Nur neuestes Gerät ohne Ablesungen löschbar'"
                @click="handleDeleteDevice(data)"
              />
            </div>
          </template>
        </Column>
      </DataTable>

      <!-- Readings -->
      <div class="section-header">
        <h2><i class="pi pi-list" /> Ablesungen</h2>
        <Button v-if="canEnter" label="Neue Ablesung" icon="pi pi-plus" size="small" @click="openReadingEntry" />
      </div>
      <div v-if="loadingReadings" class="info"><i class="pi pi-spin pi-spinner" /> Ablesungen…</div>
      <div v-else-if="readings.length === 0" class="info">Noch keine Ablesungen erfasst.</div>
      <DataTable v-else :value="readings" size="small" class="readings-table" lazy paginator :rows="readingsRows" :total-records="totalReadings" :first="readingsFirst" @page="onReadingsPage">
        <Column header="Datum">
          <template #body="{ data }">{{ fmtDateTime(data.takenAt) }}</template>
        </Column>
        <Column header="Wert">
          <template #body="{ data }">{{ fmt(data.value, detail!.decimals) }} {{ detail!.unit }}</template>
        </Column>
        <Column header="Absolut">
          <template #body="{ data }">{{ fmt(data.absoluteValue, detail!.decimals) }} {{ detail!.unit }}</template>
        </Column>
        <Column header="Quelle">
          <template #body="{ data }">
            <Tag :value="data.source" severity="secondary" />
          </template>
        </Column>
        <Column field="notes" header="Notiz">
          <template #body="{ data }"><span class="notes-cell" :title="data.notes ?? ''">{{ data.notes ?? '' }}</span></template>
        </Column>
        <Column style="width: 6rem">
          <template #body="{ data }">
            <div class="reading-actions" v-if="canEditReading(data)">
              <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" v-tooltip.left="'Bearbeiten'" @click="openReadingEdit(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip.left="'Löschen'" @click="handleDeleteReading(data)" />
            </div>
          </template>
        </Column>
      </DataTable>

      <!-- API keys -->
      <template v-if="canManage">
        <div class="section-header">
          <h2><i class="pi pi-key" /> API-Keys</h2>
          <Button label="Neuer Key" icon="pi pi-plus" size="small" @click="openCreateKey" />
        </div>
        <div v-if="loadingKeys" class="info"><i class="pi pi-spin pi-spinner" /> Keys…</div>
        <div v-else-if="apiKeys.length === 0" class="info">Keine API-Keys vorhanden.</div>
        <DataTable v-else :value="apiKeys" size="small" class="keys-table">
          <Column field="name" header="Name" />
          <Column header="Erstellt">
            <template #body="{ data }">{{ fmtDateTime(data.createdAt) }}</template>
          </Column>
          <Column header="Zuletzt genutzt">
            <template #body="{ data }">{{ data.lastUsedAt ? fmtDateTime(data.lastUsedAt) : 'nie' }}</template>
          </Column>
          <Column header="Status">
            <template #body="{ data }">
              <Tag :value="data.disabledAt ? 'deaktiviert' : 'aktiv'" :severity="data.disabledAt ? 'danger' : 'success'" />
            </template>
          </Column>
          <Column style="width: 4rem">
            <template #body="{ data }">
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip.left="'Löschen'" @click="handleDeleteKey(data)" />
            </template>
          </Column>
        </DataTable>
      </template>
    </template>
    <div v-else class="info">Zähler nicht gefunden.</div>

    <!-- Edit dialog -->
    <Dialog v-model:visible="showEdit" header="Zähler bearbeiten" modal :style="{ width: '32rem', maxWidth: '95vw' }">
      <div class="form-grid">
        <label>Name
          <InputText v-model="editForm.name" autofocus />
        </label>
        <label>Typ
          <Select v-model="editForm.type" :options="typeOptions" option-label="label" option-value="value" />
        </label>
        <label>Report-Rolle
          <Select v-model="editForm.role" :options="roleOptions" option-label="label" option-value="value" />
        </label>
        <label>Einheit
          <InputText v-model="editForm.unit" />
        </label>
        <label>Standort
          <InputText v-model="editForm.location" />
        </label>
        <label>Nachkommastellen
          <InputNumber v-model="editForm.decimals" :min="0" :max="3" show-buttons />
        </label>
        <label>Sichtbarkeit
          <Select v-model="editForm.groupId" :options="groupOptions" option-label="label" option-value="value" />
        </label>
        <label class="full">Notizen
          <Textarea v-model="editForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showEdit = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="handleSave" />
      </template>
    </Dialog>

    <!-- Replace device dialog -->
    <Dialog v-model:visible="showReplace" header="Gerät ersetzen" modal :style="{ width: '30rem', maxWidth: '95vw' }">
      <p class="hint">
        Das aktuelle Gerät wird mit dem Endstand abgeschlossen; das neue Gerät startet
        beim angegebenen Wert. Der absolute Gesamtstand bleibt dadurch fortlaufend.
      </p>
      <div class="form-grid">
        <label>Wechsel am
          <DatePicker v-model="replaceForm.swapAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Endstand altes Gerät
          <InputNumber v-model="replaceForm.finalValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
        <label>Seriennummer neu
          <InputText v-model="replaceForm.newSerial" />
        </label>
        <label>Startwert neu
          <InputNumber v-model="replaceForm.newStartValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showReplace = false" />
        <Button label="Ersetzen" icon="pi pi-refresh" :loading="replacing" @click="handleReplace" />
      </template>
    </Dialog>

    <!-- Edit device dialog -->
    <Dialog v-model:visible="showDeviceEdit" header="Gerät bearbeiten" modal :style="{ width: '30rem', maxWidth: '95vw' }">
      <div class="form-grid">
        <label>Seriennummer
          <InputText v-model="deviceForm.serialNumber" autofocus />
        </label>
        <label>Eingebaut am
          <DatePicker v-model="deviceForm.installedAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Startwert
          <InputNumber v-model="deviceForm.startValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
        <label>Ausgebaut am
          <DatePicker v-model="deviceForm.removedAt" show-time hour-format="24" date-format="dd.mm.yy" show-button-bar />
        </label>
        <label>Endwert
          <InputNumber v-model="deviceForm.endValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
        <label class="full">Notiz
          <Textarea v-model="deviceForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showDeviceEdit = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="savingDevice" @click="handleSaveDevice" />
      </template>
    </Dialog>

    <!-- Reading entry / edit dialog -->
    <Dialog
      v-model:visible="showReading"
      :header="readingForm.id === null ? 'Neue Ablesung' : 'Ablesung bearbeiten'"
      modal
      :style="{ width: '26rem', maxWidth: '95vw' }"
    >
      <div class="form-grid form-grid--stack">
        <label>Zeitpunkt
          <DatePicker v-model="readingForm.takenAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Zählerstand
          <div class="ocr-row">
            <InputNumber v-model="readingForm.value" :min-fraction-digits="0" :max-fraction-digits="3" autofocus class="ocr-input" />
            <Button
              v-if="readingForm.id === null"
              icon="pi pi-camera"
              severity="secondary"
              v-tooltip.top="'Foto-Erkennung'"
              :loading="ocrLoading"
              @click="triggerOcrUpload"
            />
          </div>
        </label>
        <Message v-if="ocrError" severity="warn" :closable="false" class="ocr-msg">{{ ocrError }}</Message>
        <label>Notiz
          <Textarea v-model="readingForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <input ref="ocrFileInput" type="file" accept="image/*" capture="environment" style="display:none" @change="handleOcrFile" />
      <template #footer>
        <Button label="Abbrechen" text @click="showReading = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="savingReading" @click="handleSaveReading" />
      </template>
    </Dialog>

    <!-- Create API key dialog -->
    <Dialog v-model:visible="showCreateKey" header="Neuer API-Key" modal :style="{ width: '28rem', maxWidth: '95vw' }">
      <template v-if="!newKeyToken">
        <div class="form-grid form-grid--stack">
          <label>Bezeichnung
            <InputText v-model="newKeyName" autofocus placeholder="z.B. Shelly EM" />
          </label>
        </div>
      </template>
      <template v-else>
        <p class="hint">Der Token wird nur einmal angezeigt. Jetzt kopieren!</p>
        <div class="token-display">
          <code>{{ newKeyToken }}</code>
          <Button icon="pi pi-copy" text rounded severity="secondary" v-tooltip.top="'Kopieren'" @click="copyToken" />
        </div>
      </template>
      <template #footer>
        <template v-if="!newKeyToken">
          <Button label="Abbrechen" text @click="showCreateKey = false" />
          <Button label="Erstellen" icon="pi pi-plus" :loading="creatingKey" :disabled="!newKeyName.trim()" @click="handleCreateKey" />
        </template>
        <template v-else>
          <Button label="Schließen" @click="showCreateKey = false" />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.meter-detail-view {
  padding: 1rem;
  max-width: 1100px;
  margin: 0 auto;
  overflow-x: clip;
}
.info {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.detail-top {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.detail-title {
  flex: 1 1 16rem;
  min-width: 0;
  margin-left: auto;
  text-align: right;
}
.detail-title h1 {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  font-size: 1.4rem;
  line-height: 1.2;
}
.detail-title h1 i {
  flex: 0 0 auto;
}
.meter-name {
  min-width: 0;
  overflow-wrap: break-word;
  word-break: normal;
}
.detail-subtitle {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.25rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  flex-wrap: wrap;
}
.detail-subtitle i {
  margin-right: 0.2rem;
}
.detail-top-actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}
.figures-bar {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  flex-wrap: wrap;
}
.figure {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 120px;
}
.figure-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.figure-value {
  font-weight: 600;
  font-size: 1.1rem;
}
.figure-value--wrap {
  overflow-wrap: anywhere;
}
.figure-sub {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 1.5rem 0 0.75rem;
}
.section-header h2 {
  margin: 0;
  font-size: 1.15rem;
}
.section-header h2 i {
  margin-right: 0.4rem;
}
.report-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1rem;
}
.report-summary {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.report-summary strong {
  font-size: 1.1rem;
}
.report-chart {
  height: 260px;
  min-width: 0;
}
.report-table {
  margin-top: 1rem;
}
.meter-detail-view :deep(.p-datatable) {
  max-width: 100%;
}
/* Narrow screens: scroll the table horizontally instead of squeezing every
   column until headers overlap and values break apart character by character. */
.meter-detail-view :deep(.p-datatable-table-container) {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.meter-detail-view :deep(.p-datatable-table) {
  width: 100%;
  table-layout: auto;
}
.meter-detail-view :deep(.p-datatable-thead > tr > th),
.meter-detail-view :deep(.p-datatable-tbody > tr > td) {
  white-space: nowrap;
}
.report-table :deep(.p-datatable-table) {
  min-width: 26rem;
}
.device-table :deep(.p-datatable-table) {
  min-width: 44rem;
}
.readings-table :deep(.p-datatable-table) {
  min-width: 40rem;
}
.keys-table :deep(.p-datatable-table) {
  min-width: 34rem;
}
.notes-cell {
  display: inline-block;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
@media (max-width: 560px) {
  .detail-title {
    flex-basis: 100%;
    margin-left: 0;
    text-align: left;
  }
  .detail-title h1,
  .detail-subtitle {
    justify-content: flex-start;
  }
  .detail-top-actions :deep(.p-button-label) {
    display: none;
  }
  .section-header {
    align-items: flex-start;
    gap: 0.75rem;
    flex-direction: column;
  }
  .report-panel {
    padding: 0.75rem;
  }
  .report-chart {
    height: 220px;
  }
}
.reading-actions {
  display: flex;
  gap: 0.15rem;
  justify-content: flex-end;
}
.device-actions {
  display: flex;
  gap: 0.15rem;
  justify-content: flex-end;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
@media (max-width: 480px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
.form-grid--stack {
  grid-template-columns: 1fr;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  min-width: 0;
}
.form-grid label.full {
  grid-column: 1 / -1;
}
.form-grid label > :deep(.p-inputtext),
.form-grid label > :deep(.p-select),
.form-grid label > :deep(.p-datepicker),
.form-grid label > :deep(.p-inputnumber),
.form-grid label > :deep(.p-textarea) {
  width: 100%;
}
.form-grid :deep(.p-inputnumber-input),
.form-grid :deep(.p-datepicker-input) {
  width: 100%;
}
.hint {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  margin: 0 0 0.75rem;
}
.ocr-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.ocr-input {
  flex: 1;
  min-width: 0;
}
.ocr-msg {
  margin: 0;
}
.token-display {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  word-break: break-all;
}
.token-display code {
  flex: 1;
  font-size: 0.8rem;
}
</style>
