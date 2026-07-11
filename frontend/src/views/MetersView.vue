<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import SelectButton from 'primevue/selectbutton'
import { useConfirm } from 'primevue/useconfirm'
import {
  listMeters,
  createMeter,
  updateMeter,
  deleteMeter,
  getEnergyReport,
  listElectricityTariffs,
  createElectricityTariff,
  updateElectricityTariff,
  deleteElectricityTariff,
  importWaterHistory,
  importElectricityHistory,
  importElectricityPrices,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  METER_ROLE_LABELS,
  ELECTRICITY_TARIFF_KIND_LABELS,
  ELECTRICITY_TARIFF_UNIT_LABELS,
  type EnergyReport,
  type ElectricityTariff,
  type ElectricityTariffKind,
  type ElectricityTariffUnit,
  type MeterReportGranularity,
  type MeterListItem,
  type MeterRole,
  type MeterType,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'

const router = useRouter()
const auth = useAuthStore()
const confirm = useConfirm()
const canManage = computed(() => auth.hasPermission('meters.manage'))

const meters = ref<MeterListItem[]>([])
const groups = ref<GroupSummary[]>([])
const energyReport = ref<EnergyReport | null>(null)
const energyMonthlyReport = ref<EnergyReport | null>(null)
const energyGranularity = ref<MeterReportGranularity>('month')
const loadingEnergyReport = ref(false)
const loading = ref(false)
const error = ref('')

const energyGranularityOptions: Array<{ label: string; value: MeterReportGranularity }> = [
  { label: 'Monat', value: 'month' },
  { label: 'Jahr', value: 'year' },
]

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

const DEFAULT_UNIT: Record<MeterType, string> = {
  electricity: 'kWh',
  water: 'm³',
  gas: 'm³',
  operating_hours: 'h',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [mRes, gRes] = await Promise.all([listMeters(), loadGroups()])
    meters.value = mRes.meters
    groups.value = gRes
    await loadEnergyReport()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Zähler'
  } finally {
    loading.value = false
  }
}

async function loadEnergyReport() {
  loadingEnergyReport.value = true
  try {
    if (energyGranularity.value === 'year') {
      const [selected, monthly] = await Promise.all([
        getEnergyReport('year'),
        getEnergyReport('month'),
      ])
      energyReport.value = selected
      energyMonthlyReport.value = monthly
    } else {
      const selected = await getEnergyReport('month')
      energyReport.value = selected
      energyMonthlyReport.value = selected
    }
  } catch {
    energyReport.value = null
    energyMonthlyReport.value = null
  } finally {
    loadingEnergyReport.value = false
  }
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
function fmtPercent(value: number | null) {
  if (value === null) return '–'
  return value.toLocaleString('de-DE', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })
}

const energyBuckets = computed(() => {
  const buckets = energyReport.value?.buckets ?? []
  const recent = energyGranularity.value === 'month' ? buckets.slice(-12) : buckets
  return energyGranularity.value === 'year' ? [...recent].reverse() : recent
})

type EnergyBucket = EnergyReport['buckets'][number]

function isCurrentPeriod(bucket: EnergyBucket, granularity: MeterReportGranularity, now = new Date()) {
  if (granularity === 'year') {
    return bucket.key === String(now.getFullYear())
  }
  return bucket.key === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function completedBuckets(buckets: EnergyBucket[], granularity: MeterReportGranularity) {
  return buckets.filter((bucket) => !isCurrentPeriod(bucket, granularity))
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

function trendLabel() {
  if (energyGranularity.value === 'year') return 'Trend/Jahr'
  return 'Trend/Monat'
}

const energyAnalysis = computed(() => {
  const buckets = energyReport.value?.buckets ?? []
  const completed = completedBuckets(buckets, energyGranularity.value)
  const trendSource = energyGranularity.value === 'month' ? completed.slice(-12) : completed
  const avg = (selector: (bucket: EnergyBucket) => number | null) => {
    const values = completed.map(selector).filter((value): value is number => value !== null)
    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const trend = (selector: (bucket: EnergyBucket) => number | null) => {
    const values = trendSource.map(selector).filter((value): value is number => value !== null)
    return linearRegressionSlope(values)
  }
  return {
    count: completed.length,
    trendPoints: trendSource.length,
    avgGridImport: avg((bucket) => bucket.gridImport),
    avgGridExport: avg((bucket) => bucket.gridExport),
    avgProduction: avg((bucket) => bucket.production),
    avgSelfConsumption: avg((bucket) => bucket.selfConsumption),
    avgAutarky: avg((bucket) => bucket.autarky),
    avgSelfConsumptionRate: avg((bucket) => bucket.selfConsumptionRate),
    avgHeatPumpTotal: avg((bucket) => bucket.heatPumpTotal),
    avgConsumptionWithoutHeatPumpAndEv: avg((bucket) => bucket.consumptionWithoutHeatPumpAndEv),
    avgHeatHeatingTotal: avg((bucket) => bucket.heatHeatingTotal),
    avgHeatHeatingPvShare: avg((bucket) => bucket.heatHeatingPvShare),
    avgHotWaterTotal: avg((bucket) => bucket.hotWaterTotal),
    avgHotWaterPvShare: avg((bucket) => bucket.hotWaterPvShare),
    avgEvChargerTotal: avg((bucket) => bucket.evChargerTotal),
    avgEvChargerPvShare: avg((bucket) => bucket.evChargerPvShare),
    trendGridImport: trend((bucket) => bucket.gridImport),
    trendAutarky: trend((bucket) => bucket.autarky),
  }
})

const hasHeatPumpBreakdown = computed(() =>
  (energyReport.value?.buckets ?? []).some(
    (bucket) =>
      bucket.heatPumpTotal !== null ||
      bucket.consumptionWithoutHeatPumpAndEv !== null ||
      bucket.heatHeatingTotal !== null ||
      bucket.heatHeatingPvShare !== null ||
      bucket.hotWaterTotal !== null ||
      bucket.hotWaterPvShare !== null ||
      bucket.evChargerTotal !== null ||
      bucket.evChargerPvShare !== null,
  ),
)

const energyVisibleRangeLabel = computed(() => {
  const buckets = energyBuckets.value
  if (buckets.length === 0) return 'angezeigter Zeitraum'
  const sorted = [...buckets].sort((a, b) => a.key.localeCompare(b.key))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return 'angezeigter Zeitraum'
  if (first.key === last.key) return first.label
  return `${first.label}–${last.label}`
})

const energyCostScopeLabel = computed(
  () => `Summe im angezeigten Zeitraum ${energyVisibleRangeLabel.value}`,
)

const energyYtdComparison = computed(() => {
  if (energyGranularity.value !== 'year') return null
  const buckets = energyMonthlyReport.value?.buckets ?? []
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  const completedMonthLimit = currentMonth - 1
  if (completedMonthLimit <= 0) return null

  const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  const currentBuckets: EnergyBucket[] = []
  const previousBuckets: EnergyBucket[] = []
  for (let month = 1; month <= completedMonthLimit; month++) {
    const current = byKey.get(monthKey(currentYear, month))
    const previous = byKey.get(monthKey(currentYear - 1, month))
    if (!current || !previous) return null
    currentBuckets.push(current)
    previousBuckets.push(previous)
  }

  const sum = (source: EnergyBucket[], selector: (bucket: EnergyBucket) => number | null) => {
    const values = source.map(selector).filter((value): value is number => value !== null)
    if (values.length !== source.length) return null
    return values.reduce((total, value) => total + value, 0)
  }
  const ratioAvg = (source: EnergyBucket[], selector: (bucket: EnergyBucket) => number | null) => {
    const values = source.map(selector).filter((value): value is number => value !== null)
    if (values.length !== source.length || values.length === 0) return null
    return values.reduce((total, value) => total + value, 0) / values.length
  }
  const currentImport = sum(currentBuckets, (bucket) => bucket.gridImport)
  const previousImport = sum(previousBuckets, (bucket) => bucket.gridImport)
  const currentAutarky = ratioAvg(currentBuckets, (bucket) => bucket.autarky)
  const previousAutarky = ratioAvg(previousBuckets, (bucket) => bucket.autarky)

  return {
    label: `Jan–${String(completedMonthLimit).padStart(2, '0')}`,
    gridImportDelta:
      currentImport !== null && previousImport !== null ? currentImport - previousImport : null,
    autarkyDelta:
      currentAutarky !== null && previousAutarky !== null ? currentAutarky - previousAutarky : null,
  }
})

function fmtTrend(value: number | null, decimals: number, unit = '') {
  if (value === null) return `${trendLabel()}: –`
  const sign = value > 0 ? '+' : ''
  return `${trendLabel()}: ${sign}${fmt(value, decimals)}${unit ? ` ${unit}` : ''}`
}
function fmtPercentTrend(value: number | null) {
  if (value === null) return `${trendLabel()}: –`
  const sign = value > 0 ? '+' : ''
  return `${trendLabel()}: ${sign}${(value * 100).toLocaleString('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })} Prozentpunkte`
}

function openDetail(m: MeterListItem) {
  router.push({ name: 'zaehler-detail', params: { id: m.id } })
}

const showEnergyHelp = ref(false)

// ── Create / edit dialog ─────────────────────────────────────────────────────

interface MeterForm {
  id: number | null
  name: string
  type: MeterType
  role: MeterRole | null
  unit: string
  location: string
  notes: string
  decimals: number
  groupId: number | null
  deviceSerial: string
  deviceInstalledAt: Date
  deviceStartValue: number
}

const showForm = ref(false)
const saving = ref(false)
const form = ref<MeterForm>(emptyForm())

function emptyForm(): MeterForm {
  return {
    id: null,
    name: '',
    type: 'electricity',
    role: null,
    unit: DEFAULT_UNIT.electricity,
    location: '',
    notes: '',
    decimals: 1,
    groupId: null,
    deviceSerial: '',
    deviceInstalledAt: new Date(),
    deviceStartValue: 0,
  }
}

function openCreate() {
  form.value = emptyForm()
  showForm.value = true
}

function openEdit(m: MeterListItem) {
  form.value = {
    id: m.id,
    name: m.name,
    type: m.type,
    role: m.role,
    unit: m.unit,
    location: m.location ?? '',
    notes: m.notes ?? '',
    decimals: m.decimals,
    groupId: m.groupId,
    deviceSerial: '',
    deviceInstalledAt: new Date(),
    deviceStartValue: 0,
  }
  showForm.value = true
}

function onTypeChange() {
  if (form.value.id === null) {
    form.value.unit = DEFAULT_UNIT[form.value.type]
  }
}

async function handleSave() {
  if (!form.value.name.trim()) {
    error.value = 'Name darf nicht leer sein'
    return
  }
  saving.value = true
  error.value = ''
  try {
    if (form.value.id === null) {
      await createMeter({
        name: form.value.name.trim(),
        type: form.value.type,
        role: form.value.role,
        unit: form.value.unit.trim(),
        location: form.value.location.trim() || undefined,
        notes: form.value.notes.trim() || undefined,
        decimals: form.value.decimals,
        groupId: form.value.groupId,
        device: {
          serialNumber: form.value.deviceSerial.trim() || undefined,
          installedAt: toLocalIsoDateTime(form.value.deviceInstalledAt),
          startValue: form.value.deviceStartValue,
        },
      })
    } else {
      await updateMeter(form.value.id, {
        name: form.value.name.trim(),
        type: form.value.type,
        role: form.value.role,
        unit: form.value.unit.trim(),
        location: form.value.location.trim() || undefined,
        notes: form.value.notes.trim() || undefined,
        decimals: form.value.decimals,
        groupId: form.value.groupId,
      })
    }
    showForm.value = false
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern'
  } finally {
    saving.value = false
  }
}

async function handleDelete(m: MeterListItem) {
  confirm.require({
    message: `Zähler „${m.name}“ mit allen Geräten und Ablesungen löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    header: 'Zähler löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performDelete(m),
  })
}

async function performDelete(m: MeterListItem) {
  error.value = ''
  try {
    await deleteMeter(m.id)
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── History imports ─────────────────────────────────────────────────────────

const importingWater = ref(false)
const importingElec = ref(false)
const importingPrices = ref(false)
const importMsg = ref('')

const showWaterImport = computed(
  () => canManage.value && !meters.value.some((m) => m.type === 'water' && m.name === 'Wasser'),
)
const showElecImport = computed(
  () => canManage.value && !meters.value.some((m) => m.type === 'electricity' && m.name === 'Netzstrom Bezug (1.8.0)'),
)

async function handleImportWater() {
  importingWater.value = true
  error.value = ''
  importMsg.value = ''
  try {
    const res = await importWaterHistory()
    if (res.alreadyImported) {
      importMsg.value = 'Wasser-Historie war bereits importiert.'
    } else {
      importMsg.value = `Wasser-Import: ${res.devices} Geräte, ${res.readings} Ablesungen.`
    }
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Import'
  } finally {
    importingWater.value = false
  }
}

async function handleImportElec() {
  importingElec.value = true
  error.value = ''
  importMsg.value = ''
  try {
    const res = await importElectricityHistory()
    if (res.alreadyImported) {
      importMsg.value = 'Strom-Historie war bereits importiert.'
    } else {
      importMsg.value = `Strom-Import: ${res.metersCreated} Zähler, ${res.devicesCreated} Geräte, ${res.readingsCreated} Ablesungen.`
    }
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Import'
  } finally {
    importingElec.value = false
  }
}

// ── Electricity prices / tariffs ───────────────────────────────────────────

interface TariffForm {
  id: number | null
  kind: ElectricityTariffKind
  validFrom: Date
  amount: number
  unit: ElectricityTariffUnit
  taxStatus: string
  name: string
  capacityLimitKw: number | null
}

const showTariffs = ref(false)
const loadingTariffs = ref(false)
const savingTariff = ref(false)
const tariffs = ref<ElectricityTariff[]>([])
const tariffForm = ref<TariffForm>(emptyTariffForm())
const tariffFormEl = ref<HTMLElement | null>(null)

const tariffKindOptions = (Object.keys(ELECTRICITY_TARIFF_KIND_LABELS) as ElectricityTariffKind[]).map((value) => ({
  label: ELECTRICITY_TARIFF_KIND_LABELS[value],
  value,
}))
const tariffUnitOptions = (Object.keys(ELECTRICITY_TARIFF_UNIT_LABELS) as ElectricityTariffUnit[]).map((value) => ({
  label: ELECTRICITY_TARIFF_UNIT_LABELS[value],
  value,
}))

const visibleTariffs = computed(() =>
  tariffs.value
    .filter((tariff) =>
      ['grid_import', 'base_price', 'feed_in', 'self_consumption_value'].includes(tariff.kind),
    )
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom) || tariffKindLabel(a.kind).localeCompare(tariffKindLabel(b.kind), 'de')),
)

const tariffImportKinds: ElectricityTariffKind[] = [
  'grid_import',
  'base_price',
  'feed_in',
  'self_consumption_value',
  'pv_investment_net',
  'pv_investment_vat',
  'opportunity_cost_year',
  'opportunity_cost_total',
  'amortization_years',
]

const pricesAlreadyImported = computed(() =>
  tariffImportKinds.every((kind) => tariffs.value.some((tariff) => tariff.kind === kind)),
)

function emptyTariffForm(): TariffForm {
  return {
    id: null,
    kind: 'grid_import',
    validFrom: new Date(),
    amount: 0,
    unit: 'eur_per_kwh',
    taxStatus: 'gross',
    name: '',
    capacityLimitKw: null,
  }
}

function tariffKindLabel(kind: ElectricityTariffKind) {
  return ELECTRICITY_TARIFF_KIND_LABELS[kind]
}

function tariffUnitLabel(unit: ElectricityTariffUnit) {
  return ELECTRICITY_TARIFF_UNIT_LABELS[unit]
}

function fmtDate(iso: string | null) {
  if (!iso) return '–'
  return new Date(iso).toLocaleDateString('de-DE')
}

function fmtCurrency(value: number | null) {
  if (value === null) return '–'
  return value.toLocaleString('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtTariffAmount(tariff: ElectricityTariff) {
  return `${tariff.amount.toLocaleString('de-DE', {
    minimumFractionDigits: tariff.unit === 'eur' ? 2 : 4,
    maximumFractionDigits: tariff.unit === 'eur' ? 2 : 6,
  })} ${tariffUnitLabel(tariff.unit)}`
}

function tariffTaxStatusLabel(status: string | null) {
  if (!status) return '–'
  const labels: Record<string, string> = {
    gross: 'incl. MwSt.',
    net: 'excl. MwSt.',
    assumed_net_plus_vat: 'angenommen excl. MwSt. zzgl. MwSt.',
  }
  return labels[status] ?? status
}

function onTariffKindChange() {
  if (tariffForm.value.kind === 'base_price') tariffForm.value.unit = 'eur_per_month'
  else if (tariffForm.value.kind === 'pv_investment_net' || tariffForm.value.kind === 'pv_investment_vat') tariffForm.value.unit = 'eur'
  else if (tariffForm.value.kind === 'amortization_years') tariffForm.value.unit = 'years'
  else tariffForm.value.unit = 'eur_per_kwh'
}

async function openTariffs() {
  showTariffs.value = true
  tariffForm.value = emptyTariffForm()
  await loadTariffs()
}

async function loadTariffs() {
  loadingTariffs.value = true
  error.value = ''
  try {
    const res = await listElectricityTariffs()
    tariffs.value = res.tariffs
  } catch (err: any) {
    error.value = err.message || 'Strompreise konnten nicht geladen werden'
  } finally {
    loadingTariffs.value = false
  }
}

function editTariff(tariff: ElectricityTariff) {
  tariffForm.value = {
    id: tariff.id,
    kind: tariff.kind,
    validFrom: new Date(tariff.validFrom),
    amount: tariff.amount,
    unit: tariff.unit,
    taxStatus: tariff.taxStatus ?? '',
    name: tariff.name ?? '',
    capacityLimitKw: tariff.capacityLimitKw,
  }
  window.setTimeout(() => {
    tariffFormEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function resetTariffForm() {
  tariffForm.value = emptyTariffForm()
}

async function saveTariff() {
  savingTariff.value = true
  error.value = ''
  try {
    const req = {
      kind: tariffForm.value.kind,
      validFrom: toLocalIsoDateTime(tariffForm.value.validFrom).slice(0, 10),
      amount: tariffForm.value.amount,
      unit: tariffForm.value.unit,
      taxStatus: tariffForm.value.taxStatus.trim() || null,
      name: tariffForm.value.name.trim() || null,
      capacityLimitKw: tariffForm.value.capacityLimitKw,
    }
    if (tariffForm.value.id === null) await createElectricityTariff(req)
    else await updateElectricityTariff(tariffForm.value.id, req)
    tariffForm.value = emptyTariffForm()
    await loadTariffs()
    await loadEnergyReport()
  } catch (err: any) {
    error.value = err.message || 'Strompreis konnte nicht gespeichert werden'
  } finally {
    savingTariff.value = false
  }
}

async function handleDeleteTariff(tariff: ElectricityTariff) {
  confirm.require({
    message: `Preisänderung „${tariffKindLabel(tariff.kind)}“ ab ${fmtDate(tariff.validFrom)} löschen?`,
    header: 'Strompreis löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      await deleteElectricityTariff(tariff.id)
      await loadTariffs()
      await loadEnergyReport()
    },
  })
}

async function handleImportPrices() {
  if (pricesAlreadyImported.value) return
  importingPrices.value = true
  error.value = ''
  importMsg.value = ''
  try {
    const res = await importElectricityPrices()
    importMsg.value = res.alreadyImported
      ? `Strompreise waren bereits importiert; ${res.updated} Einträge aktualisiert.`
      : `Strompreise importiert: ${res.created} neu, ${res.updated} aktualisiert.`
    await loadTariffs()
    await loadEnergyReport()
  } catch (err: any) {
    error.value = err.message || 'Strompreise konnten nicht importiert werden'
  } finally {
    importingPrices.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="meters-view">
    <div class="header">
      <h1>Zähler</h1>
      <div class="header-actions">
        <Button
          v-if="showElecImport"
          label="Strom-Historie importieren"
          icon="pi pi-upload"
          severity="secondary"
          :loading="importingElec"
          @click="handleImportElec"
        />
        <Button
          v-if="showWaterImport"
          label="Wasser-Historie importieren"
          icon="pi pi-upload"
          severity="secondary"
          :loading="importingWater"
          @click="handleImportWater"
        />
        <Button
          v-if="canManage"
          label="Strompreise"
          icon="pi pi-euro"
          severity="secondary"
          @click="openTariffs"
        />
        <Button
          v-if="canManage"
          label="Neuer Zähler"
          icon="pi pi-plus"
          @click="openCreate"
        />
      </div>
    </div>

    <Message v-if="importMsg" severity="success" @close="importMsg = ''" closable>{{ importMsg }}</Message>
    <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>

    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Zähler werden geladen…</div>
    <div v-else-if="meters.length === 0" class="info">Noch keine Zähler angelegt.</div>

    <template v-else>
      <section v-if="energyReport && energyReport.meters.length > 0" class="energy-report-card">
        <div class="energy-report-head">
          <div>
            <h2><i class="pi pi-bolt" /> Energie</h2>
            <p>Bezug, Einspeisung, PV-Produktion und daraus abgeleitete Kennzahlen für {{ energyVisibleRangeLabel }}.</p>
          </div>
          <div class="energy-report-actions">
            <Button
              icon="pi pi-question-circle"
              label="Hilfe"
              severity="secondary"
              text
              @click="showEnergyHelp = true"
            />
            <SelectButton
              v-model="energyGranularity"
              :options="energyGranularityOptions"
              option-label="label"
              option-value="value"
              size="small"
              :allow-empty="false"
              @change="loadEnergyReport"
            />
          </div>
        </div>

        <div v-if="loadingEnergyReport" class="info info-compact"><i class="pi pi-spin pi-spinner" /> Energie-Report…</div>
        <template v-else-if="energyBuckets.length > 0">
          <div class="energy-kpis">
            <div class="energy-kpi">
              <span class="figure-label">Ø Bezug</span>
              <strong>{{ fmt(energyAnalysis.avgGridImport, energyReport.decimals) }} {{ energyReport.unit }}</strong>
              <span class="figure-sub">{{ fmtTrend(energyAnalysis.trendGridImport, energyReport.decimals, energyReport.unit) }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Einspeisung</span>
              <strong>{{ fmt(energyAnalysis.avgGridExport, energyReport.decimals) }} {{ energyReport.unit }}</strong>
              <span class="figure-sub">{{ energyAnalysis.count }} abgeschlossene {{ energyGranularity === 'month' ? 'PV-Monate' : 'PV-Jahre' }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Produktion</span>
              <strong>{{ fmt(energyAnalysis.avgProduction, energyReport.decimals) }} {{ energyReport.unit }}</strong>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Eigenverbrauch</span>
              <strong>{{ fmt(energyAnalysis.avgSelfConsumption, energyReport.decimals) }} {{ energyReport.unit }}</strong>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Autarkie</span>
              <strong>{{ fmtPercent(energyAnalysis.avgAutarky) }}</strong>
              <span class="figure-sub">{{ fmtPercentTrend(energyAnalysis.trendAutarky) }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Eigenverbrauchsquote</span>
              <strong>{{ fmtPercent(energyAnalysis.avgSelfConsumptionRate) }}</strong>
              <span class="figure-sub">Trendbasis: {{ energyAnalysis.trendPoints }} Werte</span>
            </div>
          </div>

          <div v-if="hasHeatPumpBreakdown" class="energy-kpis energy-kpis--compact">
            <div class="energy-kpi">
              <span class="figure-label">Ø Verbrauch ohne WP/E-Auto</span>
              <strong>{{ fmt(energyAnalysis.avgConsumptionWithoutHeatPumpAndEv, energyReport.decimals) }} {{ energyReport.unit }}</strong>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Wärmepumpe gesamt</span>
              <strong>{{ fmt(energyAnalysis.avgHeatPumpTotal, energyReport.decimals) }} {{ energyReport.unit }}</strong>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Heizung gesamt</span>
              <strong>{{ fmt(energyAnalysis.avgHeatHeatingTotal, energyReport.decimals) }} {{ energyReport.unit }}</strong>
              <span class="figure-sub">PV-Anteil {{ fmtPercent(energyAnalysis.avgHeatHeatingPvShare) }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø Warmwasser gesamt</span>
              <strong>{{ fmt(energyAnalysis.avgHotWaterTotal, energyReport.decimals) }} {{ energyReport.unit }}</strong>
              <span class="figure-sub">PV-Anteil {{ fmtPercent(energyAnalysis.avgHotWaterPvShare) }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Ø E-Auto/Wallbox gesamt</span>
              <strong>{{ fmt(energyAnalysis.avgEvChargerTotal, energyReport.decimals) }} {{ energyReport.unit }}</strong>
              <span class="figure-sub">PV-Anteil {{ fmtPercent(energyAnalysis.avgEvChargerPvShare) }}</span>
            </div>
          </div>

          <div v-if="energyYtdComparison" class="energy-ytd">
            <span>YTD {{ energyYtdComparison.label }} ggü. Vorjahr:</span>
            <strong>Bezug {{ fmtTrend(energyYtdComparison.gridImportDelta, energyReport.decimals, energyReport.unit).replace(trendLabel(), 'Δ') }}</strong>
            <strong>Autarkie {{ fmtPercentTrend(energyYtdComparison.autarkyDelta).replace(trendLabel(), 'Δ') }}</strong>
          </div>

          <div v-if="energyReport.hasTariffs && energyReport.totals.costs" class="energy-kpis energy-kpis--compact">
            <div class="energy-kpi">
              <span class="figure-label">Stromkosten nach Einspeisung</span>
              <strong>{{ fmtCurrency(energyReport.totals.costs.netElectricityCostEur) }}</strong>
              <span class="figure-sub">{{ energyCostScopeLabel }}</span>
              <span class="figure-sub">Bezug + Grundpreis − Einspeisung</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">PV-Nutzen</span>
              <strong>{{ fmtCurrency(energyReport.totals.costs.pvBenefitEur) }}</strong>
              <span class="figure-sub">{{ energyCostScopeLabel }}</span>
              <span class="figure-sub">Eigenverbrauch + Einspeiseerlös</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Vermiedener Netzbezug</span>
              <strong>{{ fmtCurrency(energyReport.totals.costs.avoidedGridCostEur) }}</strong>
              <span class="figure-sub">{{ energyCostScopeLabel }}</span>
            </div>
            <div class="energy-kpi">
              <span class="figure-label">Einspeiseerlös</span>
              <strong>{{ fmtCurrency(energyReport.totals.costs.feedInRevenueEur) }}</strong>
              <span class="figure-sub">{{ energyCostScopeLabel }}</span>
            </div>
          </div>

          <div class="energy-table-wrap">
            <table class="energy-table">
              <thead>
                <tr>
                  <th>{{ energyGranularity === 'month' ? 'Monat' : 'Jahr' }}</th>
                  <th>Bezug</th>
                  <th>Einspeisung</th>
                  <th>Produktion</th>
                  <th>Eigenverbrauch</th>
                  <th>Gesamtverbrauch</th>
                  <th>Autarkie</th>
                  <th>EV-Quote</th>
                  <th v-if="hasHeatPumpBreakdown">Ohne WP/E-Auto</th>
                  <th v-if="hasHeatPumpBreakdown">WP gesamt</th>
                  <th v-if="hasHeatPumpBreakdown">Heizung gesamt</th>
                  <th v-if="hasHeatPumpBreakdown">Heizung PV</th>
                  <th v-if="hasHeatPumpBreakdown">Warmwasser gesamt</th>
                  <th v-if="hasHeatPumpBreakdown">Warmwasser PV</th>
                  <th v-if="hasHeatPumpBreakdown">E-Auto gesamt</th>
                  <th v-if="hasHeatPumpBreakdown">E-Auto PV</th>
                  <th v-if="energyReport.hasTariffs">Kosten</th>
                  <th v-if="energyReport.hasTariffs">PV-Nutzen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="bucket in energyBuckets" :key="bucket.key">
                  <td>{{ bucket.label }}</td>
                  <td>{{ fmt(bucket.gridImport, energyReport.decimals) }}</td>
                  <td>{{ fmt(bucket.gridExport, energyReport.decimals) }}</td>
                  <td>{{ fmt(bucket.production, energyReport.decimals) }}</td>
                  <td>{{ fmt(bucket.selfConsumption, energyReport.decimals) }}</td>
                  <td>{{ fmt(bucket.totalConsumption, energyReport.decimals) }}</td>
                  <td>{{ fmtPercent(bucket.autarky) }}</td>
                  <td>{{ fmtPercent(bucket.selfConsumptionRate) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmt(bucket.consumptionWithoutHeatPumpAndEv, energyReport.decimals) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmt(bucket.heatPumpTotal, energyReport.decimals) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmt(bucket.heatHeatingTotal, energyReport.decimals) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmtPercent(bucket.heatHeatingPvShare) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmt(bucket.hotWaterTotal, energyReport.decimals) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmtPercent(bucket.hotWaterPvShare) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmt(bucket.evChargerTotal, energyReport.decimals) }}</td>
                  <td v-if="hasHeatPumpBreakdown">{{ fmtPercent(bucket.evChargerPvShare) }}</td>
                  <td v-if="energyReport.hasTariffs">{{ fmtCurrency(bucket.costs?.netElectricityCostEur ?? null) }}</td>
                  <td v-if="energyReport.hasTariffs">{{ fmtCurrency(bucket.costs?.pvBenefitEur ?? null) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else class="info info-compact">
          Noch keine vollständigen PV-Zeiträume mit Bezug, Einspeisung und Produktion vorhanden.
        </div>
      </section>

      <div class="meter-grid">
      <div
        v-for="m in meters"
        :key="m.id"
        class="meter-card"
        @click="openDetail(m)"
      >
        <div class="meter-card-head">
          <i :class="typeIcon(m.type)" />
          <span class="meter-name">{{ m.name }}</span>
          <Tag :value="typeLabel(m.type)" severity="secondary" />
          <Tag v-if="m.role" :value="roleLabel(m.role)" severity="info" />
        </div>
        <div class="meter-meta">
          <span v-if="m.location"><i class="pi pi-map-marker" /> {{ m.location }}</span>
        </div>
        <div class="meter-figures">
          <div class="figure">
            <span class="figure-label">Letzter Stand</span>
            <span class="figure-value">{{ fmt(m.lastReadingValue, m.decimals) }} {{ m.unit }}</span>
            <span class="figure-sub">{{ fmtDateTime(m.lastReadingAt) }}</span>
          </div>
          <div class="figure">
            <span class="figure-label">Gesamt (absolut)</span>
            <span class="figure-value">{{ fmt(m.absoluteTotal, m.decimals) }} {{ m.unit }}</span>
          </div>
        </div>
        <div v-if="canManage" class="meter-actions" @click.stop>
          <Button icon="pi pi-pencil" text rounded severity="secondary" v-tooltip.top="'Bearbeiten'" @click="openEdit(m)" />
          <Button icon="pi pi-trash" text rounded severity="danger" v-tooltip.top="'Löschen'" @click="handleDelete(m)" />
        </div>
      </div>
      </div>
    </template>

    <!-- Create / edit dialog -->
    <Dialog
      v-model:visible="showForm"
      :header="form.id === null ? 'Neuer Zähler' : 'Zähler bearbeiten'"
      modal
      :style="{ width: '32rem', maxWidth: '95vw' }"
    >
      <div class="form-grid">
        <label>Name
          <InputText v-model="form.name" autofocus />
        </label>
        <label>Typ
          <Select v-model="form.type" :options="typeOptions" option-label="label" option-value="value" @change="onTypeChange" />
        </label>
        <label>Report-Rolle
          <Select v-model="form.role" :options="roleOptions" option-label="label" option-value="value" />
        </label>
        <label>Einheit
          <InputText v-model="form.unit" />
        </label>
        <label>Standort
          <InputText v-model="form.location" />
        </label>
        <label>Nachkommastellen
          <InputNumber v-model="form.decimals" :min="0" :max="3" show-buttons />
        </label>
        <label>Sichtbarkeit
          <Select v-model="form.groupId" :options="groupOptions" option-label="label" option-value="value" />
        </label>
        <label class="full">Notizen
          <Textarea v-model="form.notes" rows="2" auto-resize />
        </label>

        <template v-if="form.id === null">
          <div class="section-title full">Erstes Gerät</div>
          <label>Seriennummer
            <InputText v-model="form.deviceSerial" />
          </label>
          <label>Eingebaut am
            <DatePicker v-model="form.deviceInstalledAt" show-time hour-format="24" date-format="dd.mm.yy" />
          </label>
          <label>Startwert
            <InputNumber v-model="form.deviceStartValue" :min-fraction-digits="0" :max-fraction-digits="3" />
          </label>
        </template>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showForm = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="handleSave" />
      </template>
    </Dialog>

    <Dialog
      v-model:visible="showEnergyHelp"
      header="Energie-Kennzahlen"
      modal
      :style="{ width: '44rem', maxWidth: '95vw' }"
    >
      <div class="energy-help">
        <p>
          Die Werte beziehen sich auf die aktuell angezeigten vollständigen PV-Zeiträume:
          <strong>{{ energyVisibleRangeLabel }}</strong>. In der Monatsansicht werden in der
          Tabelle die letzten 12 Monate gezeigt, in der Jahresansicht die Jahre.
        </p>

        <h3>Verbrauch und PV</h3>
        <dl>
          <dt>Bezug</dt>
          <dd>Strom aus dem Netz. Kommt aus dem Zähler mit Rolle „Netzbezug“.</dd>
          <dt>Einspeisung</dt>
          <dd>PV-Strom, der ins Netz eingespeist wurde.</dd>
          <dt>Produktion</dt>
          <dd>Gesamte PV-Produktion.</dd>
          <dt>Eigenverbrauch</dt>
          <dd><code>Produktion − Einspeisung</code></dd>
          <dt>Gesamtverbrauch</dt>
          <dd><code>Bezug + Eigenverbrauch</code></dd>
          <dt>Autarkie</dt>
          <dd><code>1 − Bezug / Gesamtverbrauch</code></dd>
          <dt>Eigenverbrauchsquote</dt>
          <dd><code>Eigenverbrauch / Produktion</code></dd>
        </dl>

        <h3>Wärmepumpe</h3>
        <dl>
          <dt>Verbrauch ohne Wärmepumpe/E-Auto</dt>
          <dd><code>Gesamtverbrauch − Wärmepumpe gesamt − E-Auto/Wallbox gesamt</code></dd>
          <dt>Heizung PV-Anteil</dt>
          <dd><code>Heizung PV-Strom / Heizung gesamt</code></dd>
          <dt>Warmwasser PV-Anteil</dt>
          <dd><code>Warmwasser PV-Strom / Warmwasser gesamt</code></dd>
          <dt>E-Auto/Wallbox PV-Anteil</dt>
          <dd><code>E-Auto/Wallbox PV-Strom / E-Auto/Wallbox gesamt</code></dd>
        </dl>

        <h3>Kosten und PV-Nutzen</h3>
        <dl>
          <dt>Stromkosten nach Einspeisung</dt>
          <dd><code>Netzbezugskosten + Grundpreis − Einspeiseerlös</code></dd>
          <dt>Netzbezugskosten</dt>
          <dd><code>Bezug × zeitgültiger Arbeitspreis</code></dd>
          <dt>Grundpreis</dt>
          <dd>Zeitgültiger monatlicher Grundpreis, anteilig auf den jeweiligen Zeitraum gerechnet.</dd>
          <dt>Einspeiseerlös</dt>
          <dd><code>Einspeisung × zeitgültige Einspeisevergütung</code></dd>
          <dt>Vermiedener Netzbezug</dt>
          <dd><code>Eigenverbrauch × Eigenverbrauchswert</code>. Wenn kein Eigenverbrauchswert gepflegt ist, wird der Arbeitspreis für Netzbezug verwendet.</dd>
          <dt>PV-Nutzen</dt>
          <dd><code>Vermiedener Netzbezug + Einspeiseerlös</code></dd>
        </dl>

        <p class="energy-help-note">
          Preisänderungen werden tagesanteilig berücksichtigt, wenn sie innerhalb eines Monats oder Jahres liegen.
        </p>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="showTariffs"
      header="Strompreise verwalten"
      modal
      :style="{ width: '46rem', maxWidth: '95vw' }"
    >
      <div class="tariff-dialog">
        <div class="tariff-toolbar">
          <p>Preisänderungen werden ab ihrem Gültigkeitsdatum für Kosten und PV-Ersparnis verwendet.</p>
          <Button
            :label="pricesAlreadyImported ? 'Importiert' : 'JSON-Grundlage importieren'"
            icon="pi pi-upload"
            severity="secondary"
            :loading="importingPrices"
            :disabled="pricesAlreadyImported"
            @click="handleImportPrices"
          />
        </div>

        <div ref="tariffFormEl" class="form-grid tariff-form" :class="{ 'tariff-form--editing': tariffForm.id !== null }">
          <div v-if="tariffForm.id !== null" class="tariff-edit-banner full">
            Bearbeite Preisänderung #{{ tariffForm.id }}. Änderungen mit „Speichern“ übernehmen oder mit „Neu“ abbrechen.
          </div>
          <label>Art
            <Select v-model="tariffForm.kind" :options="tariffKindOptions" option-label="label" option-value="value" @change="onTariffKindChange" />
          </label>
          <label>Gültig ab
            <DatePicker v-model="tariffForm.validFrom" date-format="dd.mm.yy" />
          </label>
          <label>Betrag
            <InputNumber v-model="tariffForm.amount" :min="0" :min-fraction-digits="0" :max-fraction-digits="6" />
          </label>
          <label>Einheit
            <Select v-model="tariffForm.unit" :options="tariffUnitOptions" option-label="label" option-value="value" />
          </label>
          <label>Name / Tarif
            <InputText v-model="tariffForm.name" placeholder="optional" />
          </label>
          <label>Grenze kW
            <InputNumber v-model="tariffForm.capacityLimitKw" :min="0" :min-fraction-digits="0" :max-fraction-digits="3" />
          </label>
          <label>Steuerstatus
            <InputText v-model="tariffForm.taxStatus" placeholder="incl. MwSt., excl. MwSt., …" />
          </label>
          <div class="tariff-form-actions">
            <Button :label="tariffForm.id === null ? 'Neu' : 'Abbrechen'" text @click="resetTariffForm" />
            <Button :label="tariffForm.id === null ? 'Speichern' : 'Änderung speichern'" icon="pi pi-check" :loading="savingTariff" @click="saveTariff" />
          </div>
        </div>

        <div v-if="loadingTariffs" class="info info-compact"><i class="pi pi-spin pi-spinner" /> Strompreise…</div>
        <div v-else-if="visibleTariffs.length === 0" class="info info-compact">
          Noch keine Strompreise vorhanden.
        </div>
        <div v-else class="tariff-table-wrap">
          <table class="energy-table tariff-table">
            <thead>
              <tr>
                <th>Gültig ab</th>
                <th>Art</th>
                <th>Name</th>
                <th>Betrag</th>
                <th>Steuer</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tariff in visibleTariffs" :key="tariff.id">
                <td>{{ fmtDate(tariff.validFrom) }}</td>
                <td>{{ tariffKindLabel(tariff.kind) }}</td>
                <td>{{ tariff.name || '–' }}</td>
                <td>{{ fmtTariffAmount(tariff) }}</td>
                <td>{{ tariffTaxStatusLabel(tariff.taxStatus) }}</td>
                <td class="tariff-actions">
                  <Button icon="pi pi-pencil" text rounded severity="secondary" @click.stop="editTariff(tariff)" />
                  <Button icon="pi pi-trash" text rounded severity="danger" @click.stop="handleDeleteTariff(tariff)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.meters-view {
  padding: 1rem;
  max-width: 1100px;
  margin: 0 auto;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.header h1 {
  margin: 0;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.info {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.info-compact {
  padding: 1rem;
}
.energy-report-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1rem;
  background: var(--p-content-background);
  overflow: hidden;
}
.energy-report-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.energy-report-head h2 {
  margin: 0;
  font-size: 1.15rem;
}
.energy-report-head h2 i {
  margin-right: 0.35rem;
}
.energy-report-head p {
  margin: 0.25rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}
.energy-report-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.energy-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.energy-kpis--compact {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}
.energy-kpi {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 0.75rem;
  min-width: 0;
}
.energy-kpi strong {
  display: block;
  margin-top: 0.15rem;
  overflow-wrap: break-word;
}
.energy-kpi .figure-sub {
  display: block;
  margin-top: 0.2rem;
  line-height: 1.25;
}
.energy-ytd {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  margin: -0.25rem 0 1rem;
  padding: 0.65rem 0.75rem;
  border-radius: 8px;
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.energy-ytd strong {
  color: var(--p-text-color);
}
.energy-table-wrap {
  max-width: 100%;
  overflow-x: auto;
}
.energy-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.energy-table th,
.energy-table td {
  padding: 0.45rem 0.5rem;
  border-top: 1px solid var(--p-content-border-color);
  text-align: right;
  white-space: nowrap;
}
.energy-table th:first-child,
.energy-table td:first-child {
  text-align: left;
}
.energy-help {
  color: var(--p-text-color);
  line-height: 1.45;
}
.energy-help p {
  margin: 0 0 1rem;
}
.energy-help h3 {
  margin: 1rem 0 0.5rem;
  font-size: 1rem;
}
.energy-help dl {
  display: grid;
  grid-template-columns: minmax(8rem, 0.8fr) minmax(0, 2fr);
  gap: 0.45rem 1rem;
  margin: 0;
}
.energy-help dt {
  font-weight: 600;
}
.energy-help dd {
  margin: 0;
  color: var(--p-text-muted-color);
}
.energy-help code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
  color: var(--p-text-color);
}
.energy-help-note {
  margin-top: 1rem;
  color: var(--p-text-muted-color);
}
@media (max-width: 560px) {
  .energy-report-actions {
    justify-content: flex-start;
  }
  .energy-help dl {
    grid-template-columns: 1fr;
    gap: 0.2rem;
  }
  .energy-help dd {
    margin-bottom: 0.5rem;
  }
}
.meter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.meter-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1rem;
  background: var(--p-content-background);
  cursor: pointer;
  transition: background 0.15s;
}
.meter-card:hover {
  background: var(--p-content-hover-background);
}
.meter-card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.meter-name {
  font-weight: 600;
  flex: 1;
}
.meter-meta {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  min-height: 1.2rem;
  margin-bottom: 0.75rem;
}
.meter-meta i {
  margin-right: 0.25rem;
}
.meter-figures {
  display: flex;
  gap: 1rem;
}
.figure {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.figure-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.figure-value {
  font-weight: 600;
  font-size: 1.05rem;
}
.figure-sub {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.meter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
  margin-top: 0.5rem;
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
.section-title {
  font-weight: 600;
  color: var(--p-text-color);
  margin-top: 0.5rem;
}
.tariff-dialog {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.tariff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.tariff-toolbar p {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  max-width: 32rem;
}
.tariff-form {
  padding: 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}
.tariff-form--editing {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--p-primary-color) 45%, transparent);
}
.tariff-edit-banner {
  padding: 0.55rem 0.65rem;
  border-radius: 6px;
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
  font-size: 0.85rem;
}
.tariff-form-actions {
  display: flex;
  align-items: end;
  justify-content: flex-end;
  gap: 0.5rem;
}
.tariff-table-wrap {
  max-width: 100%;
  overflow-x: auto;
}
.tariff-table td,
.tariff-table th {
  text-align: left;
}
.tariff-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
}
</style>
